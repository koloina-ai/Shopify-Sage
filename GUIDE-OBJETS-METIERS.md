# Installer les Objets Métiers Sage chez SODICO

**But :** permettre au connecteur de créer directement dans Sage les commandes passées sur la boutique Shopify (option B).

**Durée :** environ une demi-journée, test compris.

**Qui fait quoi :**
- **M2I** : les étapes 1 à 5, côté Sage ;
- **DigiDataLe** : les étapes 6 à 8, côté connecteur.

> Tant que ce n'est pas terminé, rien ne change : le connecteur continue avec l'option A (zone tampon) ou avec les commandes désactivées.

---

##  Avant de commencer

| À avoir | Où le trouver |
|---|---|
| La **licence « Objets Métiers »** de Sage 100 pour SODICO | Contrat Sage de SODICO, ou demande à Sage via M2I |
| La **version exacte** de Sage installée (ex. v12.20) | Dans Sage : menu **? → À propos** |
| Le **serveur** où tourne le connecteur, avec un accès administrateur | Le serveur SODICO du connecteur |

⚠ Les Objets Métiers doivent être **exactement de la même version** que Sage.

---

## Étape 1 : Vérifier la licence *(M2I)*

Vérifier que la licence de SODICO inclut les **Objets Métiers**. Si ce n'est pas le cas, la commander auprès de Sage : c'est un module payant.

## Étape 2 : Installer les Objets Métiers sur le serveur du connecteur *(M2I)*

1. Sur le **serveur du connecteur**, vérifier que le **client Sage 100** est installé, dans la même version que Sage. Sinon, l'installer.
2. Lancer le programme d'installation Sage 100 de cette version, puis choisir le composant **« Objets Métiers »**.
3. Noter si les Objets Métiers installés sont en **32 bits** ou en **64 bits**. Cette information sert à l'étape 7.
4. Redémarrer le serveur si l'installation le demande.

## Étape 3 : Vérifier que l'installation a marché *(M2I ou DigiDataLe, 1 minute)*

Sur le serveur, ouvrir **PowerShell (x86)** si les Objets Métiers sont en 32 bits, ou **PowerShell** s'ils sont en 64 bits, puis taper :

```powershell
New-Object -ComObject Objets100c.Cial.Stream
```

- **Une liste de propriétés s'affiche** :  c'est installé.
- **Erreur « Classe non enregistrée »** :  l'installation n'a pas marché, ou ce n'est pas le bon PowerShell. Essayer l'autre (32 ou 64 bits).

## Étape 4 : Préparer une société de TEST *(M2I)*

**On ne teste jamais sur la vraie société SODICO.**

1. Faire une **copie de la société SODICO** sous un autre nom, par exemple `SODICO_TEST_OM`.
2. Noter l'emplacement de ses deux fichiers de société :
   - le fichier **comptable** `.mae` (exemple : `\\serveur\Sage\SODICO_TEST_OM.mae`) ;
   - le fichier **commercial** `.gcm` (exemple : `\\serveur\Sage\SODICO_TEST_OM.gcm`).
3. Vérifier que le serveur du connecteur **peut ouvrir ces deux fichiers**.

## Étape 5 : Créer un utilisateur Sage pour le connecteur *(M2I)*

Dans Sage, depuis **Fichier → Autorisations d'accès**, en Comptabilité **et** en Gestion commerciale :

1. Créer l'utilisateur **`CONNECTEUR`** avec un mot de passe solide.
2. Lui donner **seulement** le droit de **créer des documents de vente** (bons de commande) et de consulter clients et articles.
3. **Pas** de droit administrateur.

Faire la même chose ensuite sur la vraie société, pour la mise en production.

**Questions à trancher avec SODICO au passage :**

| Question | Réglage correspondant |
|---|---|
| Quelle **souche** (série de numéros) pour les commandes web ? | `OM_SOUCHE` |
| Quel **dépôt** ? | `OM_DEPOT` |
| Quel prix garder : **celui payé sur Shopify** (conseillé), ou **le tarif Sage** du client recalculé ? | `OM_PRIX` |

