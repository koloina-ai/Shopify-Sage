# Démarrage automatique du connecteur sous Windows (Planificateur de tâches) : plus rien à lancer à la main.
#   - synchro toutes les 15 min (stocks à chaque passage, catalogue et prix une fois par jour)
#   - résumé e-mail chaque matin
#   - page de suivi démarrée avec Windows, relancée si elle s'arrête
# Les tâches tournent même sans session ouverte, sans fenêtre.
#
# Installer   : double-clic sur installer-auto.bat   (ou powershell -ExecutionPolicy Bypass -File installer-auto.ps1)
# Désinstaller: double-clic sur desinstaller-auto.bat (ou ... -File installer-auto.ps1 -Desinstaller)
# Options     : -IntervalleMinutes 15  -HeureResume 07:00
#               -CompteReseau : Sage sur un AUTRE serveur avec authentification Windows (le mot de passe du compte
#                               est alors demandé et enregistré par Windows ; sans cette option, aucun mot de passe
#                               n'est stocké, mais la tâche n'a pas accès aux autres serveurs du réseau).
# Les commandes lancées sont celles de package.json (synchro, resume, interface) : une seule source de vérité.

param(
  [switch]$Desinstaller,
  [switch]$CompteReseau,
  [ValidateRange(5, 1440)][int]$IntervalleMinutes = 15,
  [ValidatePattern('^\d{2}:\d{2}$')][string]$HeureResume = '07:00',
  [string]$Utilisateur = "$env:USERDOMAIN\$env:USERNAME",
  # Bureau de l'utilisateur d'origine (la relance administrateur peut se faire sous un autre compte)
  [string]$Bureau = [Environment]::GetFolderPath('Desktop'),
  [switch]$Relance
)
$ErrorActionPreference = 'Stop'
$dossier = $PSScriptRoot

# Créer une tâche qui tourne sans session ouverte demande les droits administrateur : relance élevée si besoin.
# Le compte d'origine est transmis, pour que les tâches tournent sous ce compte et non sous celui de l'administrateur.
$estAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  $relance = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Relance',
    '-Utilisateur', "`"$Utilisateur`"", '-Bureau', "`"$Bureau`"", '-IntervalleMinutes', $IntervalleMinutes, '-HeureResume', $HeureResume)
  if ($Desinstaller) { $relance += '-Desinstaller' }
  if ($CompteReseau) { $relance += '-CompteReseau' }
  Write-Host 'Droits administrateur nécessaires : accepter la demande de Windows.'
  Start-Process powershell.exe -Verb RunAs -ArgumentList $relance -Wait
  exit
}

$PREFIXE = 'Connecteur Sage Shopify'
$TACHES = @{
  synchro = "$PREFIXE - synchro"
  resume  = "$PREFIXE - resume"
  page    = "$PREFIXE - page de suivi"
}
# Nom utilisé par l'ancienne procédure manuelle (PLANIFICATION.md) : retiré aussi, pour ne pas avoir deux synchros
$ANCIENNES = @($PREFIXE)

function Fin([int]$code = 0) {
  if ($Relance) { Read-Host "`nAppuyer sur Entrée pour fermer" | Out-Null }
  exit $code
}

