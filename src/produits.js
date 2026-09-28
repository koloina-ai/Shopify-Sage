// Synchronisation des articles Sage vers les produits Shopify.
// Un article Sage = un produit Shopify à variante unique, retrouvé par son handle « sage-<AR_Ref> ».
//
// Création : productSet (produit complet).
// Mise à jour : uniquement les champs gérés par le connecteur (titre, fournisseur, type, prix, code-barre, poids,
// ses propres étiquettes et champs « sage.* »). Rien d'autre n'est envoyé, donc rien d'autre ne peut être écrasé :
// photos, description, SEO, étiquettes et champs ajoutés par SODICO, prix barré, statut choisi à la main.

import { quantiteStock } from './stocks.js';
import { ETIQUETTE_RETIRE, controlePrix, etiquettesGerees, fusionEtiquettes, handleArticle } from './regles.js';

export { handleArticle } from './regles.js';

const PRODUCT_SET = `#graphql
  mutation CreationProduitSage($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
    productSet(identifier: $identifier, input: $input, synchronous: true) {
      product { id }
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

function poidsShopify(article) {
  const poids = article.AR_PoidsBrut > 0 ? article.AR_PoidsBrut : article.AR_PoidsNet;
  const unite = UNITES_POIDS[article.AR_UnitePoids];
  return poids > 0 && unite ? { weight: { value: poids * unite.facteur, unit: unite.unit } } : undefined;
}

const metafieldsSage = (article) => [
  { namespace: 'sage', key: 'ar_ref', type: 'single_line_text_field', value: article.AR_Ref },
  { namespace: 'sage', key: 'cb_modification', type: 'date_time', value: article.cbModification.toISOString().slice(0, 19) },
  // Étiquettes posées par le connecteur : permet de retirer plus tard les siennes sans toucher à celles de SODICO
  { namespace: 'sage', key: 'etiquettes', type: 'json', value: JSON.stringify(etiquettesGerees(article)) },
];

/** Article Sage -> entrée productSet pour une CRÉATION (le stock initial est fixé en même temps). */
export function versProduitShopify(article, { locationId, statut = 'ACTIVE' }) {
  const aStock = article.stock_dispo !== null;
  const measurement = poidsShopify(article);
  return {
    handle: handleArticle(article.AR_Ref),
    title: article.AR_Design.trim(),
    vendor: 'SODICO',
    productType: article.AR_Stat02 || '',
    tags: etiquettesGerees(article),
    status: statut,
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [{
      optionValues: [{ optionName: 'Title', name: 'Default Title' }],
      sku: article.AR_Ref,
      barcode: article.AR_CodeBarre || null,
      price: article.AR_PrixVen.toFixed(2),
      inventoryPolicy: 'DENY', // pas de vente au-delà du stock
      inventoryItem: { tracked: aStock, ...(measurement && { measurement }) },
      ...(aStock && { inventoryQuantities: [{ locationId, name: 'available', quantity: quantiteStock(article.stock_dispo) }] }),
    }],
    metafields: metafieldsSage(article),
  };
}

/**
 * Mise à jour d'un produit existant : une seule requête, uniquement les champs gérés.
 * @param {object} existant  produit Shopify (stocks.lireStocksShopify)
 * @returns {{ document: string, variables: object, prixBloque: object|null }}
 */
export function miseAJourProduit(article, existant, { variationPrixMax = 0.5, forcerPrix = false, reactiver = false } = {}) {
  const nouveauPrix = Number(article.AR_PrixVen.toFixed(2));
  const { appliquer, variation } = forcerPrix ? { appliquer: true, variation: null } : controlePrix(existant.prix, nouveauPrix, variationPrixMax);
  const measurement = poidsShopify(article);
  const { ajouter, retirer } = fusionEtiquettes(existant.tags, existant.etiquettesConnecteur, etiquettesGerees(article));
  if (reactiver) retirer.push(ETIQUETTE_RETIRE);

  const variables = {
    produit: {
      id: existant.produitId,
      title: article.AR_Design.trim(),
      vendor: 'SODICO',
      productType: article.AR_Stat02 || '',
      // Le statut n'est envoyé que pour remettre en vente un produit que le connecteur avait lui-même retiré
      ...(reactiver && { status: 'ACTIVE' }),
    },
    produitId: existant.produitId,
    variantes: [{
      id: existant.varianteId,
      ...(appliquer && { price: nouveauPrix.toFixed(2) }),
      barcode: article.AR_CodeBarre || null,
      inventoryItem: { sku: article.AR_Ref, tracked: article.stock_dispo !== null, ...(measurement && { measurement }) },
    }],
    metafields: metafieldsSage(article).map((m) => ({ ...m, ownerId: existant.produitId })),
  };
  const parties = [
    'produit: productUpdate(product: $produit) { userErrors { field message } }',
    'variantes: productVariantsBulkUpdate(productId: $produitId, variants: $variantes) { userErrors { field message } }',
    'champs: metafieldsSet(metafields: $metafields) { userErrors { field message } }',
  ];
  const declarations = ['$produit: ProductUpdateInput!', '$produitId: ID!', '$variantes: [ProductVariantsBulkInput!]!', '$metafields: [MetafieldsSetInput!]!'];
  if (ajouter.length) {
    parties.push('ajout: tagsAdd(id: $produitId, tags: $ajouter) { userErrors { field message } }');
    declarations.push('$ajouter: [String!]!');
    variables.ajouter = ajouter;
  }
  if (retirer.length) {
    parties.push('retrait: tagsRemove(id: $produitId, tags: $retirer) { userErrors { field message } }');
    declarations.push('$retirer: [String!]!');
    variables.retirer = retirer;
  }
  return {
    document: `mutation MiseAJourProduitSage(${declarations.join(', ')}) {\n  ${parties.join('\n  ')}\n}`,
    variables,
    prixBloque: appliquer ? null : { ref: article.AR_Ref, ancien: existant.prix, nouveau: nouveauPrix, variation: Math.round(variation * 100) },
  };
}

const erreursDe = (data) => Object.values(data).flatMap((r) => r?.userErrors ?? []);
const texteErreurs = (erreurs) => erreurs.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`.trim()).join(' ; ');

