// Lecture de l'activité du connecteur (journaux, rapports, verrou) : partagé par le résumé e-mail et la page de suivi.
// Chemins relatifs à la racine du connecteur (les points d'entrée font process.chdir).

import { readdir, readFile, stat, unlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const FICHIER_VERROU = path.join('etat', 'synchro.lock');
const VERROU_EXPIRE_MS = 30 * 60 * 1000; // une synchro bloquée depuis plus longtemps est considérée morte

/**
 * Passages de synchro trouvés dans les journaux depuis une date.
 * @returns {{ debut: Date, date: Date, ok: boolean, simulation: boolean, erreurs: string[],
 *             lignes: { heure: string, texte: string, erreur: boolean }[] }[]}  du plus ancien au plus récent
 */
export async function lirePassages(depuis, { avecSimulations = false } = {}) {
  const passages = [];
  const fichiers = (await readdir('logs').catch(() => [])).filter((f) => /^synchro-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  for (const f of fichiers) {
    // Un fichier par jour : inutile de lire ceux d'avant la période
    if (new Date(`${f.slice(8, 18)}T23:59:59`).getTime() < depuis) continue;
    let courant = null;
    for (const ligne of (await readFile(path.join('logs', f), 'utf8')).split(/\r?\n/)) {
      const m = ligne.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (ERR )?(.*)$/);
      if (!m) continue;
      const [, horodatage, err, texte] = m;
      const date = new Date(horodatage.replace(' ', 'T'));
      if (texte.startsWith('=== Synchro')) {
        courant = { debut: date, simulation: texte.includes('--simulation'), lignes: [], erreurs: [] };
        continue;
      }
      if (!courant) continue;
      if (/^=== (OK|ÉCHEC) en/.test(texte)) {
        if ((avecSimulations || !courant.simulation) && date.getTime() >= depuis) {
          passages.push({ ...courant, date, ok: texte.startsWith('=== OK'), resultat: texte.replace(/^=== | ===$/g, '') });
        }
        courant = null;
      } else {
        courant.lignes.push({ heure: horodatage.slice(11), texte, erreur: Boolean(err) });
        if (err) courant.erreurs.push(texte);
      }
    }
  }
  return passages;
}

/** Cumul des rapports de synchro (sortie/*.json) depuis une date. */
export async function lireChangements(depuis) {
  const total = { crees: 0, misAJour: 0, reactives: [], retires: [], prixBloques: [], stocks: 0, stocksBloques: 0, commandes: 0, commandesAVerifier: [], erreurs: 0 };
  for (const f of await readdir('sortie').catch(() => [])) {
    if (!/^synchro-(produits|stocks|commandes)-.*\.json$/.test(f)) continue;
    const fichier = path.join('sortie', f);
    if ((await stat(fichier)).mtimeMs < depuis) continue;
    const r = JSON.parse(await readFile(fichier, 'utf8'));
    if (f.startsWith('synchro-produits')) {
      total.crees += r.crees?.length ?? 0;
      total.misAJour += r.misAJour?.length ?? 0;
      total.reactives.push(...(r.reactives ?? []));
      total.retires.push(...(r.retires ?? []));
      total.prixBloques.push(...(r.prixBloques ?? []));
    } else if (f.startsWith('synchro-commandes')) {
      const nouvelles = (r.transmises ?? []).filter((t) => !t.deja);
      total.commandes += nouvelles.length;
      total.commandesAVerifier.push(...nouvelles.filter((t) => t.statut === 'A_VERIFIER').map((t) => ({ commande: t.commande, raison: t.messages.join(' ; ') })));
    } else {
      total.stocks += r.erreurs?.length ? 0 : (r.ecarts?.length ?? 0);
      total.stocksBloques += r.misesAZeroBloquees?.length ?? 0;
    }
    total.erreurs += r.erreurs?.length ?? 0;
  }
  return total;
}

// Une cellule qui commence par = + - @ (ou tabulation / retour) serait exécutée comme formule par Excel :
// on la préfixe d'une apostrophe, qu'Excel n'affiche pas.
const celluleCsv = (v) => {
  const texte = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(texte) ? `'${texte}` : texte).replaceAll('"', '""')}"`;
};

/** Articles bloqués -> CSV pour Excel (séparateur « ; », BOM pour les accents). */
export const csvArticles = (lignes) =>
  '﻿' +
  ['Référence;Désignation;Raison;À corriger dans Sage', ...lignes.map((b) => [b.ref, b.designation, b.raison, b.aCorriger].map(celluleCsv).join(';'))].join('\r\n');

// ---------- Verrou : une seule synchro à la fois (tâche planifiée, bouton de la page, lancement manuel) ----------

function processusVivant(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // existe mais appartient à un autre utilisateur
  }
}

/** @returns {Promise<{ pid: number, depuis: string } | null>} la synchro en cours, s'il y en a une */
export async function synchroEnCours() {
  const contenu = await readFile(FICHIER_VERROU, 'utf8').catch(() => null);
  if (!contenu) return null;
  const verrou = JSON.parse(contenu);
  const perime = Date.now() - new Date(verrou.depuis).getTime() > VERROU_EXPIRE_MS || !processusVivant(verrou.pid);
  return perime ? null : verrou;
}

/** @returns {Promise<boolean>} false si une autre synchro tourne déjà */
export async function prendreVerrou() {
  await mkdir('etat', { recursive: true });
  const contenu = JSON.stringify({ pid: process.pid, depuis: new Date().toISOString() });
  for (let essai = 0; essai < 2; essai++) {
    try {
      await writeFile(FICHIER_VERROU, contenu, { flag: 'wx' }); // création atomique : échoue si le fichier existe
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await synchroEnCours()) return false;
      await unlink(FICHIER_VERROU).catch(() => {}); // verrou périmé (synchro plantée) : on le remplace
    }
  }
  return false;
}

export async function libererVerrou() {
  const contenu = await readFile(FICHIER_VERROU, 'utf8').catch(() => null);
  if (contenu && JSON.parse(contenu).pid === process.pid) await unlink(FICHIER_VERROU).catch(() => {});
}
