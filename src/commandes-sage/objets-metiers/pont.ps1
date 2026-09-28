# Pont Objets Métiers Sage 100 (option B).
# Protocole : une requête JSON par ligne sur l'entrée standard, une réponse JSON par ligne sur la sortie standard.
#   { "action": "ouvrir" }                    -> ouvre la comptabilité (.mae) et la gestion commerciale (.gcm)
#   { "action": "creer", "commande": {...} }  -> crée un bon de commande de vente, renvoie { ok, piece }
#   { "action": "fermer" }                    -> ferme la société et termine
# Réponse en cas d'échec : { ok: false, erreur: "..." } (le pont continue : une commande en échec n'arrête pas les autres).
#
# Configuration (variables d'environnement, depuis le .env du connecteur) :
#   OM_FICHIER_MAE, OM_FICHIER_GCM   fichiers de la société Sage (ils pointent vers la base SQL)
#   OM_UTILISATEUR, OM_MOT_DE_PASSE  utilisateur Sage dédié au connecteur
#   OM_SOUCHE, OM_DEPOT              (optionnels) intitulés de la souche et du dépôt des commandes web
#   OM_PRIX = shopify (défaut) | sage  prix de la commande Shopify, ou tarif Sage du client recalculé
#   OM_SIMULATION = oui              aucun appel à Sage : contrôle le format et renvoie une pièce fictive SIM00001…
#
# ⚠ Les appels aux Objets Métiers suivent la documentation Sage 100 (processus CreateProcess_Document).
#   À valider sur la société de test fournie par M2I (noms exacts selon la version installée).

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$simulation = $env:OM_SIMULATION -eq 'oui'
$script:cpta = $null
$script:cial = $null
$script:compteurSimulation = 0

# Types de documents de vente des Objets Métiers (DocumentType) : 0 devis, 1 bon de commande
$DOCUMENT_VENTE_COMMANDE = 1

function Repondre($objet) {
    [Console]::Out.WriteLine(($objet | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

function Exiger([string[]] $noms) {
    foreach ($nom in $noms) {
        if (-not [Environment]::GetEnvironmentVariable($nom)) { throw "Variable $nom manquante dans le fichier .env" }
    }
}

function Ouvrir {
    if ($simulation) { return @{ ok = $true; message = 'simulation : aucune société Sage ouverte' } }
    Exiger 'OM_FICHIER_MAE', 'OM_FICHIER_GCM', 'OM_UTILISATEUR'

    try {
        $script:cpta = New-Object -ComObject 'Objets100c.Cpta.Stream'
    } catch {
        if ($_.Exception.Message -match '80040154') {
            $bits = if ([Environment]::Is64BitProcess) { '64' } else { '32' }
            throw "Objets Métiers Sage introuvables sur ce poste (PowerShell $bits bits). Vérifier leur installation, ou essayer OM_ARCHITECTURE=$(if ($bits -eq '32') { '64' } else { '32' })."
        }
        throw
    }
    $script:cpta.Name = $env:OM_FICHIER_MAE
    $script:cpta.Loggable.UserName = $env:OM_UTILISATEUR
    $script:cpta.Loggable.UserPwd = [string]$env:OM_MOT_DE_PASSE
    $script:cpta.Open()

    $script:cial = New-Object -ComObject 'Objets100c.Cial.Stream'
    $script:cial.Name = $env:OM_FICHIER_GCM
    $script:cial.CptaApplication = $script:cpta
    $script:cial.Loggable.UserName = $env:OM_UTILISATEUR
    $script:cial.Loggable.UserPwd = [string]$env:OM_MOT_DE_PASSE
    $script:cial.Open()
    return @{ ok = $true; message = "société Sage ouverte ($($env:OM_FICHIER_GCM))" }
}

function Verifier($c) {
    if (-not $c.ctNum) { throw 'client (ctNum) absent' }
    if (-not $c.reference -or $c.reference.Length -gt 17) { throw "référence de pièce invalide « $($c.reference) » (17 caractères max.)" }
    if (-not $c.lignes -or $c.lignes.Count -eq 0) { throw 'commande sans ligne' }
    foreach ($l in $c.lignes) {
        if (-not $l.arRef) { throw "ligne $($l.numero) sans référence article" }
        if ([double]$l.quantite -le 0) { throw "ligne $($l.numero) : quantité invalide" }
    }
}

function Creer($c) {
    Verifier $c
    if ($simulation) {
        $script:compteurSimulation++
        return @{ ok = $true; piece = ('SIM{0:D5}' -f $script:compteurSimulation); simulation = $true }
    }
    if (-not $script:cial) { throw 'société Sage non ouverte' }

    # Le « processus » applique toutes les règles Sage : numérotation, tarifs, totaux, stock réservé, contrôles.
    $process = $script:cial.CreateProcess_Document($DOCUMENT_VENTE_COMMANDE)
    $doc = $process.Document
    $doc.SetDefaultClient($script:cpta.FactoryClient.ReadNumero($c.ctNum))
    $doc.DO_Date = [datetime]$c.date
    $doc.DO_Ref = $c.reference
    if ($env:OM_SOUCHE) { $doc.Souche = $script:cial.FactorySoucheVente.ReadIntitule($env:OM_SOUCHE) }
    if ($env:OM_DEPOT) { $doc.DepotStockage = $script:cial.FactoryDepot.ReadIntitule($env:OM_DEPOT) }

    foreach ($l in $c.lignes) {
        $article = $script:cial.FactoryArticle.ReadReference($l.arRef)
        $ligne = $process.AddArticle($article, [double]$l.quantite)
        if ($env:OM_PRIX -ne 'sage') { $ligne.DL_PrixUnitaire = [double]$l.prixUnitaire }
    }

    if (-not $process.CanProcess) {
        $messages = @()
        for ($i = 1; $i -le $process.Errors.Count; $i++) { $messages += $process.Errors.Item($i).Text }
        throw ('Sage refuse la commande : ' + ($messages -join ' ; '))
    }
    $process.Process()
    return @{ ok = $true; piece = [string]$process.DocumentResult.DO_Piece }
}

function Fermer {
    if ($script:cial) { try { $script:cial.Close() } catch {} }
    if ($script:cpta) { try { $script:cpta.Close() } catch {} }
}

$fin = $false
while (-not $fin) {
    $entree = [Console]::In.ReadLine()
    if ($null -eq $entree) { break }          # le connecteur a fermé l'entrée
    if (-not $entree.Trim()) { continue }
    try {
        $requete = $entree | ConvertFrom-Json
        switch ($requete.action) {
            'ouvrir' { Repondre (Ouvrir) }
            'creer'  { Repondre (Creer $requete.commande) }
            'fermer' { Fermer; Repondre @{ ok = $true }; $fin = $true }
            default  { Repondre @{ ok = $false; erreur = "action inconnue : $($requete.action)" } }
        }
    } catch {
        Repondre @{ ok = $false; erreur = $_.Exception.Message }
    }
}
Fermer