# La page de suivi est lancée via cmd (pour écrire son journal) : arrêter la tâche ne coupe pas toujours node.
function ArreterPage {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*cli-interface.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function RetirerTaches {
  foreach ($nom in @($TACHES.Values) + $ANCIENNES) {
    if (Get-ScheduledTask -TaskName $nom -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $nom -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $nom -Confirm:$false
      Write-Host "  retirée : $nom"
    }
  }
  ArreterPage
  Remove-Item (Join-Path $Bureau "$PREFIXE.url") -ErrorAction SilentlyContinue
}

try {
  if ($Desinstaller) {
    Write-Host 'Désinstallation du démarrage automatique :'
    RetirerTaches
    Write-Host "`nTerminé. Le connecteur ne tourne plus tout seul (les fichiers ne sont pas touchés)."
    Fin
  }

  # ---------- Vérifications ----------
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'Node.js introuvable. Installer Node.js 22 ou plus, puis relancer.' }
  if (-not (Test-Path (Join-Path $dossier '.env'))) { throw "Fichier .env absent dans $dossier (voir .env.example)." }
  if (-not (Test-Path (Join-Path $dossier 'node_modules'))) { throw "Dépendances absentes : lancer « npm install » dans $dossier." }

  $scripts = (Get-Content (Join-Path $dossier 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).scripts
  function ArgumentsNode([string]$nom) {
    $ligne = $scripts.$nom
    if (-not $ligne -or -not $ligne.StartsWith('node ')) { throw "Script « $nom » introuvable dans package.json." }
    $ligne.Substring(5)
  }
  New-Item -ItemType Directory -Force (Join-Path $dossier 'logs') | Out-Null

  # ---------- Compte d'exécution ----------
  if ($CompteReseau) {
    $cred = Get-Credential -UserName $Utilisateur -Message 'Mot de passe du compte Windows qui exécutera le connecteur'
    $compte = @{ User = $cred.UserName; Password = $cred.GetNetworkCredential().Password; RunLevel = 'Limited' }
  } else {
    # S4U : sans session ouverte et sans mot de passe enregistré. Suffit pour Shopify, les e-mails et un SQL Server local.
    $compte = @{ Principal = (New-ScheduledTaskPrincipal -UserId $Utilisateur -LogonType S4U -RunLevel Limited) }
  }
  function Enregistrer($nom, $action, $declencheur, $reglages, $description) {
    Register-ScheduledTask -TaskName $nom -Action $action -Trigger $declencheur -Settings $reglages `
      -Description $description @compte | Out-Null
    Write-Host "  installée : $nom"
  }

  Write-Host "Installation du démarrage automatique (compte $Utilisateur, dossier $dossier) :"
  RetirerTaches

  # ---------- 1. Synchro toutes les N minutes ----------
  Enregistrer $TACHES.synchro `
    (New-ScheduledTaskAction -Execute $node -Argument (ArgumentsNode 'synchro') -WorkingDirectory $dossier) `
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalleMinutes)) `
    (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) `
    "Synchro Sage -> Shopify toutes les $IntervalleMinutes min. Journal : $dossier\logs"

  # ---------- 2. Résumé e-mail quotidien ----------
  Enregistrer $TACHES.resume `
    (New-ScheduledTaskAction -Execute $node -Argument (ArgumentsNode 'resume') -WorkingDirectory $dossier) `
    (New-ScheduledTaskTrigger -Daily -At $HeureResume) `
    (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
      -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) `
    "Résumé quotidien du connecteur par e-mail, à $HeureResume."

  # ---------- 3. Page de suivi, au démarrage de Windows, relancée si elle s'arrête ----------
  $journalPage = Join-Path $dossier 'logs\page-de-suivi.log'
  Enregistrer $TACHES.page `
    (New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -WorkingDirectory $dossier `
      -Argument "/d /c `"`"$node`" $(ArgumentsNode 'interface') >> `"$journalPage`" 2>&1`"") `
    (New-ScheduledTaskTrigger -AtStartup) `
    (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) `
    "Page de suivi du connecteur (bouton Synchroniser maintenant). Journal : $journalPage"

  # La page tourne tout de suite, sans attendre le prochain redémarrage
  Start-ScheduledTask -TaskName $TACHES.page

  # ---------- Contrôle ----------
  $port = 3000
  $lignePort = Select-String -Path (Join-Path $dossier '.env') -Pattern '^\s*INTERFACE_PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($lignePort) { $port = [int]$lignePort.Matches[0].Groups[1].Value }
  $pageOk = $false
  for ($i = 0; $i -lt 10 -and -not $pageOk; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest -Uri "http://localhost:$port/" -UseBasicParsing -TimeoutSec 3 | Out-Null
      $pageOk = $true
    } catch {
      # 401 = mot de passe demandé : la page répond bien
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $pageOk = $true }
    }
  }

  # Raccourci sur le Bureau : la page s'ouvre dans le navigateur, sans rien lancer
  [IO.File]::WriteAllText((Join-Path $Bureau "$PREFIXE.url"), "[InternetShortcut]`r`nURL=http://sage-shopify-connector.localhost:$port/`r`n", [Text.Encoding]::ASCII)

  Write-Host ''
  Write-Host 'Terminé :'
  Write-Host "  - synchro toutes les $IntervalleMinutes min (première dans 1 min)"
  Write-Host "  - résumé e-mail chaque jour à $HeureResume"
  if ($pageOk) {
    Write-Host "  - page de suivi : http://sage-shopify-connector.localhost:$port (démarre avec Windows) ; raccourci « $PREFIXE » sur le Bureau"
  } else {
    Write-Warning "La page de suivi ne répond pas encore sur le port $port. Voir $journalPage (port déjà pris par un « npm run interface » ouvert ?)."
  }
  Write-Host "`nÉtat des tâches : Planificateur de tâches, ou  Get-ScheduledTask '$PREFIXE*' | Get-ScheduledTaskInfo"
  Fin
} catch {
  Write-Host ''
  Write-Host "Échec : $($_.Exception.Message)" -ForegroundColor Red
  Fin 1
}
