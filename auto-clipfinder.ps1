# ClipFinder - lancement automatique + copie des videos autorisees vers inbox.
# Usage : auto-clipfinder.bat [-Depot "C:\chemin\dossier\partenaires"] [-Ouvrir]
#  1) verifie que le serveur tourne, sinon le lance en arriere-plan ;
#  2) copie les nouvelles videos (+ .srt/.vtt) du dossier -Depot vers inbox ;
#  3) ClipFinder les traite seul (toutes les ~8 s) : les Shorts arrivent dans l'onglet "A valider".
# Rien n'est publie sans ton clic sur "Publier".
param(
  [string]$Depot = "",
  [switch]$Ouvrir
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = 3000
if (Test-Path ".env") {
  $m = Select-String -Path ".env" -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
}
$url = "http://localhost:$port"

function Test-Server {
  try { Invoke-WebRequest -Uri "$url/api/status" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}

if (-not (Test-Server)) {
  Write-Host "Serveur eteint : demarrage en arriere-plan..."
  if (-not (Test-Path "node_modules")) { & npm.cmd install | Out-Null }
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (Test-Server); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Server)) { Write-Host "Echec : le serveur ne repond pas (port $port deja utilise ?)."; exit 1 }
}
Write-Host "Serveur OK : $url"

$inbox = Join-Path $root "inbox"
New-Item -ItemType Directory -Force -Path $inbox | Out-Null
if ($Depot -ne "") {
  if (-not (Test-Path $Depot)) { Write-Host "Dossier introuvable : $Depot"; exit 1 }
  $logFile = Join-Path $root "depot-copied.txt"
  $done = @()
  if (Test-Path $logFile) { $done = Get-Content $logFile }
  $exts = ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".srt", ".vtt"
  $n = 0
  Get-ChildItem -Path $Depot -File | Where-Object { $exts -contains $_.Extension.ToLower() } | ForEach-Object {
    $key = "$($_.Name)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
    if ($done -notcontains $key) {
      $size1 = $_.Length
      Start-Sleep -Seconds 2
      if ((Get-Item $_.FullName).Length -ne $size1) { return }
      Copy-Item $_.FullName (Join-Path $inbox $_.Name) -Force
      Add-Content $logFile $key
      Write-Host "Copie vers inbox : $($_.Name)"
      $n++
    }
  }
  Write-Host "$n nouveau(x) fichier(s). Les Shorts seront prets dans 'A valider' dans quelques minutes."
}

if ($Ouvrir) { Start-Process $url }
