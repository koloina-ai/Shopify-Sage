// Catalogue Sage -> Shopify par famille : 1 famille Sage (FA_CodeFamille) = 1 produit Shopify,
// 1 article Sage (AR_Ref) = 1 variante (SKU = AR_Ref, option « Article » = désignation Sage).
//
// Le connecteur crée les familles et les variantes manquantes, et tient à jour prix et code-barre des variantes.
// Le contenu du produit (titre, description, photos, SEO, étiquettes, statut) n'est défini qu'à la création : ensuite
// c'est à SODICO, jamais écrasé. Une désignation de variante renommée dans Shopify n'est plus touchée.
// Rien n'est jamais supprimé.

import { ETIQUETTE_CONNECTEUR, ETIQUETTE_IGNORER, controlePrix } from './regles.js';
import { quantiteStock } from './stocks.js';

export const NOM_OPTION = 'Article';
const MAX_VARIANTES_PAR_APPEL = 100;

export const handleFamille = (code) => `famille-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
export const titreFamille = (code) => `Famille ${code}`;
const prixTexte = (p) => Number(p).toFixed(2);

// ---------------------------------------------------------------------------------------------------------------
// Lecture des familles dans Shopify
// ---------------------------------------------------------------------------------------------------------------

const FAMILLES = `#graphql
  query FamillesSage($after: String) {
    products(first: 50, after: $after, query: "tag:${ETIQUETTE_CONNECTEUR}") {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title status tags options { name } code: metafield(namespace: "sage", key: "famille") { value } }
    }
  }
`;

const VARIANTES = `#graphql
  query VariantesFamille($id: ID!, $after: String, $locationId: ID!) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku price barcode
          selectedOptions { name value }
          designation: metafield(namespace: "sage", key: "designation") { value }
          inventoryItem { id tracked inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { quantity } } }
        }
      }
    }
  }
