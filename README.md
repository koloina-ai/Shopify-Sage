# Connecteur Sage 100 ↔ Shopify (SODICO)

Node.js 22+. Lit Sage 100 (SQL Server, lecture seule) et parle à Shopify via l'Admin GraphQL API (2026-07).

## Configuration

Variables lues dans `.env` :

| Variable | Rôle |
|---|---|
| `SHOPIFY_STORE_URL` | domaine de la boutique |
| `SHOPIFY_STORE_API_TOKEN` | token Admin API `shpat_…` |
| `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` | alternative au token (app Dev Dashboard) |
| `SHOPIFY_API_VERSION` | défaut `2026-07` |
| `SHOPIFY_LOCATION_ID` | emplacement de stock (défaut : le plus ancien de la boutique) |
| `SAGE_SQL_CONNECTION` | chaîne ODBC (défaut : `localhost`, base `SODICO_TEST`, authentification Windows) |
| `CATALOGUE_FAMILLES` | vide (défaut) : toutes les familles de Sage ; sinon restreint à ces codes (test) |
| `STOCK_DEPOTS` | dépôts additionnés pour le stock (défaut : `Magasin SODICO`) |

Scopes Shopify nécessaires : `read_products`, `write_products`, `read_inventory`, `write_inventory` (plus `read_orders`, `write_orders` seulement si les commandes sont activées).

## Commandes

```bash
npm install
npm run catalogue -- --famille 05INJPO --simulation   # montre ce qui serait créé / mis à jour, sans rien envoyer
npm run catalogue                                     # toutes les familles de Sage : crée et met à jour
npm run stocks                                        # stocks : n'envoie que les différences
npm run synchro                                       # à planifier toutes les 15 min : stocks, + catalogue 1 fois par jour
npm run synchro-catalogue                             # force le passage du catalogue maintenant (= bouton de la page)
npm run verifier                                      # compare Shopify et Sage (prix, code-barre, stock)
npm test                                              # 20 tests automatiques (sans Shopify ni Sage)
```

## Modèle : 1 famille Sage = 1 produit, 1 article = 1 variante

| Sage | Shopify |
|---|---|
| Famille `FA_CodeFamille` (ex. `05INJPO`) | Produit `famille-05injpo`, titre « Famille 05INJPO » (modifiable ensuite dans Shopify) |
| Article `AR_Ref` | Variante, **SKU = `AR_Ref`**, option « Article » = `AR_Design` |
| `AR_PrixVen` (HT) | Prix de la variante |
| `AR_CodeBarre` | Code-barre de la variante |
| `STO_DISPO` des dépôts `STOCK_DEPOTS` | Stock de la variante |

- **Périmètre** : toutes les familles de Sage et tous leurs articles, lus dans la base à chaque passage (une famille créée
  dans Sage arrive seule). Pas de filtre `AR_Publie` (note du 24/09). `CATALOGUE_FAMILLES` ne sert qu'à restreindre un test.
- **Création** (`npm run catalogue`) : une famille absente est créée avec ses articles actifs et à prix. Un nouvel article
  dans une famille existante devient une nouvelle variante. Variantes toujours suivies en stock, sans vente au-delà du stock.
