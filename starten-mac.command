#!/bin/bash
# Zeitstrahl-Werkstatt: Klassenserver starten (Mac)
# Der Port steht in einstellungen.txt
cd "$(dirname "$0")" || exit 1
# Übliche Installationsorte ergänzen, falls das Fenster sie noch nicht kennt
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js wurde nicht gefunden. Bitte einmalig von https://nodejs.org die LTS-Version installieren."
  echo "Falls Node.js gerade erst installiert wurde: dieses Fenster schließen und ein neues Terminal öffnen."
  echo
  read -r -p "Zum Schließen Enter drücken …"
  exit 1
fi
node server.js "$@"