`;

/**
 * Familles présentes dans Shopify (produits étiquetés « sage »), avec toutes leurs variantes.
 * proprietaire : créée par le connecteur (adresse famille-… et champ sage.famille). Les autres ne sont jamais modifiées.
 */
export async function lireFamillesShopify(client, locationId) {
  const familles = [];
  let after = null;
  do {
    const { data } = await client.requete(FAMILLES, { after });
    for (const p of data.products.nodes) {
      const code = p.code?.value ?? null;
      familles.push({
        produitId: p.id,
        handle: p.handle,
        titre: p.title,
        statut: p.status,
        tags: p.tags,
        code,
        optionNom: p.options[0]?.name ?? NOM_OPTION,
        ignore: p.tags.includes(ETIQUETTE_IGNORER),
        proprietaire: Boolean(code) && p.handle === handleFamille(code),
        variantes: [],
      });
    }
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  for (const f of familles) {
    let apres = null;
    do {
      const { data } = await client.requete(VARIANTES, { id: f.produitId, after: apres, locationId });
      for (const v of data.product.variants.nodes) {
        f.variantes.push({
          varianteId: v.id,
          sku: v.sku?.trim() || null,
          prix: Number(v.price),
          codeBarre: v.barcode || null,
          option: v.selectedOptions.find((o) => o.name === f.optionNom)?.value ?? v.selectedOptions[0]?.value ?? null,
          designationSage: v.designation?.value ?? null,
          inventoryItemId: v.inventoryItem.id,
          suivi: v.inventoryItem.tracked,
          disponible: v.inventoryItem.inventoryLevel?.quantities[0]?.quantity ?? null,
        });
      }
      apres = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
    } while (apres);
  }
  return familles;
}

/** Variantes que le connecteur a le droit de modifier (familles créées par lui, hors « sage-ignorer »), à plat. */
export const variantesGerees = (familles) =>
  familles.filter((f) => f.proprietaire && !f.ignore).flatMap((f) => f.variantes.map((v) => ({ ...v, famille: f.code, produitId: f.produitId })));

// ---------------------------------------------------------------------------------------------------------------
// Planification (fonction pure, testée) : que faut-il créer, mettre à jour, signaler ?
// ---------------------------------------------------------------------------------------------------------------

/** Désignation Sage nettoyée, rendue unique dans la famille (ajout de la référence en cas de doublon). */
function valeurOption(article, prises) {
  const base = article.AR_Design.trim().replace(/\s+/g, ' ') || article.AR_Ref;
  const valeur = prises.has(base.toLowerCase()) ? `${base} (${article.AR_Ref})` : base;
  prises.add(valeur.toLowerCase());
  return valeur;
}

/**
 * @param {object[]} articles   articles Sage des familles synchronisées (sage.lireArticlesFamilles)
 * @param {object[]} familles   familles Shopify (lireFamillesShopify)
 * @returns {{ creations: {code: string, variantes: object[]}[], ajouts: {famille: object, variantes: object[]}[],
 *             majs: {famille: object, variantes: object[]}[], prixBloques: object[], signalements: {ref: string, famille: string, raison: string}[] }}
 */
export function planifierCatalogue(articles, familles, { variationPrixMax = 0.5, forcerPrix = false } = {}) {
  const plan = { creations: [], ajouts: [], majs: [], prixBloques: [], signalements: [] };
  const signaler = (ref, famille, raison) => plan.signalements.push({ ref, famille, raison });

  const geres = new Map(familles.filter((f) => f.proprietaire).map((f) => [f.code, f]));
  const handlesPris = new Map(familles.map((f) => [f.handle, f]));
  // Où se trouve déjà chaque SKU dans les familles du connecteur (pour repérer un changement de famille dans Sage)
  const familleDuSku = new Map();
  for (const f of geres.values()) for (const v of f.variantes) if (v.sku) familleDuSku.set(v.sku, f);

  const parFamille = new Map();
  for (const a of articles) {
    if (!parFamille.has(a.FA_CodeFamille)) parFamille.set(a.FA_CodeFamille, []);
    parFamille.get(a.FA_CodeFamille).push(a);
  }

  for (const [code, liste] of parFamille) {
    const famille = geres.get(code);
    if (!famille && handlesPris.has(handleFamille(code))) {
      signaler('—', code, `un produit « ${handleFamille(code)} » existe déjà sans avoir été créé par le connecteur : famille non modifiée`);
      continue;
    }
    if (famille?.ignore) {
      signaler('—', code, 'famille marquée « sage-ignorer » : non modifiée');
      continue;
    }
    const variantesParSku = new Map((famille?.variantes ?? []).filter((v) => v.sku).map((v) => [v.sku, v]));
    const prises = new Set((famille?.variantes ?? []).map((v) => (v.option ?? '').toLowerCase()));
    const aCreer = [];
    const aMettreAJour = [];

    for (const a of liste) {
      const existante = variantesParSku.get(a.AR_Ref);
      const ailleurs = !existante && familleDuSku.get(a.AR_Ref);
      const prixSage = Number(a.AR_PrixVen) || 0;

      if (ailleurs) {
        signaler(a.AR_Ref, code, `déjà dans la famille ${ailleurs.code} sur Shopify (famille changée dans Sage ?) : non déplacé`);
      } else if (!existante) {
        if (a.AR_Sommeil !== 0) continue; // article en sommeil jamais mis en ligne : rien à faire
        if (!(prixSage > 0)) {
          signaler(a.AR_Ref, code, 'pas de prix de vente dans Sage : variante non créée');
          continue;
        }
        aCreer.push({ article: a, option: valeurOption(a, prises) });
      } else {
        if (a.AR_Sommeil !== 0) signaler(a.AR_Ref, code, 'en sommeil dans Sage : stock mis à 0 sur la boutique');
        const changements = {};
        if (!(prixSage > 0)) {
          signaler(a.AR_Ref, code, 'prix à 0 dans Sage : prix Shopify conservé');
        } else if (prixTexte(prixSage) !== prixTexte(existante.prix)) {
          const { appliquer, variation } = forcerPrix ? { appliquer: true } : controlePrix(existante.prix, prixSage, variationPrixMax);
          if (appliquer) changements.price = prixTexte(prixSage);
          else plan.prixBloques.push({ ref: a.AR_Ref, famille: code, ancien: existante.prix, nouveau: Number(prixTexte(prixSage)), variation: Math.round(variation * 100) });
        }
        const codeBarre = a.AR_CodeBarre?.trim();
        if (codeBarre && codeBarre !== existante.codeBarre) changements.barcode = codeBarre;
        // Désignation : mise à jour seulement si SODICO ne l'a pas renommée dans Shopify
        const nonRenommee = existante.designationSage !== null && existante.option === existante.designationSage;
        const nouvelle = a.AR_Design.trim().replace(/\s+/g, ' ');
        if (nonRenommee && nouvelle && nouvelle !== existante.option) {
          prises.delete((existante.option ?? '').toLowerCase());
          changements.option = valeurOption(a, prises);
        }
        if (Object.keys(changements).length) aMettreAJour.push({ variante: existante, article: a, changements });
      }
    }

    if (!famille && aCreer.length) plan.creations.push({ code, variantes: aCreer });
    if (famille && aCreer.length) plan.ajouts.push({ famille, variantes: aCreer });
    if (famille && aMettreAJour.length) plan.majs.push({ famille, variantes: aMettreAJour });

    // Variantes de la famille qui ne correspondent plus à aucun article Sage de cette famille
    if (famille) {
      const refs = new Set(liste.map((a) => a.AR_Ref));
      for (const v of famille.variantes) {
        if (!v.sku) signaler('(sans SKU)', code, `variante « ${v.option} » sans référence : non gérée`);
        else if (!refs.has(v.sku)) signaler(v.sku, code, 'variante sans article correspondant dans cette famille Sage : non modifiée');
      }
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Application dans Shopify
// ---------------------------------------------------------------------------------------------------------------

const erreursDe = (data) => Object.values(data).flatMap((r) => r?.userErrors ?? []);
const texteErreurs = (erreurs) => erreurs.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`.trim()).join(' ; ');
const parLots = (liste, taille) => Array.from({ length: Math.ceil(liste.length / taille) }, (_, i) => liste.slice(i * taille, (i + 1) * taille));

