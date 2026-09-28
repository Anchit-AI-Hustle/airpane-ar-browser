#!/usr/bin/env bash
# Publishes the desktop app for the website: plain source files under public/desktop/app/
# and an installer that downloads them and checks each file's SHA-1.
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/desktop; rm -rf "$out/app" "$out/airpane-desktop.zip"; mkdir -p "$out/app"
files=$(cd desktop && find airpane_desktop requirements.txt README.md -type f ! -path '*__pycache__*' ! -name '*.pyc' | sort)
manifest=""
for f in $files; do
  mkdir -p "$out/app/$(dirname "$f")"; cp "desktop/$f" "$out/app/$f"
  manifest+="$(sha1sum "desktop/$f" | cut -d' ' -f1) $f"$'\n'
done
python3 - "$manifest" <<'PY'
import sys
m = sys.argv[1].strip()
s = open("desktop/install.sh").read()
a, b = s.index("# --- files (generated) ---"), s.index("# --- end files ---")
s = s[:a] + "# --- files (generated) ---\nFILES='\n" + m + "\n'\n" + s[b:]
open("desktop/install.sh", "w").write(s)
PY
cp desktop/install.sh "$out/install.sh"
echo "published $(echo "$files" | wc -l) files to $out/app"
