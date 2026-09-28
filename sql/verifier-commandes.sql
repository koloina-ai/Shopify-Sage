-- Vérifier les commandes Shopify déposées dans la zone tampon (à ouvrir dans SSMS, exécuter bloc par bloc).
-- Base Sage de test : SODICO_TEST (adapter le nom en production).
USE SODICO_CONNECTEUR;

-- =====================================================================
-- 1. Vue d'ensemble : combien de commandes par statut
-- =====================================================================
SELECT statut, COUNT(*) AS nombre, SUM(total_ttc) AS montant_total, MAX(date_depot) AS dernier_depot
FROM dbo.CMD_ENTETE
GROUP BY statut;


-- =====================================================================
-- 2. Toutes les commandes, les plus récentes d'abord
-- =====================================================================
SELECT e.id, e.numero_shopify, e.date_commande, e.statut, e.ct_num, e.client_nom,
       e.reference_client, e.total_ht, e.total_ttc, e.devise,
       (SELECT COUNT(*) FROM dbo.CMD_LIGNE l WHERE l.entete_id = e.id) AS nb_lignes,
       e.piece_sage, e.message, e.date_depot
FROM dbo.CMD_ENTETE e
ORDER BY e.date_depot DESC;


-- =====================================================================
-- 3. Commandes à vérifier (bloquées) et pourquoi
-- =====================================================================
SELECT e.numero_shopify, e.date_commande, e.ct_num, e.reference_client, e.total_ttc, e.message AS raison
FROM dbo.CMD_ENTETE e
WHERE e.statut = 'A_VERIFIER'
ORDER BY e.date_commande DESC;


-- =====================================================================
-- 4. Commandes prêtes pour Sage, avec leurs lignes et le contrôle dans Sage
--    (client et article retrouvés dans la base Sage : désignations Sage à côté de celles de Shopify)
-- =====================================================================
SELECT e.numero_shopify, e.ct_num, c.CT_Intitule AS client_sage,
       l.numero_ligne, l.ar_ref, a.AR_Design AS designation_sage, l.designation AS designation_shopify,
       l.quantite, l.prix_unitaire, l.montant,
       a.AR_PrixVen AS prix_sage_actuel,
       CASE WHEN a.AR_Ref IS NULL THEN 'ARTICLE INCONNU' WHEN c.CT_Num IS NULL THEN 'CLIENT INCONNU' ELSE 'OK' END AS controle
FROM dbo.CMD_ENTETE e
JOIN dbo.CMD_LIGNE l ON l.entete_id = e.id
LEFT JOIN SODICO_TEST.dbo.F_COMPTET c ON c.CT_Num = e.ct_num
LEFT JOIN SODICO_TEST.dbo.F_ARTICLE a ON a.AR_Ref = l.ar_ref
WHERE e.statut = 'A_INTEGRER'
ORDER BY e.date_commande, l.numero_ligne;


-- =====================================================================
-- 5. Le détail d'une commande précise (remplacer #1004)
-- =====================================================================
DECLARE @commande NVARCHAR(32) = '#1004';

SELECT * FROM dbo.CMD_ENTETE WHERE numero_shopify = @commande;

SELECT l.numero_ligne, l.ar_ref, l.designation, l.quantite, l.prix_unitaire, l.montant
FROM dbo.CMD_LIGNE l
JOIN dbo.CMD_ENTETE e ON e.id = l.entete_id
WHERE e.numero_shopify = @commande
ORDER BY l.numero_ligne;


-- =====================================================================
-- 6. Contrôle de cohérence : total de l'en-tête = somme des lignes
--    (un écart peut venir des frais de port ou d'une remise globale Shopify)
-- =====================================================================
SELECT e.numero_shopify, e.total_ht AS total_entete, SUM(l.montant) AS somme_lignes,
       e.total_ht - SUM(l.montant) AS ecart
FROM dbo.CMD_ENTETE e
JOIN dbo.CMD_LIGNE l ON l.entete_id = e.id
GROUP BY e.numero_shopify, e.total_ht
HAVING ABS(e.total_ht - SUM(l.montant)) > 0.01;


-- =====================================================================
-- 7. (Côté Sage, pour tester) marquer une commande comme intégrée
--    C'est ce que fera l'outil d'intégration de M2I ; à exécuter seulement pour un test.
-- =====================================================================
-- UPDATE dbo.CMD_ENTETE
-- SET statut = 'INTEGREE', piece_sage = 'BC00001', date_integration = SYSDATETIME()
-- WHERE numero_shopify = '#1004';
