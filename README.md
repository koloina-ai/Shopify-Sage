# Connecteur Sage 100 ↔ Shopify (SODICO)

Node.js 22+. Lit Sage 100 (SQL Server, lecture seule) et parle à Shopify via l'Admin GraphQL API (2026-07).

## Configuration

Variables lues dans `.env` puis `../env.local` :

| Variable | Rôle |
|---|---|
| `SHOPIFY_STORE_URL` | domaine de la boutique |
| `SHOPIFY_STORE_API_TOKEN` | token Admin API `shpat_…` |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | alternative au token (app Dev Dashboard) |
| `SHOPIFY_API_VERSION` | défaut `2026-07` |
| `SHOPIFY_LOCATION_ID` | emplacement de stock (défaut : le plus ancien de la boutique) |
| `SAGE_SQL_CONNECTION` | chaîne ODBC (défaut : `localhost`, base `SODICO_TEST`, authentification Windows) |

Scopes Shopify utilisés : `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`, `read_all_orders`.

## Commandes

```bash
npm install
npm run synchro -- --poc           # 1re fois : fixe le périmètre (poc ou --tout), puis produits + stocks
npm run synchro                    # ensuite : produits (modifiés + absents de Shopify) puis stocks
npm run produits -- --poc          # envoie les produits « prêts POC » (prix + stock + EAN valide)
npm run produits                   # incrémental : modifiés dans Sage depuis la dernière synchro + absents de Shopify
npm run produits -- --ref 03520224 # un article précis
npm run produits -- --simulation   # affiche ce qui serait envoyé, sans rien envoyer
npm run stocks                     # stocks : compare Sage et Shopify, n'envoie que les différences
npm run stocks -- --simulation     # affiche les écarts de stock sans rien envoyer
npm run verifier                   # compare Shopify et Sage (SKU, code-barre, prix, stock)
npm run commandes -- --limite 10   # récupère les commandes Shopify
```

## Règles de correspondance

- Article publiable = `AR_Sommeil = 0`, `AR_Publie = 1`, `AR_PrixVen > 0`.
- Produit Shopify retrouvé par son handle `sage-<AR_Ref>` : relancer ne crée pas de doublon.
- SKU = `AR_Ref`, code-barre = `AR_CodeBarre`, prix = `AR_PrixVen` (HT), type = `AR_Stat02`,
  tags = `sage`, famille, `AR_Stat04`, poids = `AR_PoidsBrut` (ou net) selon `AR_UnitePoids`.
- Stock = somme de `STO_DISPO` du dépôt principal (`DP_STOCKS`, `STO_DEPPRINC = 'OUI'`), arrondie à l'entier inférieur.
- Incrémental sur `F_ARTICLE.cbModification`, plus les articles du périmètre absents de Shopify
  (nouveaux ou supprimés à la main : Sage fait foi). État dans `etat/synchro-produits.json`
  (date + périmètre `poc`/`tout`), mis à jour seulement si la synchro s'est terminée sans erreur.
- La présence dans Shopify est lue via la recherche (`tag:sage`), indexée avec quelques secondes de retard :
  un produit tout juste créé peut ne pas encore y figurer. Sans conséquence (upsert par handle, pas de doublon),
  il est pris en compte au passage suivant.

## Protection de la boutique Shopify

Le connecteur **ne supprime jamais rien**. Il ne modifie que les produits **qu'il a créés** (adresse `sage-<AR_Ref>`,
champ `sage.ar_ref` égal au SKU, une seule variante), et sur ces produits **seulement les champs qu'il gère** :

| Géré par le connecteur (Sage fait foi) | Laissé à SODICO dans Shopify (jamais modifié) |
|---|---|
| titre, fournisseur, type de produit | photos, description, SEO |
| prix, code-barre, poids, SKU | prix barré (promo), politique de vente hors stock |
| stock disponible | étiquettes ajoutées à la main |
| ses étiquettes (`sage`, famille, statistique) | champs personnalisés (hors `sage.*`) |
| ses champs `sage.*` | statut choisi à la main (produit masqué) |

- La création utilise `productSet`. Les mises à jour utilisent `productUpdate`, `productVariantsBulkUpdate`, `metafieldsSet`
  et `tagsAdd`/`tagsRemove`, jamais un remplacement complet. Avant une création, on vérifie directement que l'adresse est libre.
