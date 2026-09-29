// Alertes e-mail de la synchro : un e-mail à la première panne, un rappel toutes les RAPPEL_HEURES heures
// tant qu'elle dure, et un e-mail quand tout est rétabli. Rien quand tout va bien.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { echapper, envoyerEmail, gabaritHtml } from './email.js';

const FICHIER_ETAT = 'etat/alertes.json';
const RAPPEL_HEURES = Number(process.env.RAPPEL_HEURES) || 4;

// Erreurs techniques -> explication et action, pour un lecteur non technique.
const DIAGNOSTICS = [
  {
    motif: /Retrait annulé/i,
    probleme: 'Trop de produits auraient été retirés de la boutique d\'un coup. Par sécurité, aucun produit n\'a été retiré.',
    action: 'Vérifier dans Sage si des articles ont été mis en sommeil ou décochés « publié » par erreur. Si c\'est voulu, demander à l\'équipe technique de valider le retrait.',
  },
  {
    motif: /Mise à zéro bloquée/i,
    probleme: "Beaucoup de produits seraient passés d'un coup à 0 en stock. Par sécurité, ces stocks n'ont pas été modifiés sur la boutique (les autres ont été mis à jour).",
    action: "Vérifier les stocks dans Sage (import de stock incomplet ?). Si c'est voulu, demander à l'équipe technique de valider la mise à zéro.",
  },
  {
    motif: /SQL|ODBC|Login failed|server was not found|Named Pipes|Cannot open database|ConnectionError/i,
    probleme: 'Le connecteur n\'arrive pas à lire Sage (serveur SQL inaccessible).',
    action: 'Vérifier que le serveur Sage est allumé et accessible. Si le problème continue, contacter M2I.',
  },
  {
    motif: /HTTP 401|HTTP 403|access token|Invalid API key/i,
    probleme: 'Shopify refuse l\'accès au connecteur (clé d\'accès invalide ou révoquée).',
    action: 'Contacter l\'équipe technique pour renouveler la clé d\'accès Shopify.',
  },
  {
    motif: /Shopify injoignable|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|HTTP 5\d\d/i,
    probleme: 'Shopify est injoignable (coupure Internet ou incident chez Shopify).',
    action: 'En général, cela se rétablit tout seul au passage suivant. Si l\'alerte persiste plusieurs heures, vérifier la connexion Internet du serveur.',
  },
  {
    motif: /Adresse de boutique invalide|SHOPIFY_STORE_URL manquant|Authentification manquante/i,
    probleme: 'La configuration Shopify du connecteur est incorrecte.',
    action: 'Contacter l\'équipe technique (fichier .env du serveur).',
  },
  {
    motif: /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i,
    probleme: 'Le connecteur est incomplètement installé sur ce poste.',
    action: 'Contacter l\'équipe technique (lancer npm install dans le dossier du connecteur).',
  },
  {
    motif: /Périmètre inconnu|Aucune synchro précédente/i,
    probleme: 'Le connecteur n\'a pas été initialisé.',
    action: 'Contacter l\'équipe technique (première synchro à lancer à la main).',
  },
];
const DIAGNOSTIC_INCONNU = {
  probleme: 'Erreur inattendue pendant la synchronisation.',
  action: 'Transmettre cet e-mail à l\'équipe technique.',
};

export function diagnostiquer(lignesErreur) {
  const trouves = DIAGNOSTICS.filter((d) => lignesErreur.some((l) => d.motif.test(l)));
  return trouves.length ? trouves : [DIAGNOSTIC_INCONNU];
}

const lireEtat = async () => JSON.parse(await readFile(FICHIER_ETAT, 'utf8').catch(() => '{}'));
async function ecrireEtat(etat) {
  await mkdir('etat', { recursive: true });
  await writeFile(FICHIER_ETAT, JSON.stringify(etat, null, 2));
}

const heure = (d) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

