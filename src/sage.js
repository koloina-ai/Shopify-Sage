// Lecture des données Sage 100 (SQL Server), en lecture seule.

import sql from 'mssql/msnodesqlv8.js';
import { chaineConnexionSage } from './config.js';

export async function connecterSage() {
  return sql.connect({ connectionString: chaineConnexionSage() });
}

/** Dépôts dont le stock est additionné : STOCK_DEPOTS (intitulés séparés par des virgules), par défaut « Magasin SODICO ». */
export const depotsStock = () =>
  (process.env.STOCK_DEPOTS || 'Magasin SODICO').split(',').map((d) => d.trim()).filter(Boolean);

/** Familles synchronisées : CATALOGUE_FAMILLES (codes séparés par des virgules, ou * pour toutes). */
export const famillesCatalogue = () =>
  (process.env.CATALOGUE_FAMILLES || '').split(',').map((f) => f.trim()).filter(Boolean);

function filtreFamilles(req, familles) {
  if (familles.includes('*')) return '1 = 1';
  familles.forEach((f, i) => req.input(`fam${i}`, sql.VarChar(11), f));
  return `a.FA_CodeFamille IN (${familles.map((_, i) => `@fam${i}`).join(', ')})`;
}

function filtreDepots(req, depots) {
  depots.forEach((d, i) => req.input(`dep${i}`, sql.VarChar(35), d));
  return `STO_DEP IN (${depots.map((_, i) => `@dep${i}`).join(', ')})`;
}

/**
 * Articles des familles synchronisées, y compris ceux en sommeil (pour mettre leur stock à 0 sur la boutique).
 * stock_dispo : somme du disponible des dépôts choisis ; NULL si l'article n'y a aucune ligne de stock.
 * @param {string[]} familles  codes FA_CodeFamille, ou ['*']
 */
export async function lireArticlesFamilles(pool, familles, depots = depotsStock()) {
  if (!familles.length) throw new Error('Aucune famille à synchroniser : renseigner CATALOGUE_FAMILLES (codes famille Sage, ou *)');
  const req = pool.request();
  const { recordset } = await req.query(`
    SELECT a.AR_Ref, a.AR_Design, ISNULL(a.AR_PrixVen, 0) AS AR_PrixVen, a.AR_CodeBarre, a.FA_CodeFamille, a.AR_Sommeil,
           a.cbModification, s.stock_dispo
    FROM dbo.F_ARTICLE a
    LEFT JOIN (
        SELECT STO_ART_NUM, SUM(STO_DISPO) AS stock_dispo
        FROM dbo.DP_STOCKS
        WHERE ${filtreDepots(req, depots)}
        GROUP BY STO_ART_NUM
    ) s ON s.STO_ART_NUM = a.AR_Ref
    WHERE ${filtreFamilles(req, familles)}
    ORDER BY a.FA_CodeFamille, a.AR_Ref`);
  return recordset;
}

/** Articles actifs des familles synchronisées sans prix de vente : non mis en ligne, à corriger dans Sage. */
export async function articlesBloques(pool, familles) {
  if (!familles.length) return [];
  const req = pool.request();
  const { recordset } = await req.query(`
    SELECT a.AR_Ref, a.AR_Design, a.FA_CodeFamille
    FROM dbo.F_ARTICLE a
    WHERE a.AR_Sommeil = 0 AND ISNULL(a.AR_PrixVen, 0) <= 0 AND ${filtreFamilles(req, familles)}
    ORDER BY a.FA_CodeFamille, a.AR_Ref`);
  return recordset.map((a) => ({
    ref: a.AR_Ref,
    designation: a.AR_Design.trim(),
    raison: "pas de prix de vente",
    famille: a.FA_CodeFamille,
    aCorriger: 'Fiche article → Prix de vente',
  }));
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

/** Stock disponible des dépôts choisis (STOCK_DEPOTS), par référence article. */
export async function lireStocks(pool, depots = depotsStock()) {
  const req = pool.request();
  const { recordset } = await req.query(`
    SELECT STO_ART_NUM, SUM(STO_DISPO) AS stock_dispo
    FROM dbo.DP_STOCKS
    WHERE ${filtreDepots(req, depots)}
    GROUP BY STO_ART_NUM`);
  return new Map(recordset.map((r) => [r.STO_ART_NUM, r.stock_dispo]));
}

/** Clé de contrôle EAN-13 valide. */
export function ean13Valide(code) {
  if (!/^\d{13}$/.test(code ?? '')) return false;
  const somme = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (somme % 10)) % 10 === Number(code[12]);
}
