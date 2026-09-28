// Intégrateur A — zone tampon : dépose la commande dans la base SODICO_CONNECTEUR (tables CMD_ENTETE / CMD_LIGNE).
// Un outil côté Sage les intègre ensuite. Le connecteur n'écrit jamais dans la base Sage.

import sql from 'mssql/msnodesqlv8.js';

const CONNEXION_DEFAUT =
  'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=SODICO_CONNECTEUR;Trusted_Connection=yes;TrustServerCertificate=yes;';

export function creerIntegrateurTampon() {
  let pool;

  return {
    nom: 'zone tampon (SODICO_CONNECTEUR)',

    async ouvrir() {
      // Pool dédié : ne pas partager le pool global utilisé pour lire Sage.
      pool = await new sql.ConnectionPool({ connectionString: process.env.COMMANDES_SQL_CONNECTION || CONNEXION_DEFAUT }).connect();
      const { recordset } = await pool.request().query(
        `SELECT COUNT(*) AS n FROM sys.tables WHERE name IN ('CMD_ENTETE', 'CMD_LIGNE')`,
      );
      if (recordset[0].n !== 2) throw new Error('Tables de la zone tampon absentes : exécuter sql/tampon-commandes.sql');
    },

    /**
     * Dépose une commande (idempotent : une commande déjà déposée n'est pas dupliquée).
     * @param {import('../preparation.js').CommandeSage} c
     * @returns {Promise<{ deja: boolean, reference: string }>}
     */
    async deposer(c) {
      const existante = await pool.request().input('sid', sql.NVarChar(64), c.shopifyId)
        .query('SELECT id FROM dbo.CMD_ENTETE WHERE shopify_id = @sid');
      if (existante.recordset.length) return { deja: true, reference: `tampon #${existante.recordset[0].id}` };

      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const l = c.livraison ?? {};
        const { recordset } = await new sql.Request(transaction)
          .input('shopify_id', sql.NVarChar(64), c.shopifyId)
          .input('numero_shopify', sql.NVarChar(32), c.numeroShopify)
          .input('date_commande', sql.DateTime2(0), c.date)
          .input('ct_num', sql.VarChar(17), c.ctNum)
          .input('client_nom', sql.NVarChar(255), c.client.nom)
          .input('client_email', sql.NVarChar(255), c.client.email)
          .input('reference_client', sql.NVarChar(255), c.client.referenceClient)
          .input('livraison_nom', sql.NVarChar(255), l.nom ?? null)
          .input('livraison_societe', sql.NVarChar(255), l.societe ?? null)
          .input('livraison_adresse1', sql.NVarChar(255), l.adresse1 ?? null)
          .input('livraison_adresse2', sql.NVarChar(255), l.adresse2 ?? null)
          .input('livraison_cp', sql.NVarChar(20), l.codePostal ?? null)
          .input('livraison_ville', sql.NVarChar(255), l.ville ?? null)
          .input('livraison_pays', sql.Char(2), l.pays ?? null)
          .input('livraison_telephone', sql.NVarChar(50), l.telephone ?? null)
          .input('devise', sql.Char(3), c.totaux.devise)
          .input('prix_ttc', sql.Bit, c.totaux.prixTtc)
          .input('total_ht', sql.Decimal(24, 6), c.totaux.ht)
          .input('total_taxes', sql.Decimal(24, 6), c.totaux.taxes)
          .input('total_ttc', sql.Decimal(24, 6), c.totaux.ttc)
          .input('statut_paiement', sql.NVarChar(32), c.statutPaiement)
          .input('note', sql.NVarChar(sql.MAX), c.note)
          .input('statut', sql.VarChar(12), c.statut)
          .input('message', sql.NVarChar(sql.MAX), c.messages.join(' ; ') || null)
          // OUTPUT ... INTO (et non OUTPUT seul) : fonctionne même si un trigger est ajouté sur la table côté Sage.
          .query(`
            DECLARE @ids TABLE (id INT);
            INSERT INTO dbo.CMD_ENTETE (shopify_id, numero_shopify, date_commande, ct_num, client_nom, client_email, reference_client,
              livraison_nom, livraison_societe, livraison_adresse1, livraison_adresse2, livraison_cp, livraison_ville, livraison_pays,
              livraison_telephone, devise, prix_ttc, total_ht, total_taxes, total_ttc, statut_paiement, note, statut, message)
            OUTPUT INSERTED.id INTO @ids
            VALUES (@shopify_id, @numero_shopify, @date_commande, @ct_num, @client_nom, @client_email, @reference_client,
              @livraison_nom, @livraison_societe, @livraison_adresse1, @livraison_adresse2, @livraison_cp, @livraison_ville, @livraison_pays,
              @livraison_telephone, @devise, @prix_ttc, @total_ht, @total_taxes, @total_ttc, @statut_paiement, @note, @statut, @message);
            SELECT id FROM @ids;`);
        const id = recordset[0].id;

        for (const ligne of c.lignes) {
          await new sql.Request(transaction)
            .input('entete_id', sql.Int, id)
            .input('numero_ligne', sql.Int, ligne.numero)
            .input('ar_ref', sql.VarChar(19), ligne.arRef)
            .input('designation', sql.NVarChar(255), ligne.designation)
            .input('quantite', sql.Decimal(18, 3), ligne.quantite)
            .input('prix_unitaire', sql.Decimal(24, 6), ligne.prixUnitaire)
            .input('montant', sql.Decimal(24, 6), ligne.montant)
            .query(`INSERT INTO dbo.CMD_LIGNE (entete_id, numero_ligne, ar_ref, designation, quantite, prix_unitaire, montant)
                    VALUES (@entete_id, @numero_ligne, @ar_ref, @designation, @quantite, @prix_unitaire, @montant)`);
        }
        await transaction.commit();
        return { deja: false, reference: `tampon #${id}` };
      } catch (err) {
        await transaction.rollback().catch(() => {});
        throw err;
      }
    },

    async fermer() {
      await pool?.close();
    },
  };
}
