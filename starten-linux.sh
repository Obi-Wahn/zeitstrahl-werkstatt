#!/bin/bash
# Zeitstrahl-Werkstatt: Klassenserver starten (Linux)
# Der Port steht in einstellungen.txt
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js ist nicht installiert. Bitte einmalig von https://nodejs.org die LTS-Version installieren."
  echo
  read -r -p "Zum Schließen Enter drücken …"
  exit 1
fi
node server.js "$@"
