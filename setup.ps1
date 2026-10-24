# Spookify setup for Windows: installs Ollama if it's missing, starts it, and
# downloads the model. Double-click setup.bat to run it.
#
#   .\setup.ps1                     # default model, asks about Firefox
#   .\setup.ps1 -Firefox            # also let Firefox extensions reach Ollama
#   .\setup.ps1 -Firefox -Origin moz-extension://<uuid>   # only Spookify
#   .\setup.ps1 -Model llama3.2:1b
param(
  [string]$Model = "llama3.2:3b",
  [switch]$Firefox,
  [switch]$NoFirefox,
  # Chrome needs no setting. Without -Origin this allows every Firefox
  # extension; the popup's 403 error names Spookify's exact origin.
  [ValidatePattern('^(moz|chrome)-extension://[^/\s]+/?$')]
  [string]$Origin = "moz-extension://*"
)
$ErrorActionPreference = "Stop"

$Origins = $Origin.TrimEnd("/")
$Api = "http://127.0.0.1:11434"

function Say($msg) { Write-Host "==> " -ForegroundColor DarkYellow -NoNewline; Write-Host $msg }
function Die($msg) { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function ApiUp {
  try { Invoke-RestMethod "$Api/api/version" -TimeoutSec 2 | Out-Null; $true } catch { $false }
}
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
  $default = Join-Path $env:LOCALAPPDATA "Programs\Ollama"
  if ((Test-Path $default) -and ($env:Path -notlike "*$default*")) { $env:Path += ";$default" }
}

# 1. Install Ollama.
RefreshPath
if (Have ollama) {
  Say "Ollama is already installed ($(ollama --version 2>$null | Select-Object -First 1))."
} elseif (Have winget) {
  Say "Installing Ollama with winget..."
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  RefreshPath
} else {
  Die "Ollama isn't installed and winget isn't available. Download it from https://ollama.com/download/windows, then run this again."
}
if (-not (Have ollama)) { Die "Ollama was installed but isn't on PATH. Open a new terminal and run this again." }

# 2. Start the server if it isn't running.
if (-not (ApiUp)) {
  Say "Starting Ollama..."
  Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
  $i = 0
  while (-not (ApiUp)) {
    $i++
    if ($i -gt 30) { Die "Ollama didn't start within 30 seconds. Try running 'ollama serve' yourself." }
    Start-Sleep -Seconds 1
  }
}
Say "Ollama is running."

# 3. Download the model.
Say "Downloading $Model (about 2 GB for llama3.2:3b, only the first time)..."
ollama pull $Model
if ($LASTEXITCODE -ne 0) { Die "Couldn't download $Model." }

# 4. Firefox can't rewrite its request Origin, so Ollama has to allow it.
if (-not $Firefox -and -not $NoFirefox) {
  $answer = Read-Host "Will you use Spookify in Firefox? [y/N]"
  $Firefox = $answer -match '^[yY]'
}
if ($Firefox) {
  [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $Origins, "User")
  Say "Set OLLAMA_ORIGINS for your user. Quit Ollama from the system tray and start it again."
}

Say "Done. Now load the extension in your browser (see README.md, step 2)."