function duree(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * À appeler à la fin de chaque synchro.
 * @param {{ ok: boolean, lignesErreur: string[], fichierJournal: string }} resultat
 * @returns {Promise<string|null>} ce qui a été fait (pour le journal), null si rien
 */
export async function gererAlerte({ ok, lignesErreur, fichierJournal }) {
  const etat = await lireEtat();
  const maintenant = Date.now();

  if (ok) {
    if (!etat.enPanne) return null;
    await ecrireEtat({ enPanne: false });
    const texte =
      `La synchronisation Sage -> Shopify fonctionne de nouveau depuis ${heure(maintenant)}.\n` +
      `Durée de l'interruption : ${duree(maintenant - etat.depuis)}.\n` +
      `Les changements faits dans Sage pendant ce temps ont été rattrapés automatiquement.`;
    const html = gabaritHtml(
      'Synchronisation rétablie',
      '#2e7d32',
      `<p>La synchronisation Sage → Shopify fonctionne de nouveau depuis <b>${heure(maintenant)}</b>.</p>
       <p>Durée de l'interruption : <b>${duree(maintenant - etat.depuis)}</b>.</p>
       <p>Les changements faits dans Sage pendant ce temps ont été rattrapés automatiquement. Rien à faire.</p>`,
    );
    return envoyerEmail({ sujet: '✅ Connecteur Sage-Shopify : synchronisation rétablie', texte, html });
  }

  const premiereFois = !etat.enPanne;
  const rappelDu = !premiereFois && maintenant - etat.dernierEnvoi >= RAPPEL_HEURES * 3600 * 1000;
  const nouvelEtat = { enPanne: true, depuis: etat.depuis ?? maintenant, dernierEnvoi: etat.dernierEnvoi ?? 0 };
  if (!premiereFois && !rappelDu) {
    await ecrireEtat(nouvelEtat);
    return `panne en cours depuis ${heure(nouvelEtat.depuis)} : prochain rappel e-mail dans moins de ${RAPPEL_HEURES} h`;
  }

  const diagnostics = diagnostiquer(lignesErreur);
  const details = lignesErreur.slice(-10);
  const titre = premiereFois ? 'La synchronisation a échoué' : `La synchronisation échoue toujours (depuis ${duree(maintenant - nouvelEtat.depuis)})`;
  const texte = [
    `${titre} — ${heure(maintenant)}`,
    '',
    ...diagnostics.flatMap((d) => [`Problème : ${d.probleme}`, `Que faire : ${d.action}`, '']),
    `Tant que le problème dure, la boutique Shopify n'est plus mise à jour (prix, stocks, produits).`,
    `Un rappel sera envoyé toutes les ${RAPPEL_HEURES} h, et un e-mail quand ce sera rétabli.`,
    '',
    'Détails techniques :',
    ...details,
    '',
    `Journal complet sur le serveur : connecteur/${fichierJournal.replaceAll('\\', '/')}`,
  ].join('\n');
  const html = gabaritHtml(
    titre,
    '#c62828',
    `<p style="color:#666">${heure(maintenant)}</p>
     ${diagnostics.map((d) => `<p><b>Problème :</b> ${echapper(d.probleme)}<br><b>Que faire :</b> ${echapper(d.action)}</p>`).join('')}
     <p>Tant que le problème dure, la boutique Shopify n'est plus mise à jour (prix, stocks, produits).
        Un rappel sera envoyé toutes les ${RAPPEL_HEURES} h, et un e-mail quand ce sera rétabli.</p>
     <details><summary style="color:#666">Détails techniques</summary>
       <pre style="background:#f5f5f5;padding:8px;font-size:12px;white-space:pre-wrap">${echapper(details.join('\n'))}</pre>
       <p style="color:#666">Journal complet sur le serveur : <code>connecteur/${echapper(fichierJournal.replaceAll('\\', '/'))}</code></p>
     </details>`,
  );

  const compteRendu = await envoyerEmail({ sujet: `❌ Connecteur Sage-Shopify : ${titre.toLowerCase()}`, texte, html });
  await ecrireEtat({ ...nouvelEtat, dernierEnvoi: maintenant });
  return compteRendu;
}
