// Lecture des données Sage 100 (SQL Server), en lecture seule.

import sql from 'mssql/msnodesqlv8.js';
import { chaineConnexionSage } from './config.js';

export async function connecterSage() {
  return sql.connect({ connectionString: chaineConnexionSage() });
}

/**
 * Articles publiables sur Shopify : actifs, cochés « publié sur le site marchand », avec un prix de vente.
 * Le stock est le disponible du dépôt principal (DP_STOCKS) ; NULL si l'article n'a pas de ligne de stock.
 *
 * @param {object} options
 * @param {Date}   [options.depuis]  seulement les articles modifiés après cette date (cbModification)
 * @param {string[]} [options.refs]  seulement ces références
 * @param {boolean} [options.avecStock]  seulement les articles ayant une ligne de stock
 */
export async function lireArticles(pool, { depuis, refs, avecStock } = {}) {
  const req = pool.request();
  const filtres = ['a.AR_Sommeil = 0', 'a.AR_Publie = 1', 'a.AR_PrixVen > 0'];
  if (depuis) {
    req.input('depuis', sql.DateTime, depuis);
    filtres.push('a.cbModification > @depuis');
  }
  if (refs?.length) {
    refs.forEach((r, i) => req.input(`ref${i}`, sql.VarChar(19), r));
    filtres.push(`a.AR_Ref IN (${refs.map((_, i) => `@ref${i}`).join(', ')})`);
  }
  if (avecStock) filtres.push('s.stock_dispo IS NOT NULL');

  const { recordset } = await req.query(`
    SELECT a.AR_Ref, a.AR_Design, a.AR_PrixVen, a.AR_CodeBarre, a.FA_CodeFamille, a.AR_Stat02, a.AR_Stat04,
           a.AR_PoidsBrut, a.AR_PoidsNet, a.AR_UnitePoids, a.AR_SuiviStock, a.cbModification,
           s.stock_dispo
    FROM dbo.F_ARTICLE a
    LEFT JOIN (
        SELECT STO_ART_NUM, SUM(STO_DISPO) AS stock_dispo
        FROM dbo.DP_STOCKS
        WHERE STO_DEPPRINC = 'OUI'
        GROUP BY STO_ART_NUM
    ) s ON s.STO_ART_NUM = a.AR_Ref
    WHERE ${filtres.join(' AND ')}
    ORDER BY a.cbModification, a.AR_Ref`);
  return recordset;
}

/**
 * Pourquoi des articles ne sont plus à publier (pour le journal des retraits).
 * @returns {Map<string, string>} référence -> raison
 */
export async function raisonsRetrait(pool, refs) {
  const raisons = new Map(refs.map((r) => [r, 'supprimé de Sage']));
  for (let i = 0; i < refs.length; i += 500) {
    const lot = refs.slice(i, i + 500);
    const req = pool.request();
    lot.forEach((r, j) => req.input(`r${j}`, sql.VarChar(19), r));
    const { recordset } = await req.query(`
      SELECT a.AR_Ref, a.AR_Sommeil, a.AR_Publie, a.AR_PrixVen, a.AR_Design, a.AR_CodeBarre,
             CASE WHEN EXISTS (SELECT 1 FROM dbo.DP_STOCKS s WHERE s.STO_ART_NUM = a.AR_Ref AND s.STO_DEPPRINC = 'OUI')
                  THEN 1 ELSE 0 END AS a_stock
      FROM dbo.F_ARTICLE a
      WHERE a.AR_Ref IN (${lot.map((_, j) => `@r${j}`).join(', ')})`);
    for (const a of recordset) {
      raisons.set(a.AR_Ref, a.AR_Sommeil !== 0 ? 'mis en sommeil' : a.AR_Publie !== 1 ? 'décoché « publié »' : blocage(a, 'poc')?.raison ?? 'hors périmètre');
    }
  }
  return raisons;
}

