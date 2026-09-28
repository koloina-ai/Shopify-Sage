-- Zone tampon des commandes Shopify -> Sage (option A).
-- Base SÉPARÉE de Sage : le connecteur n'écrit que ici, jamais dans les tables Sage.
-- Un outil côté Sage (import, routine M2I, ou plus tard les Objets Métiers) lit les commandes
-- au statut 'A_INTEGRER', les crée dans Sage, puis met à jour statut / piece_sage / date_integration.
--
-- Exécution : sqlcmd -S <serveur> -E -i tampon-commandes.sql -f 65001
-- Droits du compte du connecteur sur cette base : SELECT, INSERT, UPDATE (db_datareader + db_datawriter).

IF DB_ID('SODICO_CONNECTEUR') IS NULL CREATE DATABASE SODICO_CONNECTEUR COLLATE French_CI_AS;
GO
USE SODICO_CONNECTEUR;
GO

IF OBJECT_ID('dbo.CMD_ENTETE', 'U') IS NULL
CREATE TABLE dbo.CMD_ENTETE (
    id                INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_CMD_ENTETE PRIMARY KEY,
    shopify_id        NVARCHAR(64)   NOT NULL CONSTRAINT UX_CMD_ENTETE_SHOPIFY UNIQUE,  -- une commande n'est déposée qu'une fois
    numero_shopify    NVARCHAR(32)   NOT NULL,           -- ex. #1002 (à reporter en référence de la pièce Sage)
    date_commande     DATETIME2(0)   NOT NULL,
    ct_num            VARCHAR(17)    NULL,               -- client Sage (F_COMPTET.CT_Num)
    client_nom        NVARCHAR(255)  NULL,
    client_email      NVARCHAR(255)  NULL,
    reference_client  NVARCHAR(255)  NULL,               -- n° de bon de commande saisi par le client B2B
    livraison_nom     NVARCHAR(255)  NULL,
    livraison_societe NVARCHAR(255)  NULL,
    livraison_adresse1 NVARCHAR(255) NULL,
    livraison_adresse2 NVARCHAR(255) NULL,
    livraison_cp      NVARCHAR(20)   NULL,
    livraison_ville   NVARCHAR(255)  NULL,
    livraison_pays    CHAR(2)        NULL,
    livraison_telephone NVARCHAR(50) NULL,
    devise            CHAR(3)        NOT NULL,
    prix_ttc          BIT            NOT NULL,           -- 1 si les prix Shopify incluent les taxes
    total_ht          DECIMAL(24, 6) NOT NULL,
    total_taxes       DECIMAL(24, 6) NOT NULL,
    total_ttc         DECIMAL(24, 6) NOT NULL,
    statut_paiement   NVARCHAR(32)   NULL,
    note              NVARCHAR(MAX)  NULL,
    -- A_INTEGRER : prête pour Sage · A_VERIFIER : incomplète (voir message), à traiter à la main
    -- INTEGREE : créée dans Sage (piece_sage renseignée) · ERREUR : échec de l'intégration côté Sage
    statut            VARCHAR(12)    NOT NULL CONSTRAINT CK_CMD_ENTETE_STATUT
                          CHECK (statut IN ('A_INTEGRER', 'A_VERIFIER', 'INTEGREE', 'ERREUR')),
    message           NVARCHAR(MAX)  NULL,
    piece_sage        VARCHAR(13)    NULL,               -- n° de pièce Sage une fois intégrée
    date_depot        DATETIME2(0)   NOT NULL CONSTRAINT DF_CMD_ENTETE_DEPOT DEFAULT SYSDATETIME(),
    date_integration  DATETIME2(0)   NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CMD_ENTETE_STATUT')
    CREATE INDEX IX_CMD_ENTETE_STATUT ON dbo.CMD_ENTETE (statut, date_commande);
GO

IF OBJECT_ID('dbo.CMD_LIGNE', 'U') IS NULL
CREATE TABLE dbo.CMD_LIGNE (
    id                INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_CMD_LIGNE PRIMARY KEY,
    entete_id         INT            NOT NULL CONSTRAINT FK_CMD_LIGNE_ENTETE REFERENCES dbo.CMD_ENTETE (id),
    numero_ligne      INT            NOT NULL,
    ar_ref            VARCHAR(19)    NULL,               -- article Sage (F_ARTICLE.AR_Ref) = SKU Shopify
    designation       NVARCHAR(255)  NOT NULL,
    quantite          DECIMAL(18, 3) NOT NULL,
    prix_unitaire     DECIMAL(24, 6) NOT NULL,           -- prix unitaire Shopify après remises (HT si prix_ttc = 0)
    montant           DECIMAL(24, 6) NOT NULL,           -- quantité x prix unitaire, après remises
    CONSTRAINT UX_CMD_LIGNE UNIQUE (entete_id, numero_ligne)
);
GO