const PRODUCT_DRAFT = `#graphql
  mutation RetraitSage($id: ID!, $tags: [String!]!) {
    produit: productUpdate(product: { id: $id, status: DRAFT }) { userErrors { field message } }
    marque: tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

/**
 * Passe en brouillon les produits qui ne doivent plus être en vente, et les marque « sage-retire » :
 * seuls ceux-là pourront être remis en vente automatiquement (un produit masqué à la main par SODICO le reste).
 * @param {{ sku: string, produitId: string, raison: string }[]} produits
 */
export async function retirerProduits(client, produits) {
  const bilan = { retires: [], erreurs: [] };
  for (const p of produits) {
    try {
      const { data } = await client.requete(PRODUCT_DRAFT, { id: p.produitId, tags: [ETIQUETTE_RETIRE] });
      const erreurs = erreursDe(data);
      if (erreurs.length) throw new Error(texteErreurs(erreurs));
      bilan.retires.push({ ref: p.sku, raison: p.raison });
    } catch (err) {
      bilan.erreurs.push({ ref: p.sku, message: `retrait : ${err.message}` });
    }
  }
  return bilan;
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
 * Crée ou met à jour les articles dans Shopify. Le stock des produits existants est géré par l'étape stocks.
 * @param {Map<string, object>} existants  produits gérés par le connecteur, par SKU (stocks.produitsGeres)
 * @param {Set<string>} areactiver          SKU à remettre en vente (retirés auparavant par le connecteur)
 * @returns {{ crees: string[], misAJour: string[], prixBloques: object[], erreurs: {ref: string, message: string}[] }}
 */
export async function synchroniserProduits(client, articles, {
  locationId, existants, areactiver = new Set(), statutCreation = 'ACTIVE', variationPrixMax, forcerPrix, surProgression = () => {},
}) {
  const bilan = { crees: [], misAJour: [], prixBloques: [], erreurs: [] };

  for (const [i, article] of articles.entries()) {
    const existant = existants.get(article.AR_Ref);
    try {
      if (existant) {
        const { document, variables, prixBloque } = miseAJourProduit(article, existant, {
          variationPrixMax, forcerPrix, reactiver: areactiver.has(article.AR_Ref),
        });
        const { data } = await client.requete(document, variables);
        const erreurs = erreursDe(data);
        if (erreurs.length) throw new Error(texteErreurs(erreurs));
        bilan.misAJour.push(article.AR_Ref);
        if (prixBloque) bilan.prixBloques.push(prixBloque);
      } else {
        // Vérification directe (pas par la recherche, indexée avec retard) : productSet écraserait un produit existant.
        const { data: verif } = await client.requete(
          `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`,
          { h: handleArticle(article.AR_Ref) },
        );
        if (verif.productByIdentifier) {
          throw new Error('un produit avec cette adresse existe déjà dans Shopify (pas encore indexé, ou créé hors connecteur) : non modifié, repris au passage suivant');
        }
        const { data } = await client.requete(PRODUCT_SET, {
          identifier: { handle: handleArticle(article.AR_Ref) },
          input: versProduitShopify(article, { locationId, statut: statutCreation }),
        });
        const erreurs = data.productSet.userErrors;
        if (erreurs.length) throw new Error(texteErreurs(erreurs));
        bilan.crees.push(article.AR_Ref);
      }
    } catch (err) {
      bilan.erreurs.push({ ref: article.AR_Ref, message: err.message });
    }
    surProgression(i + 1, articles.length);
  }
  return bilan;
}
