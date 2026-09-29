// Vérifie que les variantes Shopify correspondent aux articles Sage : npm run verifier
// Pour chaque variante des familles gérées : référence présente dans Sage, prix, code-barre et stock identiques.

import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { articlesExistants, connecterSage, lireStocks } from './sage.js';
import { emplacementParDefaut, lireFamillesShopify, variantesGerees } from './familles.js';
import { quantiteStock } from './stocks.js';
import sql from 'mssql/msnodesqlv8.js';

let pool;
try {
  const client = creerClient(configShopify());
  const familles = await lireFamillesShopify(client, await emplacementParDefaut(client));
  const variantes = variantesGerees(familles).filter((v) => v.sku);

  pool = await connecterSage();
  const [stocks, existants] = await Promise.all([lireStocks(pool), articlesExistants(pool, variantes.map((v) => v.sku))]);
  // Prix et code-barre des articles concernés
  const details = new Map();
  for (let i = 0; i < variantes.length; i += 500) {
    const lot = variantes.slice(i, i + 500);
    const req = pool.request();
    lot.forEach((v, j) => req.input(`r${j}`, sql.VarChar(19), v.sku));
    const { recordset } = await req.query(`SELECT AR_Ref, ISNULL(AR_PrixVen, 0) AS AR_PrixVen, AR_CodeBarre FROM dbo.F_ARTICLE
      WHERE AR_Ref IN (${lot.map((_, j) => `@r${j}`).join(', ')})`);
    recordset.forEach((a) => details.set(a.AR_Ref, a));
  }

  const ecarts = [];
  for (const v of variantes) {
    const a = details.get(v.sku);
    if (!a) {
      ecarts.push({ famille: v.famille, ref: v.sku, champ: 'référence', sage: '(absente)', shopify: v.sku });
      continue;
    }
    const attendu = {
      prix: a.AR_PrixVen > 0 ? Number(a.AR_PrixVen).toFixed(2) : null, // prix 0 dans Sage : prix Shopify conservé, pas un écart
      'code-barre': a.AR_CodeBarre?.trim() || null,
      stock: existants.get(v.sku)?.AR_Sommeil ? 0 : stocks.has(v.sku) ? quantiteStock(stocks.get(v.sku)) : null,
    };
    const obtenu = { prix: v.prix.toFixed(2), 'code-barre': v.codeBarre, stock: v.disponible };
    for (const champ of Object.keys(attendu)) {
      if (attendu[champ] !== null && attendu[champ] !== obtenu[champ]) {
        ecarts.push({ famille: v.famille, ref: v.sku, champ, sage: attendu[champ], shopify: obtenu[champ] });
      }
    }
  }

  const nbFamilles = familles.filter((f) => f.proprietaire && !f.ignore).length;
  console.log(`Familles gérées : ${nbFamilles}   variantes comparées avec Sage : ${variantes.length}   écarts : ${ecarts.length}`);
  if (variantes.length === 0) {
    console.log('✗ Aucune variante à comparer dans Shopify (lancer npm run catalogue)');
    process.exitCode = 1;
  } else if (ecarts.length) {
    console.table(ecarts);
    process.exitCode = 1;
  } else {
    console.log('✓ Prix, code-barre et stock identiques entre Sage et Shopify');
  }
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
