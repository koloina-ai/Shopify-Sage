// Commande Shopify -> « commande Sage » au format neutre, commun à tous les intégrateurs (tampon, Objets Métiers).
// Vérifie dans Sage (lecture seule) que le client et les articles existent ; sinon la commande est « A_VERIFIER ».

const montant = (set) => Number(set?.shopMoney?.amount ?? 0);

// Longueurs des codes Sage : un code plus long est une erreur de saisie, jamais tronqué (il désignerait un autre article).
const LONGUEUR_AR_REF = 19;
const LONGUEUR_CT_NUM = 17;

/**
 * @typedef {object} CommandeSage
 * @property {string} shopifyId
 * @property {string} numeroShopify
 * @property {Date} date
 * @property {string|null} ctNum
 * @property {'A_INTEGRER'|'A_VERIFIER'} statut
 * @property {string[]} messages   raisons de A_VERIFIER, ou informations (client par défaut…)
 * @property {object} client       { nom, email, referenceClient }
 * @property {object|null} livraison
 * @property {object} totaux       { devise, prixTtc, ht, taxes, ttc }
 * @property {{ numero: number, arRef: string|null, designation: string, quantite: number, prixUnitaire: number, montant: number }[]} lignes
 */

/**
 * @param {object} commande             commande Shopify (voir commandes-sage/shopify.js)
 * @param {Map<string, object>} articles articles Sage existants (sage.articlesExistants)
 * @param {Map<string, object>} clients  clients Sage existants (sage.clientsExistants)
 * @param {string|null} clientParDefaut  CT_Num utilisé pour les commandes sans entreprise B2B (ex. compte « web »)
 * @returns {CommandeSage}
 */
export function preparerCommande(commande, { articles, clients, clientParDefaut }) {
  const messages = [];
  let bloquante = false;
  const bloquer = (m) => {
    messages.push(m);
    bloquante = true;
  };

  // --- Client : l'identifiant externe de l'entreprise B2B porte le code client Sage (CT_Num) ---
  const entreprise = commande.purchasingEntity?.__typename === 'PurchasingCompany' ? commande.purchasingEntity : null;
  let ctNum = entreprise?.company?.externalId?.trim() || null;
  if (!ctNum && clientParDefaut) {
    ctNum = clientParDefaut;
    messages.push(`pas d'entreprise B2B : client par défaut ${clientParDefaut}`);
  }
  if (!ctNum) {
    bloquer('client inconnu : la commande n\'est rattachée à aucune entreprise B2B (code client Sage)');
  } else if (ctNum.length > LONGUEUR_CT_NUM) {
    bloquer(`code client « ${ctNum} » trop long pour Sage (${LONGUEUR_CT_NUM} caractères max.)`);
    ctNum = null;
  } else if (!clients.has(ctNum)) {
    bloquer(`client ${ctNum} introuvable dans Sage`);
  } else if (clients.get(ctNum).CT_Sommeil !== 0) {
    bloquer(`client ${ctNum} en sommeil dans Sage`);
  }

  // --- Lignes : le SKU Shopify est la référence article Sage (AR_Ref) ---
  const lignes = commande.lineItems.nodes.map((l, i) => {
    const prixUnitaire = montant(l.discountedUnitPriceAfterAllDiscountsSet);
    let arRef = l.sku?.trim() || null;
    if (!arRef) bloquer(`ligne ${i + 1} « ${l.name} » : pas de référence article (SKU)`);
    else if (arRef.length > LONGUEUR_AR_REF) {
      bloquer(`ligne ${i + 1} : SKU « ${arRef} » trop long pour une référence Sage (${LONGUEUR_AR_REF} caractères max.)`);
      arRef = null;
    } else if (!articles.has(arRef)) bloquer(`ligne ${i + 1} : article ${arRef} introuvable dans Sage`);
    else if (articles.get(arRef).AR_Sommeil !== 0) bloquer(`ligne ${i + 1} : article ${arRef} en sommeil dans Sage`);
    return {
      numero: i + 1,
      arRef,
      designation: l.name,
      quantite: l.quantity,
      prixUnitaire,
      montant: Math.round(prixUnitaire * l.quantity * 1e6) / 1e6,
    };
  });
  if (lignes.length === 0) bloquer('commande sans ligne');
  if (commande.test) messages.push('commande de test Shopify');

  const adresse = commande.shippingAddress;
  return {
    shopifyId: commande.id,
    numeroShopify: commande.name,
    date: new Date(commande.createdAt),
    ctNum,
    statut: bloquante ? 'A_VERIFIER' : 'A_INTEGRER',
    messages,
    client: {
      nom: entreprise?.company?.name ?? commande.customer?.displayName ?? null,
      email: commande.customer?.email ?? null,
      referenceClient: commande.poNumber ?? null,
      site: entreprise?.location?.name ?? null,
    },
    livraison: adresse && {
      nom: adresse.name,
      societe: adresse.company,
      adresse1: adresse.address1,
      adresse2: adresse.address2,
      codePostal: adresse.zip,
      ville: adresse.city,
      pays: adresse.countryCodeV2,
      telephone: adresse.phone,
    },
    totaux: {
      devise: commande.currencyCode,
      prixTtc: commande.taxesIncluded,
      ht: montant(commande.currentSubtotalPriceSet),
      taxes: montant(commande.currentTotalTaxSet),
      ttc: montant(commande.currentTotalPriceSet),
    },
    statutPaiement: commande.displayFinancialStatus,
    note: commande.note ?? null,
    lignes,
  };
}
