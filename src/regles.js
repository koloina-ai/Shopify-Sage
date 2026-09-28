// Règles de protection de la boutique Shopify (fonctions pures, testées par npm test).
// Principe : le connecteur ne touche qu'aux produits qu'il a créés, et sur ces produits qu'aux champs qu'il gère.
// Tout ce que SODICO ajoute dans Shopify (photos, description, SEO, étiquettes, champs personnalisés, prix barré,
// produit masqué à la main) est conservé.

export const ETIQUETTE_CONNECTEUR = 'sage'; // posée sur tous les produits créés par le connecteur
export const ETIQUETTE_IGNORER = 'sage-ignorer'; // posée par SODICO : le connecteur ne touche plus du tout au produit
export const ETIQUETTE_RETIRE = 'sage-retire'; // posée par le connecteur quand IL retire un produit de la vente
const ETIQUETTES_SPECIALES = new Set([ETIQUETTE_CONNECTEUR, ETIQUETTE_IGNORER, ETIQUETTE_RETIRE]);

export const handleArticle = (ref) => `sage-${ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** Le produit a-t-il été créé par le connecteur ? (adresse sage-… et référence Sage enregistrée identique au SKU) */
export const estProduitConnecteur = (p) => p.handle.startsWith('sage-') && Boolean(p.arRef) && p.arRef === p.sku;

/** Étiquettes gérées par le connecteur pour un article Sage. */
export const etiquettesGerees = (article) =>
  [...new Set([ETIQUETTE_CONNECTEUR, article.FA_CodeFamille, article.AR_Stat04].map((e) => e?.trim()).filter(Boolean))];

/**
 * Étiquettes à ajouter / retirer, sans jamais toucher à celles ajoutées par SODICO.
 * @param {string[]} actuelles         étiquettes du produit dans Shopify
 * @param {string[]|null} anciennes     étiquettes posées par le connecteur au passage précédent (null si inconnues)
 * @param {string[]} nouvelles          étiquettes que le connecteur veut maintenant
 */
export function fusionEtiquettes(actuelles, anciennes, nouvelles) {
  const present = new Set(actuelles);
  const voulues = new Set(nouvelles);
  return {
    ajouter: nouvelles.filter((e) => !present.has(e)),
    // Seules les étiquettes que le connecteur avait lui-même posées peuvent être retirées
    retirer: (anciennes ?? []).filter((e) => present.has(e) && !voulues.has(e) && !ETIQUETTES_SPECIALES.has(e)),
  };
}

/**
 * Garde-fou prix : une variation trop forte d'un coup (faute de frappe dans Sage…) n'est pas appliquée.
 * @param {number|null} ancien   prix actuel dans Shopify
 * @param {number} nouveau       prix Sage
 * @param {number} variationMax  ex. 0.5 = ±50 % ; 0 = garde-fou désactivé
 */
export function controlePrix(ancien, nouveau, variationMax) {
  if (!variationMax || !(ancien > 0)) return { appliquer: true, variation: null };
  const variation = (nouveau - ancien) / ancien;
  return { appliquer: Math.abs(variation) <= variationMax, variation };
}

/**
 * Garde-fou stocks : trop de produits qui tombent à 0 d'un coup = probablement une anomalie côté Sage
 * (table de stock vide, mauvaise base…). Renvoie les mises à zéro à bloquer ([] si rien d'anormal).
 * @param {{ disponible: number|null, sage: number }[]} ecarts
 * @param {number} nbProduits  produits suivis en stock dans Shopify
 */
export function misesAZeroSuspectes(ecarts, nbProduits, { partMax = 0.2, toujoursOk = 5 } = {}) {
  const aZero = ecarts.filter((e) => e.sage === 0 && e.disponible > 0);
  const limite = Math.max(toujoursOk, Math.floor(nbProduits * partMax));
  return aZero.length > limite ? aZero : [];
}

/** Lecture de l'étiquetage enregistré par le connecteur (metafield sage.etiquettes, JSON). */
export function lireEtiquettesEnregistrees(valeur) {
  try {
    const liste = JSON.parse(valeur);
    return Array.isArray(liste) ? liste.map(String) : null;
  } catch {
    return null;
  }
}
