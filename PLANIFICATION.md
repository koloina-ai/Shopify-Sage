# Lancer la synchro automatiquement (toutes les 15 minutes)

> À installer **sur le serveur qui exécutera le connecteur** (chez SODICO, à côté de Sage), pas sur un poste de développement.

## Windows ou Linux ?

Le connecteur lit Sage avec le pilote `msnodesqlv8`, qui ne fonctionne **que sous Windows**. Sage 100 tourne lui aussi sous Windows.

- **Cas normal : serveur Windows.** On utilise le **Planificateur de tâches**, l'équivalent Windows de `cron`. Voir la section 2.
- **Serveur Linux :** voir la section 3. Il faudra d'abord adapter la connexion SQL : compte SQL au lieu de l'authentification Windows, et pilote `tedious`.

---

## 1. Prérequis sur le serveur

1. **Node.js 22 ou plus**, et le **pilote ODBC 18 pour SQL Server**.
2. Copier le dossier `connecteur/` (sans `node_modules/`, `sortie/`, `etat/`, `logs/`), puis lancer :
   ```bat
   cd C:\Connecteur\connecteur
   npm install
   ```
3. Créer le fichier `.env` dans `connecteur/` :
   ```ini
   SHOPIFY_STORE_URL=https://<boutique>.myshopify.com
   SHOPIFY_STORE_API_TOKEN=shpat_...
   SHOPIFY_API_VERSION=2026-07
   # Base Sage réelle, en LECTURE SEULE (compte fourni par M2I)
   SAGE_SQL_CONNECTION=Driver={ODBC Driver 18 for SQL Server};Server=<serveur-sage>;Database=<base-sodico>;Trusted_Connection=yes;TrustServerCertificate=yes;
   # Durée de conservation des journaux et rapports (jours)
   JOURS_CONSERVATION=30
   # E-mails d'alerte et résumé quotidien (ex. SMTP O2switch)
   SMTP_HOST=mail.<domaine>.fr
   SMTP_PORT=465
   SMTP_USER=connecteur@<domaine>.fr
   SMTP_PASSWORD=...
   ALERTE_A=responsable@sodico.re,support@digidatale.com
   ```
   Pour tester les e-mails sans rien envoyer : `SMTP_HOST=fichier`. Les e-mails sont alors écrits dans `sortie/emails/`, et on peut les ouvrir avec Outlook.
4. **Commandes vers Sage, option B (Objets Métiers).** Le client Sage et les Objets Métiers doivent être installés sur ce serveur, dans la même version que Sage. Renseigner les `OM_*` du `.env`, puis vérifier avec `npm run commandes-mode`. Si le mode est « prêt » : `npm run commandes-mode -- objets-metiers`.
   **Commandes vers Sage, option A (zone tampon).** Créer la zone tampon (`sqlcmd -S <serveur> -E -i sql\tampon-commandes.sql -f 65001`). Donner au compte du connecteur `db_datareader` + `db_datawriter` **sur cette base seulement**, puis mettre `COMMANDES_MODE=tampon` dans `.env`. La base Sage reste en lecture seule.
5. **Première synchro, à la main.** Elle crée les familles de `CATALOGUE_FAMILLES` sur la boutique.
   ```bat
   npm run catalogue -- --simulation
   npm run catalogue
   npm run stocks
   ```
   Contrôler ensuite dans l'admin Shopify et avec `npm run verifier`.

---

## 2. Windows : Planificateur de tâches

### Installation automatique (recommandé)

Double-cliquer sur **`installer-auto.bat`** dans le dossier `connecteur/`, puis accepter la demande de droits administrateur. Le script crée trois tâches, qui tournent **sans session ouverte et sans fenêtre** :

| Tâche | Quand | Commande (reprise de `package.json`) |
|---|---|---|
| `Connecteur Sage Shopify - synchro` | toutes les 15 min (catalogue et prix 1 fois par jour) | `npm run synchro` |
| `Connecteur Sage Shopify - resume` | chaque jour à 7 h | `npm run resume` |
| `Connecteur Sage Shopify - page de suivi` | au démarrage de Windows, relancée si elle s'arrête | `npm run interface` (journal : `logs/page-de-suivi.log`) |

