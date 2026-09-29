// Mise à jour des stocks Shopify par lots (la lecture des variantes est dans familles.js).

import { randomUUID } from 'node:crypto';

const INVENTORY_SET = `#graphql
  mutation StockSage($input: InventorySetQuantitiesInput!, $cle: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $cle) {
      userErrors { field message code }
    }
  }
`;

// Shopify n'accepte que des quantités entières : on arrondit à l'inférieur (ex. 5591,5 m -> 5591), stock négatif -> 0.
export const quantiteStock = (dispo) => Math.max(0, Math.floor(dispo));

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
