// Synchronisation des articles Sage vers les produits Shopify.
// Un article Sage = un produit Shopify à variante unique, retrouvé par son handle « sage-<AR_Ref> ».

import { envoyerStocks, quantiteStock } from './stocks.js';

const PRODUCT_SET = `#graphql
  mutation ProduitSage($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product { id handle variants(first: 1) { nodes { id inventoryItem { id } } } }
      userErrors { field message code }
    }
  }
`;

// Unités de poids Sage (AR_UnitePoids) -> Shopify
const UNITES_POIDS = {
  0: { unit: 'KILOGRAMS', facteur: 1000 }, // tonne
  1: { unit: 'KILOGRAMS', facteur: 100 }, // quintal
  2: { unit: 'KILOGRAMS', facteur: 1 },
  3: { unit: 'GRAMS', facteur: 1 },
  4: { unit: 'GRAMS', facteur: 0.001 }, // milligramme
};

export const handleArticle = (ref) => `sage-${ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** Article Sage -> entrée productSet. Le stock n'est inclus qu'à la création (Shopify l'ignore ensuite). */
export function versProduitShopify(article, { locationId, creation }) {
  const poids = article.AR_PoidsBrut > 0 ? article.AR_PoidsBrut : article.AR_PoidsNet;
  const unite = UNITES_POIDS[article.AR_UnitePoids];
  const aStock = article.stock_dispo !== null;

  const variante = {
    optionValues: [{ optionName: 'Title', name: 'Default Title' }],
    sku: article.AR_Ref,
    barcode: article.AR_CodeBarre || null,
    price: article.AR_PrixVen.toFixed(2),
    inventoryItem: {
      tracked: aStock,
      ...(poids > 0 && unite && { measurement: { weight: { value: poids * unite.facteur, unit: unite.unit } } }),
    },
  };
  if (creation && aStock) {
    variante.inventoryQuantities = [{ locationId, name: 'available', quantity: quantiteStock(article.stock_dispo) }];
  }

  return {
    handle: handleArticle(article.AR_Ref),
    title: article.AR_Design.trim(),
    vendor: 'SODICO',
    productType: article.AR_Stat02 || '',
    tags: ['sage', article.FA_CodeFamille, article.AR_Stat04].filter(Boolean),
    status: 'ACTIVE',
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [variante],
    metafields: [
      { namespace: 'sage', key: 'ar_ref', type: 'single_line_text_field', value: article.AR_Ref },
      { namespace: 'sage', key: 'cb_modification', type: 'date_time', value: article.cbModification.toISOString().slice(0, 19) },
    ],
  };
}

/** Handles déjà présents dans Shopify (par lots de 50). */
async function handlesExistants(client, handles) {
  const existants = new Set();
  for (let i = 0; i < handles.length; i += 50) {
    const lot = handles.slice(i, i + 50);
    const { data } = await client.requete(
      `query($q: String!) { products(first: 50, query: $q) { nodes { handle } } }`,
      { q: lot.map((h) => `handle:${h}`).join(' OR ') },
    );
    data.products.nodes.forEach((p) => existants.add(p.handle));
  }
  return existants;
}

/** Emplacement de stock : SHOPIFY_LOCATION_ID, sinon le plus ancien (l'emplacement par défaut de la boutique). */
export async function emplacementParDefaut(client) {
  if (process.env.SHOPIFY_LOCATION_ID) return process.env.SHOPIFY_LOCATION_ID;
  const { data } = await client.requete(`{ locations(first: 50) { nodes { id } } }`);
  const ids = data.locations.nodes.map((l) => l.id);
  if (!ids.length) throw new Error('Aucun emplacement de stock dans la boutique');
  return ids.sort((a, b) => Number(a.split('/').pop()) - Number(b.split('/').pop()))[0];
}

/**
 * Envoie les articles dans Shopify.
 * @returns {{ crees: string[], misAJour: string[], erreurs: {ref: string, message: string}[] }}
 */
export async function synchroniserProduits(client, articles, { locationId, surProgression = () => {} }) {
  const bilan = { crees: [], misAJour: [], erreurs: [] };
  const existants = await handlesExistants(client, articles.map((a) => handleArticle(a.AR_Ref)));
  const stocksAMettreAJour = [];

  for (const [i, article] of articles.entries()) {
    const handle = handleArticle(article.AR_Ref);
    const creation = !existants.has(handle);
    try {
      const { data } = await client.requete(PRODUCT_SET, {
        identifier: { handle },
        input: versProduitShopify(article, { locationId, creation }),
      });
      const { product, userErrors } = data.productSet;
      if (userErrors.length) throw new Error(userErrors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`).join(' ; '));

      (creation ? bilan.crees : bilan.misAJour).push(article.AR_Ref);
      if (!creation && article.stock_dispo !== null) {
        stocksAMettreAJour.push({
          inventoryItemId: product.variants.nodes[0].inventoryItem.id,
          locationId,
          quantity: quantiteStock(article.stock_dispo),
          changeFromQuantity: null,
        });
      }
    } catch (err) {
      bilan.erreurs.push({ ref: article.AR_Ref, message: err.message });
    }
    surProgression(i + 1, articles.length);
  }

  // Stock des produits existants (à la création, il est fixé par productSet)
  const erreursStock = await envoyerStocks(client, stocksAMettreAJour, 'sage://sodico/synchro-produits');
  bilan.erreurs.push(...erreursStock.map((message) => ({ ref: '(stock)', message })));

  return bilan;
}
