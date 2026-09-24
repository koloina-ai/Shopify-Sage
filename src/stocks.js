// Stocks Shopify : lecture des quantités disponibles et mise à jour par lots.

import { randomUUID } from 'node:crypto';

const INVENTORY_SET = `#graphql
  mutation StockSage($input: InventorySetQuantitiesInput!, $cle: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $cle) {
      userErrors { field message code }
    }
  }
`;

const PRODUITS_SAGE = `#graphql
  query StocksShopify($after: String, $locationId: ID!) {
    products(first: 100, after: $after, query: "tag:sage") {
      pageInfo { hasNextPage endCursor }
      nodes {
        handle
        variants(first: 1) {
          nodes {
            sku
            inventoryItem {
              id
              tracked
              inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { quantity } }
            }
          }
        }
      }
    }
  }
`;

// Shopify n'accepte que des quantités entières : on arrondit à l'inférieur (ex. 5591,5 m -> 5591).
export const quantiteStock = (dispo) => Math.max(0, Math.floor(dispo));

/**
 * Produits Sage présents dans Shopify, avec leur stock disponible à l'emplacement donné.
 * @returns {{ sku: string, inventoryItemId: string, suivi: boolean, disponible: number|null }[]}
 */
export async function lireStocksShopify(client, locationId) {
  const stocks = [];
  let after = null;
  do {
    const { data } = await client.requete(PRODUITS_SAGE, { after, locationId });
    for (const p of data.products.nodes) {
      const v = p.variants.nodes[0];
      if (!v?.sku) continue;
      stocks.push({
        sku: v.sku,
        inventoryItemId: v.inventoryItem.id,
        suivi: v.inventoryItem.tracked,
        disponible: v.inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? null,
      });
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return stocks;
}

/**
 * Fixe les quantités disponibles, par lots de 100.
 * `changeFromQuantity` (quantité lue juste avant) fait échouer la mise à jour si le stock Shopify a bougé
 * entre-temps, par exemple à cause d'une commande : on ne l'écrase pas à l'aveugle.
 * @param {{ inventoryItemId: string, locationId: string, quantity: number, changeFromQuantity: number|null }[]} quantites
 * @returns {string[]} messages d'erreur
 */
export async function envoyerStocks(client, quantites, reference) {
  const erreurs = [];
  for (let i = 0; i < quantites.length; i += 100) {
    const { data } = await client.requete(INVENTORY_SET, {
      cle: randomUUID(),
      input: { name: 'available', reason: 'correction', referenceDocumentUri: reference, quantities: quantites.slice(i, i + 100) },
    });
    erreurs.push(...data.inventorySetQuantities.userErrors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`.trim()));
  }
  return erreurs;
}