- Un raccourci **« Connecteur Sage Shopify »** est posé sur le Bureau : il ouvre la page de suivi dans le navigateur. Rien d'autre à lancer.
- Relancer le script remplace les tâches existantes. Il arrête aussi une page de suivi ouverte à la main (`npm run interface`), sinon le port serait déjà pris.
- Options : `installer-auto.bat -IntervalleMinutes 10 -HeureResume 06:30`.
- **Sage sur un autre serveur** (authentification Windows) : `installer-auto.bat -CompteReseau`. Le mot de passe du compte est demandé et enregistré par Windows. Sans cette option, aucun mot de passe n'est stocké, mais les tâches ne peuvent joindre qu'un SQL Server **local**.
- Le poste doit rester allumé, et sans mise en veille. Une synchro manquée pendant l'arrêt est lancée au redémarrage.
- Pour tout arrêter : double-cliquer sur **`desinstaller-auto.bat`**.

Les commandes ci-dessous restent valables pour une installation à la main.

### Commande à lancer (PowerShell en administrateur)

Adapter les deux chemins et le compte Windows. Ce compte doit avoir le droit de **lire** la base Sage.

```powershell
$dossier = 'C:\Connecteur\connecteur'
$npm     = 'C:\Program Files\nodejs\npm.cmd'

$action   = New-ScheduledTaskAction -Execute $npm -Argument "--prefix `"$dossier`" run synchro" -WorkingDirectory $dossier
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable -DontStopIfGoingOnBatteries

$compte = Get-Credential -Message 'Compte Windows qui exécutera la synchro' -UserName 'DOMAINE\compte-connecteur'

Register-ScheduledTask -TaskName 'Connecteur Sage Shopify' -Action $action -Trigger $trigger -Settings $settings `
  -User $compte.UserName -Password $compte.GetNetworkCredential().Password -RunLevel Limited
```

Ce que font ces réglages :
- **toutes les 15 minutes**, sans date de fin ;
- `-MultipleInstances IgnoreNew` : si une synchro dure plus de 15 minutes, la suivante **ne démarre pas** par-dessus ;
- `-ExecutionTimeLimit 30 min` : une synchro bloquée est arrêtée ;
- `-StartWhenAvailable` : si le serveur était éteint à l'heure prévue, la synchro se lance au redémarrage.

### Résumé quotidien par e-mail (tous les jours à 7 h)

Même principe, avec une deuxième tâche :

```powershell
$action  = New-ScheduledTaskAction -Execute $npm -Argument "--prefix `"$dossier`" run resume" -WorkingDirectory $dossier
$trigger = New-ScheduledTaskTrigger -Daily -At 7am
Register-ScheduledTask -TaskName 'Connecteur Sage Shopify - resume' -Action $action -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable) `
  -User $compte.UserName -Password $compte.GetNetworkCredential().Password -RunLevel Limited
```

Ou en une ligne :
```bat
schtasks /Create /TN "Connecteur Sage Shopify - resume" /SC DAILY /ST 07:00 /RU "DOMAINE\compte-connecteur" /RP * ^
  /TR "\"C:\Program Files\nodejs\npm.cmd\" --prefix \"C:\Connecteur\connecteur\" run resume"
```

### Page de suivi (démarrée avec le serveur)

La page doit tourner en permanence. On la lance donc au démarrage de Windows, sans limite de durée :

```powershell
$action  = New-ScheduledTaskAction -Execute $npm -Argument "--prefix `"$dossier`" run interface" -WorkingDirectory $dossier
$trigger = New-ScheduledTaskTrigger -AtStartup
$reglages = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Connecteur Sage Shopify - page de suivi' -Action $action -Trigger $trigger -Settings $reglages `
  -User $compte.UserName -Password $compte.GetNetworkCredential().Password -RunLevel Limited
Start-ScheduledTask -TaskName 'Connecteur Sage Shopify - page de suivi'
```

Dans le `.env`, pour que les postes de SODICO y accèdent :
```ini
INTERFACE_HOTE=0.0.0.0
INTERFACE_PORT=3000
INTERFACE_MOT_DE_PASSE=un-mot-de-passe-solide
```
L'adresse à donner aux utilisateurs est `http://<nom-du-serveur>:3000`. Le navigateur demande un identifiant (n'importe lequel) et le mot de passe.

Il faut aussi **autoriser le port dans le pare-feu Windows**, pour le réseau local uniquement :
```powershell
New-NetFirewallRule -DisplayName 'Connecteur Sage Shopify - page de suivi' -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Domain,Private -Action Allow
```
Ne pas ouvrir ce port vers Internet.

