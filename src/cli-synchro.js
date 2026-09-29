// Synchro Sage -> Shopify, à planifier toutes les 15 min : npm run synchro -- [--catalogue] [--simulation]
// 1. catalogue : familles, variantes, prix — une fois par jour (CATALOGUE_INTERVALLE_HEURES), ou avec --catalogue
// 2. stocks    : à chaque passage, corrige les stocks qui diffèrent de Sage
// 3. commandes : Shopify -> Sage (COMMANDES_MODE, désactivé par défaut)
// Chaque étape est lancée même si la précédente a rencontré des erreurs.
// Tout est écrit dans logs/synchro-AAAA-MM-JJ.log ; journaux et rapports de plus de JOURS_CONSERVATION jours sont supprimés.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gererAlerte } from './alertes.js';
import { libererVerrou, prendreVerrou, synchroEnCours } from './suivi.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const JOURS_CONSERVATION = Number(process.env.JOURS_CONSERVATION) || 30;
// Catalogue et prix : une fois par jour (note du 24/09). Les stocks passent à chaque synchro.
const CATALOGUE_INTERVALLE_HEURES = Number(process.env.CATALOGUE_INTERVALLE_HEURES) || 24;

// Lancé par une tâche planifiée, le dossier courant peut être n'importe où : on se place à la racine du connecteur.
process.chdir(RACINE);

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`
Usage : npm run synchro -- [options]

  (sans option)     stocks, et catalogue (familles, variantes, prix) s'il n'a pas tourné depuis ${CATALOGUE_INTERVALLE_HEURES} h
  --catalogue       passe aussi le catalogue maintenant
  --simulation      n'envoie rien à Shopify
  --forcer-prix     applique les variations de prix de plus de 50 %
  --forcer-stocks   applique une mise à zéro massive des stocks

Journal : logs/synchro-AAAA-MM-JJ.log (conservé ${JOURS_CONSERVATION} jours, variable JOURS_CONSERVATION)
`);
  process.exit(0);
}

const maintenant = () => new Date().toLocaleString('sv-SE').slice(0, 19); // AAAA-MM-JJ HH:MM:SS, heure locale
await mkdir('logs', { recursive: true });
const fichierJournal = path.join('logs', `synchro-${maintenant().slice(0, 10)}.log`);
const journal = createWriteStream(fichierJournal, { flags: 'a' });
const lignesErreur = []; // pour l'e-mail d'alerte

function ecrire(ligne, erreur = false) {
  (erreur ? process.stderr : process.stdout).write(ligne + '\n');
  journal.write(`${maintenant()} ${erreur ? 'ERR ' : ''}${ligne}\n`);
  if (erreur) lignesErreur.push(ligne);
}

function lancer(script, argsEtape) {
  return new Promise((resolve) => {
    const enfant = spawn(process.execPath, [path.join('src', script), ...argsEtape], { stdio: ['ignore', 'pipe', 'pipe'] });
    createInterface({ input: enfant.stdout }).on('line', (l) => ecrire(l));
    createInterface({ input: enfant.stderr }).on('line', (l) => ecrire(l, true));
    enfant.on('error', (err) => {
      ecrire(`Impossible de lancer ${script} : ${err.message}`, true);
      resolve(1);
    });
    enfant.on('close', resolve);
  });
}

async function nettoyer(dossier, limite) {
  let supprimes = 0;
  for (const nom of await readdir(dossier).catch(() => [])) {
    const fichier = path.join(dossier, nom);
    const infos = await stat(fichier).catch(() => null);
    if (infos?.isFile() && infos.mtimeMs < limite) {
      await unlink(fichier).catch(() => {});
      supprimes++;
    }
  }
  return supprimes;
}

const etatCatalogue = JSON.parse(await readFile(path.join('etat', 'catalogue.json'), 'utf8').catch(() => '{}'));
const catalogueDu = args.includes('--catalogue') || !etatCatalogue.dernier ||
  Date.now() - new Date(etatCatalogue.dernier).getTime() >= CATALOGUE_INTERVALLE_HEURES * 3600 * 1000;
const etapes = [
  ...(catalogueDu
    ? [{ titre: 'Catalogue', script: 'cli-catalogue.js', args: args.filter((a) => ['--simulation', '--forcer-prix'].includes(a)) }]
    : []),
  { titre: 'Stocks', script: 'cli-stocks.js', args: args.filter((a) => ['--simulation', '--forcer-stocks'].includes(a)) },
  // En dernier : une erreur sur les commandes ne peut ni empêcher ni retarder la mise à jour du catalogue et des stocks.
  // Chaque étape est un processus séparé : un plantage de l'une n'arrête pas les autres.
  { titre: 'Commandes', script: 'cli-commandes-sage.js', args: args.filter((a) => a === '--simulation') },
];

// Une seule synchro à la fois. Si le processus plante, le verrou est ignoré (processus mort ou plus de 30 min).
if (!(await prendreVerrou())) {
  const autre = await synchroEnCours();
  ecrire(`Synchro déjà en cours (lancée le ${autre ? new Date(autre.depuis).toLocaleString('fr-FR') : '?'}) : ce lancement est ignoré.`);
  journal.end(() => {
    process.exitCode = 0;
  });
} else {
  await synchroniser();
}

async function synchroniser() {
  const debut = Date.now();
  ecrire(`=== Synchro Sage -> Shopify${args.length ? ' ' + args.join(' ') : ''} ===`);
  const resultats = [];
  for (const [i, { titre, script, args: argsEtape }] of etapes.entries()) {
    ecrire(`--- ${i + 1}/${etapes.length} ${titre} ---`);
    resultats.push({ titre, ok: (await lancer(script, argsEtape)) === 0 });
  }

  const limite = Date.now() - JOURS_CONSERVATION * 24 * 3600 * 1000;
  const supprimes =
    (await nettoyer('logs', limite)) + (await nettoyer('sortie', limite)) + (await nettoyer(path.join('sortie', 'emails'), limite));
  if (supprimes) ecrire(`Nettoyage : ${supprimes} fichier(s) de plus de ${JOURS_CONSERVATION} jours supprimé(s)`);

  const ok = resultats.every((r) => r.ok);
  // En simulation, rien n'est envoyé à Shopify : pas d'alerte non plus.
  if (!args.includes('--simulation')) {
    try {
      const compteRendu = await gererAlerte({ ok, lignesErreur, fichierJournal });
      if (compteRendu) ecrire(`Alerte : ${compteRendu}`);
    } catch (err) {
      ecrire(`Alerte : échec de l'envoi de l'e-mail (${err.message})`, true);
    }
  }
  ecrire(
    `=== ${ok ? 'OK' : 'ÉCHEC'} en ${((Date.now() - debut) / 1000).toFixed(1)} s : ` +
      `${resultats.map((r) => `${r.titre} ${r.ok ? '✓' : '✗'}`).join('   ')} ===`,
    !ok,
  );
  await libererVerrou();
  journal.end(() => {
    process.exitCode = ok ? 0 : 1;
  });
}
