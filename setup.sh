#!/usr/bin/env sh
# Spookify setup for macOS and Linux: installs Ollama if it's missing, starts
# it, and downloads the model. Windows users run setup.bat instead.
#
#   ./setup.sh                 # default model, asks about Firefox
#   ./setup.sh --firefox       # also let Firefox extensions reach Ollama
#   ./setup.sh --firefox --origin moz-extension://<uuid>   # only Spookify
#   ./setup.sh --model llama3.2:1b
set -eu

MODEL="llama3.2:3b"
FIREFOX=""
# Chrome needs no setting. Without --origin this allows every Firefox
# extension; the popup's 403 error names Spookify's exact origin.
ORIGINS="moz-extension://*"
API="http://127.0.0.1:11434"

while [ $# -gt 0 ]; do
  case "$1" in
    --firefox) FIREFOX=yes ;;
    --no-firefox) FIREFOX=no ;;
    --origin)
      shift
      case "${1:-}" in
        moz-extension://?*|chrome-extension://?*) ORIGINS="${1%/}" ;;
        *) echo "--origin must look like moz-extension://<uuid>" >&2; exit 1 ;;
      esac
      ;;
    --model) shift; MODEL="${1:?--model needs a value}" ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\033[38;5;208m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
api_up() { curl -fsS "$API/api/version" >/dev/null 2>&1; }

have curl || die "curl is required. Install it and run this again."

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "Unsupported OS: $OS. On Windows, run setup.bat." ;;
esac

# 1. Install Ollama.
if have ollama; then
  say "Ollama is already installed ($(ollama --version 2>/dev/null | head -n1))."
elif [ "$OS" = Linux ]; then
  say "Installing Ollama with the official script (needs sudo)..."
  curl -fsSL https://ollama.com/install.sh | sh
elif have brew; then
  say "Installing Ollama with Homebrew..."
  brew install ollama
else
  die "Ollama isn't installed. Download it from https://ollama.com/download/mac, open it once, then run this again."
fi
have ollama || die "Ollama was installed but isn't on PATH. Open a new terminal and run this again."

# 2. Start the server if it isn't running.
if ! api_up; then
  say "Starting Ollama..."
  if [ "$OS" = Darwin ] && [ -d /Applications/Ollama.app ]; then
    open -a Ollama
  elif [ "$OS" = Linux ] && have systemctl && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    sudo systemctl start ollama
  else
    nohup ollama serve >"${TMPDIR:-/tmp}/ollama.log" 2>&1 &
  fi
  i=0
  until api_up; do
    i=$((i + 1))
    [ "$i" -le 30 ] || die "Ollama didn't start within 30 seconds. Try running 'ollama serve' yourself."
    sleep 1
  done
fi
say "Ollama is running."

# 3. Download the model.
say "Downloading $MODEL (about 2 GB for llama3.2:3b, only the first time)..."
ollama pull "$MODEL"

# 4. Firefox can't rewrite its request Origin, so Ollama has to allow it.
if [ -z "$FIREFOX" ]; then
  if [ -t 0 ]; then
    printf 'Will you use Spookify in Firefox? [y/N] '
    read -r answer
    case "$answer" in [yY]*) FIREFOX=yes ;; *) FIREFOX=no ;; esac
  else
    FIREFOX=no
  fi
fi

if [ "$FIREFOX" = yes ]; then
  if [ "$OS" = Darwin ]; then
    launchctl setenv OLLAMA_ORIGINS "$ORIGINS"
    say "Set OLLAMA_ORIGINS for this login session. Quit Ollama from the menu bar and reopen it."
    say "This resets on reboot; run './setup.sh --firefox' again afterwards."
  elif have systemctl && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    sudo mkdir -p /etc/systemd/system/ollama.service.d
    printf '[Service]\nEnvironment="OLLAMA_ORIGINS=%s"\n' "$ORIGINS" |
      sudo tee /etc/systemd/system/ollama.service.d/spookify.conf >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl restart ollama
    say "Ollama now allows browser extensions (systemd override added)."
  else
    say "Restart Ollama with:  OLLAMA_ORIGINS=\"$ORIGINS\" ollama serve"
  fi
fi

say "Done. Now load the extension in your browser (see README.md, step 2)."