- **`sage-ignorer`** : étiquette posée par SODICO sur un produit. Le connecteur n'y touche plus (ni mise à jour, ni stock, ni retrait).
- **Retrait** : produit en brouillon et marqué `sage-retire`. Seuls ces produits sont remis en vente automatiquement :
  un produit masqué à la main reste masqué.
- **Garde-fou prix** : une variation de plus de `PRIX_VARIATION_MAX` (50 % par défaut, 0 = désactivé) n'est pas appliquée,
  mais signalée (journal, page, résumé). `--forcer-prix` l'applique. Corriger le prix dans Sage le fait repartir normalement.
- **Garde-fou stocks** : si plus de 20 % des produits (et plus de 5) tombent à 0 d'un coup, ces mises à zéro sont bloquées,
  les autres appliquées, et une alerte part. `--forcer-stocks` les applique. Un article sans ligne de stock n'est jamais mis à 0.
- **Garde-fou retrait** : pas plus de 20 % des produits retirés d'un coup (`--forcer-retrait`).
- `PRODUITS_STATUT_CREATION=DRAFT` crée les nouveaux produits en brouillon, pour relecture avant publication
  (conseillé pour la première synchro du catalogue complet).
- `npm test` : 18 tests automatiques des règles de protection et de conversion (sans Shopify ni Sage).

## Retrait des produits

À chaque synchro (hors `--ref`), un produit actif dans Shopify dont l'article n'est plus éligible dans Sage
(sommeil, décoché « publié », sans prix, supprimé, ou sorti du périmètre POC) passe en **brouillon** :
il disparaît de la boutique sans être supprimé. Il redevient actif dès qu'il est de nouveau éligible.
Garde-fou : si plus de 20 % des produits actifs (et plus de 5) seraient retirés d'un coup, rien n'est retiré
et la synchro se termine en échec ; `--forcer-retrait` lève la limite.

## Alertes e-mail et résumé quotidien

Variables `SMTP_*`, `ALERTE_A` (voir `.env.example`) ; sans elles, rien n'est envoyé.

- `npm run synchro` envoie un e-mail à la première panne (diagnostic en clair + action), un rappel toutes les
  `RAPPEL_HEURES` h tant qu'elle dure, et un e-mail au rétablissement. État dans `etat/alertes.json`. Pas d'alerte en `--simulation`.
- `npm run resume` (à planifier chaque matin) : synchros des dernières 24 h (`--heures N`), changements envoyés,
  articles publiés dans Sage mais pas en ligne avec la raison et quoi corriger (CSV joint). `--afficher` : terminal, sans e-mail.
- `SMTP_HOST=fichier` : mode test, les e-mails sont écrits dans `sortie/emails/*.eml`.

## Page de suivi

`npm run interface` démarre une page web (serveur `node:http`, sans dépendance) pour les utilisateurs non techniques :
état 🟢/🔴/🟠/🔄 avec diagnostic en clair, bouton « Synchroniser maintenant » (lance `cli-synchro.js`, comme la tâche
planifiée), changements 24 h, historique 48 h, articles bloqués (recherche + export CSV).

- Par défaut sur `http://localhost:3000` uniquement. `INTERFACE_HOTE=0.0.0.0` + `INTERFACE_MOT_DE_PASSE` (Basic Auth) pour le réseau local.
- API : `GET /api/etat`, `/api/historique?heures=48`, `/api/changements?heures=24`, `/api/bloques`, `/api/bloques.csv`,
  `POST /api/synchro` (en-tête `X-Connecteur: 1` requis ; 409 si une synchro tourne).
- Verrou `etat/synchro.lock` : une seule synchro à la fois, quelle que soit l'origine (tâche, bouton, terminal).
  Un verrou d'un processus mort ou de plus de 30 min est ignoré.

## Commandes Shopify → Sage

3e étape de `npm run synchro` (ou `npm run commandes-sage -- [--simulation]`), pilotée par `COMMANDES_MODE` :

| Mode | Effet |
|---|---|
| `off` (défaut) | étape désactivée |
| `tampon` | **option A** : dépôt dans la base séparée `SODICO_CONNECTEUR` (tables `CMD_ENTETE` / `CMD_LIGNE`, script `sql/tampon-commandes.sql`). Un outil côté Sage intègre les lignes `A_INTEGRER` et renseigne `statut`, `piece_sage`, `date_integration` |
| `objets-metiers` | **option B** : création directe du bon de commande dans Sage via les Objets Métiers (pont PowerShell `src/commandes-sage/objets-metiers/pont.ps1`, réglages `OM_*`). `OM_SIMULATION=oui` teste toute la chaîne sans Sage |

