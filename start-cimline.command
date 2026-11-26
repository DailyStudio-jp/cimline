#!/bin/zsh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

ensure_node() {
  local node_major=""
  local brew_bin=""

  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi
  if [[ "$node_major" == <-> ]] && (( node_major >= 24 )) && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  echo "Node.js 24 or later with npm was not found."
  if command -v brew >/dev/null 2>&1; then
    brew_bin="$(command -v brew)"
  elif [ -x /opt/homebrew/bin/brew ]; then
    brew_bin="/opt/homebrew/bin/brew"
  elif [ -x /usr/local/bin/brew ]; then
    brew_bin="/usr/local/bin/brew"
  fi

  if [ -z "$brew_bin" ]; then
    echo "Install Node.js 24 or later from https://nodejs.org/en/download/, then run this file again."
    open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
    return 1
  fi

  eval "$("$brew_bin" shellenv)"
  if "$brew_bin" list --versions node >/dev/null 2>&1; then
    echo "Upgrading Node.js with Homebrew..."
    if ! "$brew_bin" upgrade node; then
      echo "Homebrew could not upgrade Node.js. Install Node.js manually from https://nodejs.org/en/download/."
      open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
      return 1
    fi
  else
    echo "Installing Node.js with Homebrew..."
    if ! "$brew_bin" install node; then
      echo "Homebrew could not install Node.js. Install Node.js manually from https://nodejs.org/en/download/."
      open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
      return 1
    fi
  fi
  eval "$("$brew_bin" shellenv)"

  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi
  if [[ "$node_major" == <-> ]] && (( node_major >= 24 )) && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  echo "Node.js installation did not provide Node.js 24 or later and npm."
  echo "Install Node.js manually from https://nodejs.org/en/download/, then run this file again."
  open "https://nodejs.org/en/download/" >/dev/null 2>&1 || true
  return 1
}

if ! ensure_node; then
  printf "Press Return to close this window... "
  read -r _dummy
  exit 1
fi

if [ ! -x "node_modules/.bin/vite" ]; then
  echo "Installing CimLine dependencies for the first run..."
  npm install || {
    echo "Dependency installation failed."
    printf "Press Return to close this window... "
    read -r _dummy
    exit 1
  }
fi

npm run dev
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "CimLine could not be started. Check the messages above."
  printf "Press Return to close this window... "
  read -r _dummy
fi
exit "$STATUS"
