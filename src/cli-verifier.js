// Vérifie que les produits Shopify correspondent aux articles Sage : npm run verifier

import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, lireArticles } from './sage.js';
import { handleArticle } from './produits.js';

const QUERY = `#graphql
  query($after: String) {
    products(first: 100, after: $after, query: "tag:sage") {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle title status
        variants(first: 1) { nodes { sku barcode price inventoryQuantity } }
      }
    }
  }
`;

let pool;
try {
  const client = creerClient(configShopify());
  const produits = new Map();
  let after = null;
  do {
    const { data } = await client.requete(QUERY, { after });
    data.products.nodes.forEach((p) => produits.set(p.handle, p));
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  pool = await connecterSage();
  const articles = (await lireArticles(pool)).filter((a) => produits.has(handleArticle(a.AR_Ref)));

  const ecarts = [];
  for (const a of articles) {
    const p = produits.get(handleArticle(a.AR_Ref));
    const v = p.variants.nodes[0];
    const attendu = {
      sku: a.AR_Ref,
      barcode: a.AR_CodeBarre,
      price: a.AR_PrixVen.toFixed(2),
      stock: a.stock_dispo === null ? null : Math.max(0, Math.floor(a.stock_dispo)),
    };
    const obtenu = { sku: v.sku, barcode: v.barcode, price: Number(v.price).toFixed(2), stock: a.stock_dispo === null ? null : v.inventoryQuantity };
    for (const cle of Object.keys(attendu)) {
      if (attendu[cle] !== obtenu[cle]) ecarts.push({ ref: a.AR_Ref, champ: cle, sage: attendu[cle], shopify: obtenu[cle] });
    }
  }

  console.log(`Produits Sage dans Shopify : ${produits.size}   comparés avec Sage : ${articles.length}   écarts : ${ecarts.length}`);
  if (articles.length === 0) {
    console.log('✗ Aucun produit Sage à comparer dans Shopify (lancer npm run synchro)');
    process.exitCode = 1;
  } else if (ecarts.length) {
    console.table(ecarts);
    process.exitCode = 1;
  } else {
    console.log('✓ SKU, code-barre, prix et stock identiques entre Sage et Shopify');
  }
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
