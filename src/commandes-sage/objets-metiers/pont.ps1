# Pont Objets Métiers Sage 100 (option B).
# Protocole : une requête JSON par ligne sur l'entrée standard, une réponse JSON par ligne sur la sortie standard.
#   { "action": "ouvrir" }                    -> ouvre la gestion commerciale (et la comptabilité qui lui est liée)
#   { "action": "creer", "commande": {...} }  -> crée un bon de commande de vente, renvoie { ok, piece }
#   { "action": "fermer" }                    -> ferme la société et termine
# Réponse en cas d'échec : { ok: false, erreur: "..." } (le pont continue : une commande en échec n'arrête pas les autres).
#
# Configuration (variables d'environnement, depuis le .env du connecteur) :
#   OM_FICHIER_GCM                   fichier de la société commerciale (.gcm), OU :
#   OM_SERVEUR_SQL + OM_BASE_SQL     serveur/instance SQL et base Sage (propriétés CompanyServer / CompanyDatabaseName)
#   OM_FICHIER_MAE                   (optionnel) fichier comptable (.mae) ; sinon la comptabilité liée à la base commerciale
#   OM_UTILISATEUR, OM_MOT_DE_PASSE  utilisateur Sage dédié au connecteur
#   OM_SOUCHE, OM_DEPOT              (optionnels) intitulés de la souche et du dépôt des commandes web
#   OM_PRIX = shopify (défaut) | sage  prix de la commande Shopify, ou tarif Sage du client recalculé
#   OM_SIMULATION = oui              aucun appel à Sage : contrôle le format et renvoie une pièce fictive SIM00001…
#
# Conforme au manuel « Sage 100cloud Objets Métiers » (processus de création de document IPMDocument) :
#   - la bibliothèque est en 32 bits : lancer ce pont avec le PowerShell 32 bits (SysWOW64) ;
#   - on n'ouvre que la base commerciale : son Open() ouvre aussi la base comptable liée ;
#   - le document n'est écrit en base qu'à Process(), après CanProcess() ; rien n'est verrouillé avant.
# ⚠ À valider sur une société de test : la valeur de DocumentTypeVenteCommande (1 supposé) et les intitulés de souche/dépôt.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$simulation = $env:OM_SIMULATION -eq 'oui'
$script:cial = $null
$script:compteurSimulation = 0

# Énuméré DocumentType : DocumentTypeVenteCommande (bon de commande de vente), supposé égal à DO_Type = 1 de F_DOCENTETE.
# Le manuel ne donne que les noms : à confirmer au premier test (la pièce créée doit apparaître en « Bon de commande »).
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

# Crée l'objet COM : identifiant versionné du manuel (« .1 »), puis sans version.
function NouvelObjet([string[]] $identifiants) {
    foreach ($id in $identifiants) {
        try { return New-Object -ComObject $id } catch { if ($_.Exception.Message -notmatch '80040154') { throw } }
    }
    $bits = if ([Environment]::Is64BitProcess) { '64' } else { '32' }
    throw "Objets Métiers Sage introuvables sur ce poste (PowerShell $bits bits). Vérifier leur installation (Runtime objets100c), ou essayer OM_ARCHITECTURE=$(if ($bits -eq '32') { '64' } else { '32' })."
}

function Ouvrir {
    if ($simulation) { return @{ ok = $true; message = 'simulation : aucune société Sage ouverte' } }
    if (-not $env:OM_FICHIER_GCM -and -not ($env:OM_SERVEUR_SQL -and $env:OM_BASE_SQL)) {
        throw 'Variable OM_FICHIER_GCM manquante dans le fichier .env (ou OM_SERVEUR_SQL + OM_BASE_SQL)'
    }
    Exiger 'OM_UTILISATEUR'

    $script:cial = NouvelObjet 'Objets100c.Cial.Stream.1', 'Objets100c.Cial.Stream'
    if ($env:OM_FICHIER_GCM) {
        $script:cial.Name = $env:OM_FICHIER_GCM
    } else {
        $script:cial.CompanyServer = $env:OM_SERVEUR_SQL
        $script:cial.CompanyDatabaseName = $env:OM_BASE_SQL
    }
    # Base comptable liée : seulement si elle est précisée ; sinon Sage reprend celle rattachée à la base commerciale.
    if ($env:OM_FICHIER_MAE) {
        $cpta = NouvelObjet 'Objets100c.Cpta.Stream.1', 'Objets100c.Cpta.Stream'
        $cpta.Name = $env:OM_FICHIER_MAE
        $cpta.Loggable.UserName = $env:OM_UTILISATEUR
        $cpta.Loggable.UserPwd = [string]$env:OM_MOT_DE_PASSE
        $script:cial.CptaApplication = $cpta
    }
    $script:cial.Loggable.UserName = $env:OM_UTILISATEUR
    $script:cial.Loggable.UserPwd = [string]$env:OM_MOT_DE_PASSE
    $script:cial.Open() # ouvre aussi la comptabilité liée (manuel OM, « Ouverture et fermeture d'une base commerciale »)

    if (-not $script:cial.Licence.IsValid) {
        Fermer
        throw 'Licence Objets Métiers absente ou invalide pour cette société Sage : voir avec M2I'
    }
    $nom = if ($env:OM_FICHIER_GCM) { $env:OM_FICHIER_GCM } else { "$($env:OM_SERVEUR_SQL) / $($env:OM_BASE_SQL)" }
    return @{ ok = $true; message = "société Sage ouverte ($nom)" }
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
    # Tant que Process() n'est pas appelé, le document n'existe qu'en mémoire (rien n'est verrouillé ni écrit).
    $process = $script:cial.CreateProcess_Document($DOCUMENT_VENTE_COMMANDE)
    $doc = $process.Document
    $doc.SetAutoRecalculTotaux($false) # totaux calculés une seule fois, pas à chaque ligne (exemple du manuel)
    $doc.SetDefaultClient($script:cial.CptaApplication.FactoryClient.ReadNumero($c.ctNum))
    $doc.DO_Date = [datetime]$c.date
    $doc.DO_Ref = $c.reference
    if ($env:OM_SOUCHE) { $doc.Souche = $script:cial.FactorySoucheVente.ReadIntitule($env:OM_SOUCHE) }
    if ($env:OM_DEPOT) { $doc.DO_DepotStockage = $script:cial.FactoryDepot.ReadIntitule($env:OM_DEPOT) }

    foreach ($l in $c.lignes) {
        $ligne = $process.AddArticleReference([string]$l.arRef, [double]$l.quantite)
        if ($env:OM_PRIX -ne 'sage') { $ligne.DL_PrixUnitaire = [double]$l.prixUnitaire }
    }

    if (-not $process.CanProcess) {
        $messages = @()
        for ($i = 1; $i -le $process.Errors.Count; $i++) {
            $e = $process.Errors.Item($i)
            $messages += "$($e.Text) (code $($e.ErrorCode))"
        }
        throw ('Sage refuse la commande : ' + ($messages -join ' ; '))
    }
    $process.Process()
    return @{ ok = $true; piece = [string]$process.DocumentResult.DO_Piece }
}

function Fermer {
    # Fermer la base commerciale referme aussi la comptabilité liée
    if ($script:cial) { try { if ($script:cial.IsOpen) { $script:cial.Close() } } catch {} }
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
