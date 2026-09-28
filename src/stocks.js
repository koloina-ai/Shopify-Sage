// Produits Sage dans Shopify : lecture (avec les informations de protection) et mise à jour des stocks par lots.

import { randomUUID } from 'node:crypto';
import { ETIQUETTE_IGNORER, estProduitConnecteur, lireEtiquettesEnregistrees } from './regles.js';

const INVENTORY_SET = `#graphql
  mutation StockSage($input: InventorySetQuantitiesInput!, $cle: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $cle) {
      userErrors { field message code }
    }
  }
`;

const PRODUITS_SAGE = `#graphql
  query ProduitsSage($after: String, $locationId: ID!) {
    products(first: 100, after: $after, query: "tag:sage") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        status
        tags
        arRef: metafield(namespace: "sage", key: "ar_ref") { value }
        etiquettes: metafield(namespace: "sage", key: "etiquettes") { value }
        variants(first: 2) {
          nodes {
            id
            sku
            price
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
 * Produits Shopify portant l'étiquette « sage » (tous statuts), avec ce qu'il faut pour les protéger :
 * - proprietaire : créé par le connecteur (adresse sage-… et référence Sage identique au SKU). Les autres ne sont jamais modifiés ;
 * - ignore : SODICO a posé l'étiquette « sage-ignorer », le connecteur n'y touche plus.
 * @returns {{ sku: string, produitId: string, handle: string, statut: string, tags: string[], arRef: string|null,
 *             etiquettesConnecteur: string[]|null, varianteId: string, prix: number, nbVariantes: number,
 *             inventoryItemId: string, suivi: boolean, disponible: number|null, proprietaire: boolean, ignore: boolean }[]}
 */
export async function lireStocksShopify(client, locationId) {
  const produits = [];
  let after = null;
  do {
    const { data } = await client.requete(PRODUITS_SAGE, { after, locationId });
    for (const p of data.products.nodes) {
      const v = p.variants.nodes[0];
      if (!v?.sku) continue;
      const produit = {
        sku: v.sku,
        produitId: p.id,
        handle: p.handle,
        statut: p.status,
        tags: p.tags,
        arRef: p.arRef?.value ?? null,
        etiquettesConnecteur: lireEtiquettesEnregistrees(p.etiquettes?.value ?? 'null'),
        varianteId: v.id,
        prix: Number(v.price),
        nbVariantes: p.variants.nodes.length,
        inventoryItemId: v.inventoryItem.id,
        suivi: v.inventoryItem.tracked,
        disponible: v.inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? null,
        ignore: p.tags.includes(ETIQUETTE_IGNORER),
      };
      // Un produit auquel SODICO a ajouté des variantes n'est plus un produit « simple » géré par le connecteur
      produit.proprietaire = estProduitConnecteur(produit) && produit.nbVariantes === 1;
      produits.push(produit);
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);
  return produits;
}

/** Produits que le connecteur a le droit de modifier : créés par lui, et non marqués « sage-ignorer ». */
export const produitsGeres = (produits) => produits.filter((p) => p.proprietaire && !p.ignore);

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