### Variante en une ligne (`schtasks`, invite de commandes)

```bat
schtasks /Create /TN "Connecteur Sage Shopify" /SC MINUTE /MO 15 /RU "DOMAINE\compte-connecteur" /RP * ^
  /TR "\"C:\Program Files\nodejs\npm.cmd\" --prefix \"C:\Connecteur\connecteur\" run synchro"
```

Avec `schtasks`, on ne peut pas régler « ne pas lancer une 2e instance ». Vérifier ce point dans le Planificateur de tâches : **Propriétés → Paramètres → « Ne pas démarrer une nouvelle instance »**.

### Gérer la tâche

```bat
schtasks /Run    /TN "Connecteur Sage Shopify"     & rem lancer tout de suite
schtasks /Query  /TN "Connecteur Sage Shopify" /V  & rem état, dernier résultat (0 = OK, 1 = échec)
schtasks /Change /TN "Connecteur Sage Shopify" /DISABLE
schtasks /Change /TN "Connecteur Sage Shopify" /ENABLE
schtasks /Delete /TN "Connecteur Sage Shopify" /F  & rem supprimer
```

---

## 3. Linux : cron

Seulement si la connexion SQL a été adaptée (voir plus haut). Éditer la crontab avec `crontab -e` :

```cron
# Synchro Sage -> Shopify toutes les 15 minutes ; flock empêche deux synchros simultanées
*/15 * * * * cd /opt/connecteur && flock -n /tmp/connecteur-sage.lock npm run synchro >/dev/null 2>&1
# Résumé quotidien par e-mail à 7 h
0 7 * * * cd /opt/connecteur && npm run resume >/dev/null 2>&1
```

Le journal est écrit par le connecteur lui-même dans `logs/`. La redirection vers `/dev/null` évite les e-mails de cron.

---

## 4. Surveiller

Personne n'a besoin d'ouvrir un terminal. **Les e-mails préviennent**, et **la page de suivi** (`http://<nom-du-serveur>:3000`) montre :
- l'état : 🟢 tout va bien, 🔴 échec (avec le problème et quoi faire), 🟠 plus de synchro récente, 🔄 en cours ;
- un bouton **« Synchroniser maintenant »** ;
- les changements des dernières 24 h ;
- l'historique des passages ;
- les articles à corriger dans Sage, avec une recherche et un export Excel.

| E-mail | Quand |
|---|---|
| ❌ *La synchronisation a échoué* | Au premier échec : le problème en clair et quoi faire. Un rappel toutes les `RAPPEL_HEURES` h (4 par défaut) tant que ça dure |
| ✅ *Synchronisation rétablie* | Quand ça repart, avec la durée de l'interruption |
| 📋 *Résumé du jour* | Chaque matin à 7 h : état des synchros, changements, articles à corriger dans Sage (liste Excel en pièce jointe). ⚠️ dans le sujet si une synchro a échoué ou si aucune n'a tourné |

Pour les techniciens :

- **Journal du jour :** `connecteur/logs/synchro-AAAA-MM-JJ.log`. Chaque ligne est horodatée, et les problèmes commencent par `ERR`.
- **Fin de chaque passage :** `=== OK ... ===` ou `=== ÉCHEC ... ===`.
- **Code retour de la tâche :** `0` = OK, `1` = au moins une erreur. On le lit dans l'historique du Planificateur ou avec `schtasks /Query /V`.
- **Nettoyage automatique :** les journaux et rapports de plus de `JOURS_CONSERVATION` jours (30 par défaut) sont supprimés à chaque passage.

### Messages à surveiller

| Message | Signification | Action |
|---|---|---|
| `⚠ Retrait annulé : N produits à retirer sur M actifs` | Plus de 20 % des produits auraient été retirés d'un coup : probablement une anomalie (mauvaise base, Sage vide…). **Rien n'a été retiré.** | Vérifier Sage. Si c'est voulu, lancer une fois `npm run synchro -- --forcer-retrait` |
| `Erreur : ... SQL ...` | Sage inaccessible | Vérifier le serveur SQL et le compte |
| `Erreur : Shopify HTTP 401` | Token Shopify invalide ou révoqué | Mettre à jour `.env` |
| `changeFromQuantity ... no longer matches` | Le stock a bougé dans Shopify pendant la synchro (commande) | Rien : c'est repris au passage suivant |
