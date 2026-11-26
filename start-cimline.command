#!/bin/zsh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required to start CimLine."
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