- **Mise à jour** : prix, code-barre, et désignation **seulement si SODICO ne l'a pas renommée** dans Shopify
  (la désignation Sage d'origine est mémorisée dans le champ de variante `sage.designation`).
- **Prix à 0 dans Sage** : variante non créée, ou prix Shopify conservé, et signalé.
- **Article en sommeil** : jamais créé. S'il est déjà en ligne : **stock 0** et signalement, la variante reste visible.
- **Article sans ligne de stock** : stock Shopify non modifié (jamais mis à 0 par défaut d'information).
- **Article changé de famille dans Sage**, **variante Shopify sans article Sage** : non modifiés, signalés.
- **Fréquences** : stocks à chaque `synchro`. Catalogue et prix une fois par jour (`CATALOGUE_INTERVALLE_HEURES`, 24 par défaut),
  mémorisé dans `etat/catalogue.json`.

## Protection de la boutique Shopify

Le connecteur **ne supprime jamais rien**. Il ne modifie que les familles **qu'il a créées** (adresse `famille-<code>` et champ
produit `sage.famille`), et sur leurs variantes **seulement** : prix, code-barre, désignation non renommée, stock.

- Titre, description, photos, SEO, étiquettes, statut du produit : définis à la création, **jamais écrasés ensuite**.
- Avant une création, on vérifie directement que l'adresse est libre : un produit existant n'est jamais écrasé.
- **`sage-ignorer`** : étiquette posée par SODICO sur une famille. Le connecteur n'y touche plus (ni catalogue, ni stock).
- **Garde-fou prix** : une variation de plus de `PRIX_VARIATION_MAX` (50 % par défaut, 0 = désactivé) n'est pas appliquée,
  mais signalée (journal, page, résumé). `--forcer-prix` l'applique.
- **Garde-fou stocks** : si plus de 20 % des variantes (et plus de 5) tombent à 0 d'un coup, ces mises à zéro sont bloquées,
  les autres appliquées, et une alerte part. `--forcer-stocks` les applique.
- **Concurrence** : l'envoi du stock passe la quantité lue (`changeFromQuantity`) : si le stock Shopify a bougé entre-temps
  (commande), Shopify refuse au lieu d'écraser ; le passage suivant reprend.
- `PRODUITS_STATUT_CREATION=DRAFT` crée les nouvelles familles en brouillon, pour relecture avant publication.

## Alertes e-mail et résumé quotidien

Variables `SMTP_*`, `ALERTE_A` (voir `.env.example`) ; sans elles, rien n'est envoyé.

- `npm run synchro` envoie un e-mail à la première panne (diagnostic en clair + action), un rappel toutes les
  `RAPPEL_HEURES` h tant qu'elle dure, et un e-mail au rétablissement. État dans `etat/alertes.json`. Pas d'alerte en `--simulation`.
- `npm run resume` (à planifier chaque matin) : synchros des dernières 24 h (`--heures N`), changements envoyés,
  articles des familles synchronisées non mis en ligne, avec la raison et quoi corriger (CSV joint). `--afficher` : terminal, sans e-mail.
- `SMTP_HOST=fichier` : mode test, les e-mails sont écrits dans `sortie/emails/*.eml`.

## Page de suivi

`npm run interface` démarre une page web (serveur `node:http`, sans dépendance) pour les utilisateurs non techniques :
état 🟢/🔴/🟠/🔄 avec diagnostic en clair, bouton « Synchroniser maintenant » (lance `cli-synchro.js`, comme la tâche
planifiée), changements 24 h, historique 48 h, articles bloqués (recherche + export CSV).

- Par défaut sur ce poste uniquement : `http://sage-shopify-connector.localhost:3000` (ou `http://localhost:3000`). `INTERFACE_HOTE=0.0.0.0` + `INTERFACE_MOT_DE_PASSE` (Basic Auth) pour le réseau local.
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
journaux et rapports de plus de `JOURS_CONSERVATION` jours (30 par défaut).

**Démarrage automatique sous Windows** : double-clic sur `installer-auto.bat` (synchro toutes les 15 min, résumé à 7 h,
page de suivi au démarrage de Windows ; `desinstaller-auto.bat` pour tout arrêter). Détails : [PLANIFICATION.md](PLANIFICATION.md).

## Limites connues

- Titre de famille = code Sage (le libellé de famille n'est pas dans l'extraction) : à renommer dans Shopify.
- Rattachement aux familles de la vraie boutique sodico.re (familles regroupées à la main) : à définir avec Eugenie.
- Pas encore gérés : conditionnements (`F_CONDITION`), prix par catégorie tarifaire (`F_ARTCLIENT`), clients B2B, photos.
- Pilote SQL `msnodesqlv8` : Windows uniquement (passer à `tedious` pour O2switch).


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