---

## Étape 6 : Transmettre à DigiDataLe *(M2I → DigiDataLe)*

- ☐ Objets Métiers : **32 ou 64 bits**
- ☐ Chemins des fichiers `.mae` et `.gcm` de la **société de test**
- ☐ Identifiant et mot de passe de l'utilisateur **CONNECTEUR**, **transmis par un canal sûr, pas par e-mail en clair**
- ☐ Souche, dépôt, choix du prix

## Étape 7 : Configurer le connecteur *(DigiDataLe)*

Dans le fichier `.env` du connecteur, sur le serveur :

```ini
OM_FICHIER_MAE=\\serveur\Sage\SODICO_TEST_OM.mae
OM_FICHIER_GCM=\\serveur\Sage\SODICO_TEST_OM.gcm
OM_UTILISATEUR=CONNECTEUR
OM_MOT_DE_PASSE=********
OM_SOUCHE=
OM_DEPOT=
OM_PRIX=shopify
OM_ARCHITECTURE=32
OM_SIMULATION=
```

Mettre `OM_ARCHITECTURE=64` si les Objets Métiers sont en 64 bits, et laisser `OM_SIMULATION` vide.

Puis, dans le dossier du connecteur :

```bash
npm run commandes-mode
```

La ligne `objets-metiers` doit indiquer **✓ prêt**. Sinon, voir le tableau « Si ça ne marche pas » plus bas.

## Étape 8 : Tester, puis passer en production *(DigiDataLe, avec SODICO)*

**Test sur la société de test :**
1. `npm run commandes-mode -- objets-metiers`
2. Passer une **commande de test** sur la boutique Shopify.
3. Lancer `npm run synchro`, ou cliquer sur **« Synchroniser maintenant »** dans la page de suivi.
4. Dans **Sage (société de test)**, ouvrir **Documents des ventes → Bons de commande**. La commande doit y être, avec la référence **`WEB` + le numéro Shopify** (ex. `WEB1004`). Vérifier :
   - ☐ le bon client ;
   - ☐ les bons articles et quantités ;
   - ☐ les bons prix ;
   - ☐ le stock réservé a bougé.
5. Relancer `npm run synchro` : **aucun doublon** ne doit apparaître.

**Mise en production, une fois le test validé par SODICO :**
1. Dans `.env`, remplacer les chemins `.mae` et `.gcm` par ceux de la **vraie société SODICO**.
2. Relancer `npm run commandes-mode` : il doit afficher **✓ prêt**.
3. Surveiller les premières commandes dans la page de suivi et dans Sage.

**Retour arrière, à tout moment, en une commande :**
```bash
npm run commandes-mode -- tampon     # ou -- off
```

---

## Si ça ne marche pas

| Message | Cause probable | Solution |
|---|---|---|
| « Objets Métiers Sage introuvables sur ce poste » | Pas installés, ou mauvaise version 32/64 bits | Refaire l'étape 3. Essayer `OM_ARCHITECTURE=64` (ou `32`) |
| « Variable OM_FICHIER_MAE manquante » | `.env` incomplet | Compléter l'étape 7 |
| « ouverture de la société Sage impossible… » | Chemin faux, fichiers inaccessibles, ou mauvais utilisateur / mot de passe | Vérifier les chemins et l'utilisateur CONNECTEUR (étapes 4 et 5) |
| « Sage refuse la commande : … » | Règle Sage non respectée : client bloqué, encours dépassé, article en sommeil… | Lire le message, corriger dans Sage. La commande repart toute seule au passage suivant |
| La commande n'apparaît pas dans Sage | Elle est « à vérifier » : client ou article inconnu | Voir la page de suivi. Corriger dans Sage, puis retirer l'étiquette `sage-a-verifier` de la commande dans Shopify |

> ℹ Le connecteur n'a jamais été testé contre de vrais Objets Métiers. Le **premier test de l'étape 8 est donc indispensable**, avant toute mise en production.