**Basculer** : `npm run commandes-mode` affiche le mode et vérifie que chaque mode est prêt.
`npm run commandes-mode -- tampon | objets-metiers | off` bascule, seulement si le mode visé est prêt (`--forcer` sinon),
en ne modifiant que la ligne `COMMANDES_MODE` du `.env`, et prévient s'il reste des commandes non intégrées dans la zone tampon.
Les deux options utilisent la même étiquette `sage-transmise` : une commande transmise par l'une n'est jamais reprise par l'autre.

**Option B, spécificités** :
- Le pont est lancé une fois par synchro, en PowerShell 32 bits par défaut (`OM_ARCHITECTURE=64` sinon). Une commande par requête JSON.
- Anti-doublon : avant création, lecture de `F_DOCENTETE` (bon de commande `DO_Type = 1` avec `DO_Ref = WEB<n°>` pour ce client).
- Une commande « à vérifier » n'est pas créée dans Sage : elle reçoit l'étiquette `sage-a-verifier`.
  Après correction (client créé dans Sage…), retirer l'étiquette dans l'admin Shopify et elle repart au passage suivant.
- ⚠ Pas encore testé contre de vrais Objets Métiers : ils ne sont pas installés sur le poste de développement.
  À valider sur une société de test Sage (noms des objets selon la version installée).

