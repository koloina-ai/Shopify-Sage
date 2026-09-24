// Synchro des stocks Sage -> Shopify : npm run stocks -- [--simulation]
// Compare le disponible Sage (DP_STOCKS, dépôt principal) au disponible Shopify de chaque produit Sage
// et n'envoie que les différences. Indépendant de cbModification : détecte aussi les mouvements de stock seuls.

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, lireStocks } from './sage.js';
import { emplacementParDefaut } from './produits.js';
import { envoyerStocks, lireStocksShopify, quantiteStock } from './stocks.js';

const { values: args } = parseArgs({
  options: {
    simulation: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log('\nUsage : npm run stocks -- [--simulation]\n\n  --simulation   affiche les écarts sans rien envoyer à Shopify\n');
  process.exit(0);
}

let pool;
try {
  const client = creerClient(configShopify());
  const locationId = await emplacementParDefaut(client);
  pool = await connecterSage();
  const [stocksSage, produits] = await Promise.all([lireStocks(pool), lireStocksShopify(client, locationId)]);

  const ecarts = [];
  const sansStockSage = [];
  for (const p of produits) {
    if (!stocksSage.has(p.sku)) {
      sansStockSage.push(p.sku);
      continue;
    }
    const sage = quantiteStock(stocksSage.get(p.sku));
    if (!p.suivi || p.disponible !== sage) ecarts.push({ ...p, sage });
  }

  console.log(`${produits.length} produit(s) Sage dans Shopify — ${ecarts.length} stock(s) différent(s) de Sage`);
  if (sansStockSage.length) console.log(`  ${sansStockSage.length} sans ligne de stock dans Sage (non modifiés)`);
  if (ecarts.length) {
    console.table(ecarts.map((e) => ({ sku: e.sku, shopify: e.disponible, sage: e.sage })));
  }
  if (args.simulation || ecarts.length === 0) process.exit(0);

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
  await writeFile(rapport, JSON.stringify({ ecarts: ecarts.map(({ sku, disponible, sage }) => ({ sku, avant: disponible, apres: sage })), erreurs }, null, 2));
  console.log(`Rapport : ${rapport}`);
  process.exitCode = erreurs.length ? 1 : 0;
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
