// Synchro des stocks Sage -> Shopify : npm run stocks -- [--simulation] [--forcer-stocks]
// Compare le disponible Sage (DP_STOCKS, dépôt principal) au disponible Shopify de chaque produit géré par le connecteur
// et n'envoie que les différences. Indépendant de cbModification : détecte aussi les mouvements de stock seuls.

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, lireStocks } from './sage.js';
import { emplacementParDefaut } from './produits.js';
import { envoyerStocks, lireStocksShopify, produitsGeres, quantiteStock } from './stocks.js';
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
  pool = await connecterSage();
  const [stocksSage, tous] = await Promise.all([lireStocks(pool), lireStocksShopify(client, locationId)]);
  // Seulement les produits créés par le connecteur, hors « sage-ignorer » : les autres ne sont jamais modifiés
  const produits = produitsGeres(tous);
  const proteges = tous.length - produits.length;

  let ecarts = [];
  const sansStockSage = [];
  for (const p of produits) {
    if (!stocksSage.has(p.sku)) {
      sansStockSage.push(p.sku); // pas de ligne de stock dans Sage : on ne met surtout pas le stock à 0
      continue;
    }
    const sage = quantiteStock(stocksSage.get(p.sku));
    if (!p.suivi || p.disponible !== sage) ecarts.push({ ...p, sage });
  }

  console.log(`${produits.length} produit(s) Sage dans Shopify — ${ecarts.length} stock(s) différent(s) de Sage`);
  if (proteges) console.log(`  ${proteges} produit(s) protégé(s) non modifié(s) (sage-ignorer ou non créés par le connecteur)`);
  if (sansStockSage.length) console.log(`  ${sansStockSage.length} sans ligne de stock dans Sage (non modifiés)`);

  // Garde-fou : trop de produits qui tombent à 0 d'un coup = anomalie probable (table de stock vide, mauvaise base…)
  let bloques = [];
  if (!args['forcer-stocks']) {
    bloques = misesAZeroSuspectes(ecarts, produits.filter((p) => p.suivi).length);
    if (bloques.length) {
      const refs = new Set(bloques.map((b) => b.sku));
      ecarts = ecarts.filter((e) => !refs.has(e.sku));
      console.warn(
        `⚠ Mise à zéro bloquée : ${bloques.length} produits passeraient d'un coup à 0 en stock (anomalie probable côté Sage). ` +
          `Les autres écarts sont appliqués. Vérifier Sage, puis relancer avec --forcer-stocks si c'est voulu.`,
      );
    }
  }
  if (ecarts.length) {
    console.table(ecarts.map((e) => ({ sku: e.sku, shopify: e.disponible, sage: e.sage })));
  }
  if (args.simulation || ecarts.length === 0) terminer(bloques.length ? 1 : 0);

  // Suivi de stock à activer d'abord pour les variantes qui ne l'ont pas : inventorySetQuantities l'exige.
  const nonSuivis = ecarts.filter((e) => !e.suivi);
  for (const e of nonSuivis) {
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
    ecarts: ecarts.map(({ sku, disponible, sage }) => ({ sku, avant: disponible, apres: sage })),
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
