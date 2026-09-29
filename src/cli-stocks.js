// Synchro des stocks Sage -> Shopify : npm run stocks -- [--simulation] [--forcer-stocks]
// Pour chaque variante des familles gérées par le connecteur (SKU = référence Sage) : compare le disponible Sage
// (dépôts STOCK_DEPOTS) au disponible Shopify, et n'envoie que les différences.
// Article en sommeil dans Sage : stock 0 (plus vendable, mais la variante reste visible).
// Article sans ligne de stock dans Sage : stock Shopify non modifié (jamais mis à 0 par défaut d'information).

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { articlesExistants, connecterSage, depotsStock, lireStocks } from './sage.js';
import { emplacementParDefaut, lireFamillesShopify, variantesGerees } from './familles.js';
import { envoyerStocks, quantiteStock } from './stocks.js';
import { misesAZeroSuspectes } from './regles.js';

const { values: args } = parseArgs({
  options: {
    simulation: { type: 'boolean', default: false },
    'forcer-stocks': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(`
Usage : npm run stocks -- [--simulation] [--forcer-stocks]

  --simulation     affiche les écarts sans rien envoyer à Shopify
  --forcer-stocks  applique aussi une mise à zéro massive (bloquée par défaut : anomalie probable côté Sage)
`);
  process.exit(0);
}

// Fin anticipée sans process.exit() : avec le pilote SQL Windows (msnodesqlv8), process.exit() pendant qu'une
// connexion est ouverte fait planter Node à la fermeture et fausse le code retour (fausses alertes).
const terminer = (code = 0) => {
  throw Object.assign(new Error('fin'), { finAnticipee: code });
};

let pool;
try {
  const client = creerClient(configShopify());
  const locationId = await emplacementParDefaut(client);
  const familles = await lireFamillesShopify(client, locationId);
  const variantes = variantesGerees(familles).filter((v) => v.sku);
  const protegees = familles.filter((f) => !f.proprietaire || f.ignore).reduce((n, f) => n + f.variantes.length, 0);

  pool = await connecterSage();
  const [stocksSage, articles] = await Promise.all([lireStocks(pool), articlesExistants(pool, variantes.map((v) => v.sku))]);

  let ecarts = [];
  const sansStock = [];
  const inconnues = [];
  for (const v of variantes) {
    const article = articles.get(v.sku);
    if (!article) {
      inconnues.push(v.sku); // SKU absent de Sage : on ne touche pas au stock
      continue;
    }
    let sage;
    if (article.AR_Sommeil !== 0) sage = 0; // en sommeil : plus vendable
    else if (stocksSage.has(v.sku)) sage = quantiteStock(stocksSage.get(v.sku));
    else {
      sansStock.push(v.sku);
      continue;
    }
    if (!v.suivi || v.disponible !== sage) ecarts.push({ ...v, sage });
  }

  console.log(`${variantes.length} variante(s) gérée(s) — ${ecarts.length} stock(s) différent(s) de Sage (dépôt(s) ${depotsStock().join(' + ')})`);
  if (protegees) console.log(`  ${protegees} variante(s) protégée(s) non modifiée(s) (sage-ignorer ou non créées par le connecteur)`);
  if (sansStock.length) console.log(`  ${sansStock.length} sans ligne de stock dans Sage (non modifiées)`);
  if (inconnues.length) console.log(`  ${inconnues.length} SKU inconnu(s) dans Sage (non modifiés) : ${inconnues.slice(0, 10).join(', ')}`);

  // Garde-fou : trop de variantes qui tombent à 0 d'un coup = anomalie probable (table de stock vide, mauvaise base…)
  let bloques = [];
  if (!args['forcer-stocks']) {
    bloques = misesAZeroSuspectes(ecarts, variantes.filter((v) => v.suivi).length);
    if (bloques.length) {
      const refs = new Set(bloques.map((b) => b.sku));
      ecarts = ecarts.filter((e) => !refs.has(e.sku));
      console.warn(
        `⚠ Mise à zéro bloquée : ${bloques.length} variantes passeraient d'un coup à 0 en stock (anomalie probable côté Sage). ` +
          `Les autres écarts sont appliqués. Vérifier Sage, puis relancer avec --forcer-stocks si c'est voulu.`,
      );
    }
  }
  if (ecarts.length) console.table(ecarts.map((e) => ({ famille: e.famille, sku: e.sku, shopify: e.disponible, sage: e.sage })));
  if (args.simulation || ecarts.length === 0) terminer(bloques.length ? 1 : 0);

  // Suivi de stock à activer d'abord pour les variantes qui ne l'ont pas : inventorySetQuantities l'exige.
  for (const e of ecarts.filter((x) => !x.suivi)) {
    const { data } = await client.requete(
      `mutation($id: ID!) { inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { message } } }`,
      { id: e.inventoryItemId },
    );
    if (data.inventoryItemUpdate.userErrors.length) throw new Error(data.inventoryItemUpdate.userErrors[0].message);
  }

  const erreurs = await envoyerStocks(
    client,
    ecarts.map((e) => ({ inventoryItemId: e.inventoryItemId, locationId, quantity: e.sage, changeFromQuantity: e.disponible })),
    'sage://sodico/synchro-stocks',
  );

  console.log(`Mis à jour : ${erreurs.length ? 0 : ecarts.length}   Erreurs : ${erreurs.length}`);
  for (const e of erreurs) console.error(`  ✗ ${e}`);

  await mkdir('sortie', { recursive: true });
  const rapport = `sortie/synchro-stocks-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(rapport, JSON.stringify({
    ecarts: ecarts.map(({ sku, famille, disponible, sage }) => ({ sku, famille, avant: disponible, apres: sage })),
    misesAZeroBloquees: bloques.map(({ sku, disponible }) => ({ sku, avant: disponible })),
    erreurs,
  }, null, 2));
  console.log(`Rapport : ${rapport}`);
  process.exitCode = erreurs.length || bloques.length ? 1 : 0;
} catch (err) {
  if ('finAnticipee' in err) process.exitCode = err.finAnticipee;
  else {
    console.error(`Erreur : ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await pool?.close();
}
