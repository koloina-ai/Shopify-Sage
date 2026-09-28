// Commandes Shopify à transmettre à Sage, et marquage une fois transmises.
// Une commande transmise reçoit l'étiquette « sage-transmise » : elle n'est plus reprise ensuite.
// Option B : une commande incomplète, non créée dans Sage, reçoit « sage-a-verifier ». Pour la relancer
// après correction (client créé dans Sage…), retirer cette étiquette dans l'admin Shopify.

export const ETIQUETTE_TRANSMISE = 'sage-transmise';
export const ETIQUETTE_A_VERIFIER = 'sage-a-verifier';

const QUERY = `#graphql
  query CommandesPourSage($after: String, $q: String!) {
    orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt test tags note poNumber
        currencyCode taxesIncluded displayFinancialStatus
        currentSubtotalPriceSet { shopMoney { amount } }
        currentTotalTaxSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        customer { displayName email }
        purchasingEntity {
          __typename
          ... on PurchasingCompany { company { name externalId } location { name } }
        }
        shippingAddress { name company address1 address2 zip city countryCodeV2 phone }
        lineItems(first: 250) {
          nodes { sku name quantity discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } }
        }
      }
    }
  }
`;

const TAGS_ADD = `#graphql
  mutation MarquerTransmise($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }
`;

/**
 * Commandes non annulées, créées depuis `depuis`, pas encore marquées « sage-transmise ».
 * @returns {{ commandes: object[], avertissements: string[] }}
 */
export async function lireCommandesATransmettre(client, depuis) {
  const q = `-tag:${ETIQUETTE_TRANSMISE} -tag:${ETIQUETTE_A_VERIFIER} -status:cancelled created_at:>=${depuis.toISOString()}`;
  const commandes = [];
  const avertissements = new Set();
  let after = null;
  do {
    const { data, erreurs } = await client.requete(QUERY, { after, q });
    // Données client protégées refusées : la commande part quand même, sans ces champs
    erreurs.forEach((e) => avertissements.add(e.message));
    commandes.push(...data.orders.nodes.filter((o) => !o.tags.includes(ETIQUETTE_TRANSMISE) && !o.tags.includes(ETIQUETTE_A_VERIFIER)));
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return { commandes, avertissements: [...avertissements] };
}

export async function marquerTransmise(client, commandeId, etiquette = ETIQUETTE_TRANSMISE) {
  const { data } = await client.requete(TAGS_ADD, { id: commandeId, tags: [etiquette] });
  const erreurs = data.tagsAdd.userErrors;
  if (erreurs.length) throw new Error(erreurs.map((e) => e.message).join(' ; '));
}
