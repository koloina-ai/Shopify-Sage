# Connecteur Sage 100 ↔ Shopify (SODICO)

Node.js 22+. Lit Sage 100 (SQL Server, lecture seule) et parle à Shopify via l'Admin GraphQL API (2026-07).

## Configuration

Variables lues dans `.env` puis `../env.local` :

| Variable | Rôle |
|---|---|
| `SHOPIFY_STORE_URL` (ou `SHOPIFY_STORE`) | domaine de la boutique |
| `SHOPIFY_STORE_API_TOKEN` (ou `SHOPIFY_ACCESS_TOKEN`) | token Admin API `shpat_…` |
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

## Stocks

Une variation de stock seule ne change pas `cbModification` : `npm run produits` ne la voit pas.
`npm run stocks` compare donc, à chaque passage, le disponible Sage au disponible Shopify de tous les produits `tag:sage`
et n'envoie que les écarts. L'envoi passe la quantité lue (`changeFromQuantity`) : si le stock Shopify a bougé
entre-temps (commande), Shopify refuse la mise à jour au lieu de l'écraser ; le passage suivant la reprend.

## Limites connues

- Pas encore gérés : gammes (variantes), conditionnements, prix par catégorie tarifaire (`F_ARTCLIENT`), clients B2B, photos.
