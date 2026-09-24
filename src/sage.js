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
