// Récupération paginée des commandes.

const QUERY_COMMANDES = `#graphql
  query Commandes($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName email }
        purchasingEntity {
          __typename
          ... on PurchasingCompany {
            company { id name externalId }
            location { id name }
          }
        }
        lineItems(first: 100) {
          nodes {
            sku
            name
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

const TAILLE_PAGE = 50;

/**
 * @param {object} client  client créé par creerClient()
 * @param {object} options
 * @param {string} [options.depuis]  date ISO (YYYY-MM-DD) : commandes créées à partir de cette date
 * @param {number} [options.limite]  nombre maximum de commandes à récupérer
 * @param {string} [options.filtre]  filtre de recherche Shopify brut (ex. "financial_status:paid")
 */
export async function recupererCommandes(client, { depuis, limite = Infinity, filtre } = {}) {
  const criteres = [];
  if (depuis) criteres.push(`created_at:>=${depuis}`);
  if (filtre) criteres.push(filtre);
  const query = criteres.join(' ') || null;

  const commandes = [];
  const avertissements = new Set();
  let after = null;

  while (commandes.length < limite) {
    const first = Math.min(TAILLE_PAGE, limite - commandes.length);
    const { data, erreurs } = await client.requete(QUERY_COMMANDES, { first, after, query });
    erreurs.forEach((e) => avertissements.add(e.message));

    const { nodes, pageInfo } = data.orders;
    commandes.push(...nodes.map(normaliser));
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return { commandes, avertissements: [...avertissements] };
}

function normaliser(o) {
  const entreprise = o.purchasingEntity?.__typename === 'PurchasingCompany' ? o.purchasingEntity : null;
  return {
    id: o.id,
    numero: o.name,
    creeLe: o.createdAt,
    statutPaiement: o.displayFinancialStatus,
    statutExpedition: o.displayFulfillmentStatus,
    total: Number(o.currentTotalPriceSet.shopMoney.amount),
    devise: o.currentTotalPriceSet.shopMoney.currencyCode,
    client: o.customer ? { id: o.customer.id, nom: o.customer.displayName, email: o.customer.email } : null,
    // externalId de l'entreprise = code tiers Sage (CT_Num) une fois la synchro clients en place
    entreprise: entreprise
      ? {
          id: entreprise.company.id,
          nom: entreprise.company.name,
          codeSage: entreprise.company.externalId,
          site: entreprise.location?.name ?? null,
        }
      : null,
    lignes: o.lineItems.nodes.map((l) => ({
      sku: l.sku,
      designation: l.name,
      quantite: l.quantity,
      prixUnitaire: Number(l.originalUnitPriceSet.shopMoney.amount),
    })),
  };
}