- Commandes reprises : non annulées, sans l'étiquette `sage-transmise` (posée après dépôt, d'où le scope `write_orders`).
- Vérifications dans Sage (lecture seule) : client `CT_Num` (identifiant externe de l'entreprise B2B, ou `COMMANDES_CLIENT_PAR_DEFAUT`)
  et articles `AR_Ref` (SKU). Sinon la commande est déposée en `A_VERIFIER`, avec la raison dans `message`. Un code trop long n'est jamais tronqué.
- **Robustesse** : étape en dernier, dans son propre processus. Chaque commande est traitée isolément : une commande en erreur
  n'est pas marquée et elle est retentée au passage suivant. Le dépôt est idempotent (`shopify_id` unique), donc pas de doublon.
- Changer d'intégrateur : écrire `integrateurs/<nom>.js` (`ouvrir`, `deposer(commande) -> { deja, reference }`, `fermer`)
  et l'ajouter dans `commandes-sage/index.js`.

## Sécurité

- **Sage** : requêtes SQL paramétrées uniquement, lecture seule (prévoir un compte `db_datareader` en production).
- **Shopify** : adresse limitée à `*.myshopify.com` (le token ne part pas ailleurs), délai de 30 s par appel avec
  nouvelles tentatives (mutations idempotentes), aucun secret écrit dans les journaux ou rapports.
- **Page de suivi** :
  - noms d'hôte autorisés (localhost, nom et IP du serveur, `INTERFACE_NOMS`), contre le DNS rebinding ;
  - mot de passe obligatoire si ouverte au réseau, et blocage de 5 min après 5 échecs ;
  - CSP stricte (seul le script de la page, identifié par son empreinte), `X-Frame-Options: DENY`,
    en-tête `X-Connecteur` requis pour lancer une synchro ;
  - affichage sans `innerHTML`, et messages d'erreur internes non renvoyés au navigateur.
- **Exports Excel** : les cellules commençant par `= + - @` sont neutralisées (pas d'exécution de formule).
- **Limite connue** : la page est en HTTP. Sur le réseau, le mot de passe circule en clair. Pour du HTTPS, passer
  par un proxy (IIS, Caddy…) ou limiter l'accès au pare-feu aux postes concernés.

## Journal et planification

`npm run synchro` écrit tout dans `logs/synchro-AAAA-MM-JJ.log` (horodaté, `ERR` pour les erreurs) et supprime
journaux et rapports de plus de `JOURS_CONSERVATION` jours (30 par défaut). Installation de la tâche toutes les
15 minutes : voir [PLANIFICATION.md](PLANIFICATION.md).

## Stocks

Une variation de stock seule ne change pas `cbModification` : `npm run produits` ne la voit pas.
`npm run stocks` compare donc, à chaque passage, le disponible Sage au disponible Shopify de tous les produits `tag:sage`
et n'envoie que les écarts. L'envoi passe la quantité lue (`changeFromQuantity`) : si le stock Shopify a bougé
entre-temps (commande), Shopify refuse la mise à jour au lieu de l'écraser ; le passage suivant la reprend.

## Limites connues

- Pas encore gérés : gammes (variantes), conditionnements, prix par catégorie tarifaire (`F_ARTCLIENT`), clients B2B, photos.
- Un produit passé à la main en brouillon dans Shopify est remis en vente s'il est éligible dans Sage (Sage fait foi).


USE SODICO_TEST;

SELECT a.AR_Ref          AS reference_sku,
       a.AR_Design       AS titre,
       a.AR_PrixVen      AS prix_ht,
       a.AR_CodeBarre    AS code_barre,
       a.AR_Stat02       AS type_produit,
       a.FA_CodeFamille  AS famille,
       a.AR_PoidsBrut    AS poids,
       s.STO_DISPO       AS stock_disponible,
       a.cbModification  AS derniere_modification
FROM dbo.F_ARTICLE a
LEFT JOIN dbo.DP_STOCKS s ON s.STO_ART_NUM = a.AR_Ref AND s.STO_DEPPRINC = 'OUI'
WHERE a.AR_Ref = '03520224';

-- Prix et titre : toujours mettre cbModification = GETDATE(), sinon la synchro ne voit rien
UPDATE dbo.F_ARTICLE
SET AR_PrixVen     = 12.50,
    AR_Design      = 'TENDEUR GALVA 120x60x50 - TEST',
    cbModification = GETDATE()
WHERE AR_Ref = '03520224';

-- Stock : pas de date à changer
UPDATE dbo.DP_STOCKS
SET STO_DISPO = 10
WHERE STO_ART_NUM = '03520224' AND STO_DEPPRINC = 'OUI';


-- Regarder ce qui va remonter
WITH stock AS (
    SELECT STO_ART_NUM, SUM(STO_DISPO) AS stock_dispo
    FROM dbo.DP_STOCKS
    WHERE STO_DEPPRINC = 'OUI'
    GROUP BY STO_ART_NUM
),
ean AS (  -- clé de contrôle du code-barre EAN-13
    SELECT a.AR_Ref,
           (10 - SUM(TRY_CAST(SUBSTRING(a.AR_CodeBarre, v.n, 1) AS INT) * CASE WHEN v.n % 2 = 0 THEN 3 ELSE 1 END) % 10) % 10 AS cle
    FROM dbo.F_ARTICLE a
    CROSS JOIN (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) v(n)
    WHERE a.AR_CodeBarre LIKE REPLICATE('[0-9]', 13)
    GROUP BY a.AR_Ref
),
controle AS (
    SELECT a.AR_Ref, a.AR_Design, a.AR_PrixVen, a.AR_CodeBarre, s.stock_dispo, a.cbModification,
           CASE WHEN a.AR_Sommeil = 0 THEN 1 ELSE 0 END                AS ok_actif,
           CASE WHEN a.AR_Publie = 1 THEN 1 ELSE 0 END                 AS ok_publie,
           CASE WHEN a.AR_PrixVen > 0 THEN 1 ELSE 0 END                AS ok_prix,
           CASE WHEN LEN(LTRIM(a.AR_Design)) >= 4 THEN 1 ELSE 0 END    AS ok_titre,
           CASE WHEN s.stock_dispo IS NOT NULL THEN 1 ELSE 0 END       AS ok_stock,
           CASE WHEN e.cle = TRY_CAST(RIGHT(a.AR_CodeBarre, 1) AS INT) THEN 1 ELSE 0 END AS ok_ean
    FROM dbo.F_ARTICLE a
    LEFT JOIN stock s ON s.STO_ART_NUM = a.AR_Ref
    LEFT JOIN ean e ON e.AR_Ref = a.AR_Ref
)
SELECT AR_Ref AS reference_sku, AR_Design AS titre, AR_PrixVen AS prix_ht, AR_CodeBarre AS code_barre,
       stock_dispo, cbModification,
       ok_actif, ok_publie, ok_prix, ok_titre, ok_stock, ok_ean,
       CASE WHEN ok_actif & ok_publie & ok_prix & ok_titre & ok_stock & ok_ean = 1 THEN 1 ELSE 0 END AS peut_remonter
FROM controle
WHERE ok_actif = 1 AND ok_publie = 1
ORDER BY peut_remonter DESC, AR_Ref;