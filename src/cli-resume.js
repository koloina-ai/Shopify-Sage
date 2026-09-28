// Résumé quotidien par e-mail : npm run resume -- [--heures 24] [--afficher]
// État des synchros, changements envoyés à Shopify, et liste des articles bloqués dans Sage (pièce jointe CSV).
// --afficher : affiche le résumé dans le terminal sans envoyer d'e-mail.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { articlesBloques, connecterSage } from './sage.js';
import { emplacementParDefaut } from './produits.js';
import { lireStocksShopify } from './stocks.js';
import { echapper, envoyerEmail, gabaritHtml } from './email.js';
import { csvArticles, lireChangements, lirePassages } from './suivi.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const { values: args } = parseArgs({
  options: {
    heures: { type: 'string', default: '24' },
    afficher: { type: 'boolean', default: false },
  },
});
const depuis = Date.now() - Number(args.heures) * 3600 * 1000;
const MAX_LIGNES = 15; // au-delà, la liste complète est dans la pièce jointe

let pool;
try {
  const etatProduits = JSON.parse(await readFile('etat/synchro-produits.json', 'utf8').catch(() => '{}'));
  const perimetre = etatProduits.perimetre ?? 'poc';

  const [passages, changements] = await Promise.all([lirePassages(depuis), lireChangements(depuis)]);
  pool = await connecterSage();
  const bloques = await articlesBloques(pool, perimetre);

  let enLigne = null;
  try {
    const client = creerClient(configShopify());
    const produits = await lireStocksShopify(client, await emplacementParDefaut(client));
    enLigne = produits.filter((p) => p.proprietaire && p.statut === 'ACTIVE').length;
  } catch {
    // Shopify injoignable : le résumé part quand même, sans ce chiffre
  }

  const echecs = passages.filter((p) => !p.ok);
  const dernierEchec = echecs.at(-1);
  const toutVaBien = passages.length > 0 && echecs.length === 0;
  const parRaison = Object.entries(Object.groupBy(bloques, (b) => b.raison)).sort((a, b) => b[1].length - a[1].length);
  const periode = `${args.heures} dernières heures`;
  const jour = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  const etatTexte =
    passages.length === 0
      ? '⚠️ Aucune synchronisation n\'a tourné : la tâche planifiée est peut-être arrêtée.'
      : echecs.length === 0
        ? `✅ Tout fonctionne : ${passages.length} synchronisations réussies.`
        : `⚠️ ${echecs.length} synchronisation(s) en échec sur ${passages.length} (dernier échec : ${dernierEchec.date.toLocaleString('fr-FR', { timeStyle: 'short', dateStyle: 'short' })}).`;

  const lignesChangements = [
    `${changements.crees} produit(s) ajouté(s) sur la boutique`,
    `${changements.misAJour} produit(s) mis à jour (prix, nom…)`,
    `${changements.stocks} stock(s) corrigé(s)`,
    `${changements.retires.length} produit(s) retiré(s) de la vente`,
    `${changements.reactives.length} produit(s) remis en vente`,
    ...(changements.prixBloques.length ? [`${changements.prixBloques.length} prix NON appliqué(s), variation trop forte à vérifier dans Sage : ` +
      changements.prixBloques.slice(0, MAX_LIGNES).map((p) => `${p.ref} ${p.ancien} → ${p.nouveau} €`).join(', ')] : []),
    ...(changements.stocksBloques ? [`${changements.stocksBloques} mise(s) à zéro de stock bloquée(s) par sécurité`] : []),
    `${changements.commandes} commande(s) transmise(s) à Sage` +
      (changements.commandesAVerifier.length ? `, dont ${changements.commandesAVerifier.length} à vérifier : ` +
        changements.commandesAVerifier.slice(0, MAX_LIGNES).map((v) => `${v.commande} (${v.raison})`).join(', ') : ''),
  ];

  const texte = [
    `Résumé du connecteur Sage -> Shopify — ${jour} (${periode})`,
    '',
    etatTexte,
    enLigne !== null ? `Produits en vente sur la boutique : ${enLigne}` : '',
    '',
    'Changements envoyés à Shopify :',
    ...lignesChangements.map((l) => `  - ${l}`),
    ...changements.retires.slice(0, MAX_LIGNES).map((r) => `      retiré : ${r.ref} (${r.raison})`),
    '',
    `Articles « publiés » dans Sage mais pas en ligne : ${bloques.length}`,
    ...parRaison.map(([raison, liste]) => `  - ${liste.length} : ${raison} → à corriger dans ${liste[0].aCorriger}`),
    bloques.length ? 'Liste complète en pièce jointe (à ouvrir avec Excel).' : '',
  ].join('\n');

  const html = gabaritHtml(
    `Résumé du ${jour}`,
    toutVaBien ? '#2e7d32' : '#ef6c00',
    `<p style="font-size:16px">${echapper(etatTexte)}</p>
     ${enLigne !== null ? `<p>Produits en vente sur la boutique : <b>${enLigne}</b></p>` : ''}
     <h3>Changements envoyés à Shopify (${echapper(periode)})</h3>
     <ul>${lignesChangements.map((l) => `<li>${echapper(l)}</li>`).join('')}</ul>
     ${changements.retires.length ? `<p>Produits retirés :</p><ul>${changements.retires.slice(0, MAX_LIGNES).map((r) => `<li>${echapper(r.ref)} — ${echapper(r.raison)}</li>`).join('')}</ul>` : ''}
     <h3>Articles « publiés » dans Sage mais pas en ligne : ${bloques.length}</h3>
     ${parRaison.length ? `<table cellpadding="6" style="border-collapse:collapse">
        <tr style="background:#f0f0f0"><th align="right">Nombre</th><th align="left">Raison</th><th align="left">À corriger dans Sage</th></tr>
        ${parRaison.map(([raison, liste]) => `<tr><td align="right"><b>${liste.length}</b></td><td>${echapper(raison)}</td><td>${echapper(liste[0].aCorriger)}</td></tr>`).join('')}
      </table>
      <p>La liste complète des articles est en pièce jointe (à ouvrir avec Excel).</p>` : '<p>Aucun : tous les articles publiés sont en ligne.</p>'}
     ${dernierEchec ? `<h3>Dernier échec</h3><pre style="background:#f5f5f5;padding:8px;font-size:12px;white-space:pre-wrap">${echapper(dernierEchec.erreurs.slice(-5).join('\n'))}</pre>` : ''}`,
  );

  if (args.afficher) {
    console.log(texte);
  } else {
    const compteRendu = await envoyerEmail({
      sujet: `${toutVaBien ? '📋' : '⚠️'} Connecteur Sage-Shopify : résumé du ${new Date().toLocaleDateString('fr-FR')}`,
      texte,
      html,
      piecesJointes: bloques.length
        ? [{
            filename: `articles-a-corriger-${new Date().toISOString().slice(0, 10)}.csv`,
            content: Buffer.from(csvArticles(bloques), 'utf8'),
            contentType: 'text/csv; charset=utf-8',
          }]
        : [],
    });
    console.log(`Résumé : ${compteRendu}`);
  }
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