const metafieldDesignation = (valeur) => ({ namespace: 'sage', key: 'designation', type: 'single_line_text_field', value: valeur });
const quantite = (article) => (article.stock_dispo === null || article.stock_dispo === undefined ? 0 : quantiteStock(article.stock_dispo));

/** Entrée productSet pour créer une famille avec ses premières variantes. */
export function versFamilleShopify(code, variantes, { locationId, statut = 'ACTIVE' }) {
  return {
    handle: handleFamille(code),
    title: titreFamille(code),
    vendor: 'SODICO',
    tags: [ETIQUETTE_CONNECTEUR, code],
    status: statut,
    productOptions: [{ name: NOM_OPTION, values: variantes.map((v) => ({ name: v.option })) }],
    variants: variantes.map(({ article, option }) => ({
      optionValues: [{ optionName: NOM_OPTION, name: option }],
      sku: article.AR_Ref,
      barcode: article.AR_CodeBarre?.trim() || null,
      price: prixTexte(article.AR_PrixVen),
      inventoryPolicy: 'DENY', // jamais de vente au-delà du stock
      inventoryItem: { tracked: true }, // toujours suivi : une variante non suivie serait vendable à l'infini
      inventoryQuantities: [{ locationId, name: 'available', quantity: quantite(article) }],
      metafields: [metafieldDesignation(option)],
    })),
    metafields: [{ namespace: 'sage', key: 'famille', type: 'single_line_text_field', value: code }],
  };
}

/** Entrées productVariantsBulkCreate pour ajouter des variantes à une famille existante. */
export function versNouvellesVariantes(variantes, { optionNom, locationId }) {
  return variantes.map(({ article, option }) => ({
    optionValues: [{ optionName: optionNom, name: option }],
    price: prixTexte(article.AR_PrixVen),
    barcode: article.AR_CodeBarre?.trim() || null,
    inventoryPolicy: 'DENY',
    inventoryItem: { sku: article.AR_Ref, tracked: true },
    inventoryQuantities: [{ locationId, availableQuantity: quantite(article) }],
    metafields: [metafieldDesignation(option)],
  }));
}

