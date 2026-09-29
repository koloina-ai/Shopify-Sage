// Règles de protection de la boutique Shopify (fonctions pures, testées par npm test).
// Principe : le connecteur ne touche qu'aux familles qu'il a créées, et sur leurs variantes qu'aux champs qu'il gère
// (prix, code-barre, désignation non renommée, stock). Tout ce que SODICO fait dans Shopify est conservé.

export const ETIQUETTE_CONNECTEUR = 'sage'; // posée sur tous les produits créés par le connecteur
export const ETIQUETTE_IGNORER = 'sage-ignorer'; // posée par SODICO : le connecteur ne touche plus du tout au produit

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