/**
 * Pourquoi un article actif et « publié » n'est pas en ligne, et quoi corriger dans Sage. null s'il est publiable.
 * Mêmes règles que la sélection de lireArticles (+ filtre POC de cli-produits).
 * @param {{ AR_PrixVen: number, AR_Design: string, AR_CodeBarre: string, a_stock: number }} a
 */
export function blocage(a, perimetre) {
  if (!(a.AR_PrixVen > 0)) return { raison: 'pas de prix de vente', aCorriger: 'Fiche article → Prix de vente' };
  if (perimetre !== 'poc') return null;
  if (!a.a_stock) return { raison: 'pas de stock au dépôt principal', aCorriger: 'Stock de l\'article au dépôt principal' };
  if (!ean13Valide(a.AR_CodeBarre)) return { raison: 'code-barre invalide', aCorriger: 'Fiche article → Code barre (13 chiffres, clé de contrôle)' };
  if (a.AR_Design.trim().length < 4) return { raison: 'désignation trop courte', aCorriger: 'Fiche article → Désignation' };
  return null;
}

/** Articles actifs et cochés « publié » qui ne sont pas envoyés sur Shopify, avec la raison. */
export async function articlesBloques(pool, perimetre) {
  const { recordset } = await pool.request().query(`
    SELECT a.AR_Ref, a.AR_Design, a.AR_PrixVen, a.AR_CodeBarre,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.DP_STOCKS s WHERE s.STO_ART_NUM = a.AR_Ref AND s.STO_DEPPRINC = 'OUI')
                THEN 1 ELSE 0 END AS a_stock
    FROM dbo.F_ARTICLE a
    WHERE a.AR_Sommeil = 0 AND a.AR_Publie = 1
    ORDER BY a.AR_Ref`);
  return recordset.flatMap((a) => {
    const b = blocage(a, perimetre);
    return b ? [{ ref: a.AR_Ref, designation: a.AR_Design.trim(), ...b }] : [];
  });
}

async function parLots(pool, valeurs, type, requete) {
  const lignes = [];
  const uniques = [...new Set(valeurs.filter(Boolean))];
  for (let i = 0; i < uniques.length; i += 500) {
    const lot = uniques.slice(i, i + 500);
    const req = pool.request();
    lot.forEach((v, j) => req.input(`v${j}`, type, v));
    lignes.push(...(await req.query(requete(lot.map((_, j) => `@v${j}`).join(', ')))).recordset);
  }
  return lignes;
}

/** Articles Sage existants parmi ces références : Map AR_Ref -> { AR_Design, AR_Sommeil }. */
export async function articlesExistants(pool, refs) {
  const lignes = await parLots(pool, refs, sql.VarChar(19), (p) =>
    `SELECT AR_Ref, AR_Design, AR_Sommeil FROM dbo.F_ARTICLE WHERE AR_Ref IN (${p})`);
  return new Map(lignes.map((a) => [a.AR_Ref, a]));
}

/** Clients Sage (CT_Type = 0) parmi ces codes : Map CT_Num -> { CT_Intitule, CT_Sommeil }. */
export async function clientsExistants(pool, codes) {
  const lignes = await parLots(pool, codes, sql.VarChar(17), (p) =>
    `SELECT CT_Num, CT_Intitule, CT_Sommeil FROM dbo.F_COMPTET WHERE CT_Type = 0 AND CT_Num IN (${p})`);
  return new Map(lignes.map((c) => [c.CT_Num, c]));
}

/** Stock disponible du dépôt principal, par référence article. */
export async function lireStocks(pool) {
  const { recordset } = await pool.request().query(`
    SELECT STO_ART_NUM, SUM(STO_DISPO) AS stock_dispo
    FROM dbo.DP_STOCKS
    WHERE STO_DEPPRINC = 'OUI'
    GROUP BY STO_ART_NUM`);
  return new Map(recordset.map((r) => [r.STO_ART_NUM, r.stock_dispo]));
}

/** Clé de contrôle EAN-13 valide. */
export function ean13Valide(code) {
  if (!/^\d{13}$/.test(code ?? '')) return false;
  const somme = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (somme % 10)) % 10 === Number(code[12]);
}