/** Entrées productVariantsBulkUpdate : seulement les champs qui changent. */
export function versMisesAJour(variantes, { optionNom }) {
  return variantes.map(({ variante, changements }) => ({
    id: variante.varianteId,
    ...(changements.price && { price: changements.price }),
    ...(changements.barcode && { barcode: changements.barcode }),
    ...(changements.option && {
      optionValues: [{ optionName: optionNom, name: changements.option }],
      metafields: [metafieldDesignation(changements.option)],
    }),
  }));
}

const PRODUCT_SET = `#graphql
  mutation CreationFamille($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) { product { id } userErrors { field message } }
  }
`;
const BULK_CREATE = `#graphql
  mutation AjoutVariantes($produitId: ID!, $variantes: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $produitId, variants: $variantes) { userErrors { field message } }
  }
`;
const BULK_UPDATE = `#graphql
  mutation MajVariantes($produitId: ID!, $variantes: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $produitId, variants: $variantes) { userErrors { field message } }
  }
`;

/**
 * Applique le plan. Chaque famille est traitée à part : une erreur sur l'une n'empêche pas les autres.
 * @returns {{ famillesCreees: string[], variantesAjoutees: string[], variantesMisesAJour: string[], erreurs: {famille: string, message: string}[] }}
 */
export async function appliquerCatalogue(client, plan, { locationId, statutCreation = 'ACTIVE' }) {
  const bilan = { famillesCreees: [], variantesAjoutees: [], variantesMisesAJour: [], erreurs: [] };
  const verifier = (data) => {
    const erreurs = erreursDe(data);
    if (erreurs.length) throw new Error(texteErreurs(erreurs));
  };

  for (const { code, variantes } of plan.creations) {
    try {
      // Vérification directe (pas par la recherche, indexée avec retard) : ne jamais écraser un produit existant
      const { data: verif } = await client.requete(
        `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`,
        { h: handleFamille(code) },
      );
      if (verif.productByIdentifier) throw new Error('un produit avec cette adresse existe déjà (pas encore indexé ?) : repris au passage suivant');
      const [premier, ...suite] = parLots(variantes, MAX_VARIANTES_PAR_APPEL);
      const { data } = await client.requete(PRODUCT_SET, { input: versFamilleShopify(code, premier, { locationId, statut: statutCreation }) });
      verifier(data);
      for (const lot of suite) {
        const r = await client.requete(BULK_CREATE, { produitId: data.productSet.product.id, variantes: versNouvellesVariantes(lot, { optionNom: NOM_OPTION, locationId }) });
        verifier(r.data);
      }
      bilan.famillesCreees.push(code);
      bilan.variantesAjoutees.push(...variantes.map((v) => v.article.AR_Ref));
    } catch (err) {
      bilan.erreurs.push({ famille: code, message: `création : ${err.message}` });
    }
  }

  for (const { famille, variantes } of plan.ajouts) {
    try {
      for (const lot of parLots(variantes, MAX_VARIANTES_PAR_APPEL)) {
        const { data } = await client.requete(BULK_CREATE, { produitId: famille.produitId, variantes: versNouvellesVariantes(lot, { optionNom: famille.optionNom, locationId }) });
        verifier(data);
        bilan.variantesAjoutees.push(...lot.map((v) => v.article.AR_Ref));
      }
    } catch (err) {
      bilan.erreurs.push({ famille: famille.code, message: `ajout de variantes : ${err.message}` });
    }
  }

  for (const { famille, variantes } of plan.majs) {
    try {
      for (const lot of parLots(variantes, MAX_VARIANTES_PAR_APPEL)) {
        const { data } = await client.requete(BULK_UPDATE, { produitId: famille.produitId, variantes: versMisesAJour(lot, { optionNom: famille.optionNom }) });
        verifier(data);
        bilan.variantesMisesAJour.push(...lot.map((v) => v.article.AR_Ref));
      }
    } catch (err) {
      bilan.erreurs.push({ famille: famille.code, message: `mise à jour : ${err.message}` });
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
