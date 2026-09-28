#!/usr/bin/env bash
# Packages the desktop app for download from the website: public/desktop/
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/desktop; mkdir -p "$out"
rm -f "$out/airpane-desktop.zip"
(cd desktop && find airpane_desktop requirements.txt README.md -type f ! -path '*__pycache__*' ! -name '*.pyc' | sort | TZ=UTC zip -q -X -D "../$out/airpane-desktop.zip" -@)
cp desktop/install.sh "$out/install.sh"
echo "built $out/airpane-desktop.zip ($(wc -c < "$out/airpane-desktop.zip") bytes)"
