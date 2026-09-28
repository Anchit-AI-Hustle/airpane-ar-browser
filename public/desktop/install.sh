#!/usr/bin/env bash
# Airpane Desktop installer: control your computer with hand gestures.
#   curl -fsSL https://airpane.anchit-tandon.com/desktop/install.sh | bash
set -euo pipefail
BASE="${AIRPANE_BASE:-https://airpane.anchit-tandon.com/desktop}"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
if [ "$(uname)" = "Darwin" ]; then DIR="$HOME/Library/Application Support/Airpane"; else DIR="${XDG_DATA_HOME:-$HOME/.local/share}/airpane"; fi
say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mAirpane:\033[0m %s\n' "$*" >&2; exit 1; }

say "Installing Airpane Desktop into: $DIR"
mkdir -p "$DIR"
# --- files (generated) ---
FILES='
d178251918ed589b8002f6c4cbcb3dec76363c40 README.md
3fa9c9ead726e0f234f390c498460e5d1c0e58cc airpane_desktop/__init__.py
ef0cc488d266b722599982cb9d6c166f347c7e5b airpane_desktop/__main__.py
7ee62933ebf6649f50847aa4f09d90501b58df92 airpane_desktop/actions.py
fa0214a0f71c6fb88a5b47c7bb6a871f9cbac2cc airpane_desktop/app.py
76ec7fd006e878398c9be2296483ab7698d7d05a airpane_desktop/config.py
c30aaf4b81885d8cd57325558f6e28a080083e31 airpane_desktop/engine.py
990351ab2e1028f58ff409b66bdd3e96150b9712 airpane_desktop/poses.py
ffed5925a4aa660f7e8342a4f0c10211e26442fa airpane_desktop/server.py
513bbe1b48a811bc0d31d209026f4629b4c33a32 airpane_desktop/ui/app.css
0388d97f8d3667bbd5ecabaa0d87513ccc02fc24 airpane_desktop/ui/app.js
8889a63791fd6670a4fba5f98f4150e1a17d2018 airpane_desktop/ui/index.html
06b18e3d12bbee58da83a50870bac433633a0709 requirements.txt
'
# --- end files ---
rm -rf "$DIR/app.new"; mkdir -p "$DIR/app.new"
while read -r sum f; do
  [ -n "$f" ] || continue
  mkdir -p "$DIR/app.new/$(dirname "$f")"
  curl -fsSL "$BASE/app/$f" -o "$DIR/app.new/$f" || fail "Could not download $f. Check your internet connection."
  got="$( (shasum -a 1 "$DIR/app.new/$f" 2>/dev/null || sha1sum "$DIR/app.new/$f") | cut -d' ' -f1)"
  [ "$got" = "$sum" ] || fail "$f did not download correctly. Please run the installer again."
done <<< "$FILES"
rm -rf "$DIR/app"; mv "$DIR/app.new" "$DIR/app"

# Hand tracking (MediaPipe) supports Python 3.9 to 3.12.
PY=""
cands="python3.12 python3.11 python3.10 python3.9"
for v in 3.12 3.11 3.10 3.9; do cands="$cands /opt/homebrew/bin/python$v /usr/local/bin/python$v /Library/Frameworks/Python.framework/Versions/$v/bin/python3"; done
cands="$cands python3 /usr/bin/python3"
for c in $cands; do
  p="$(command -v "$c" 2>/dev/null || true)"; [ -n "$p" ] || continue
  if "$p" -c 'import sys; sys.exit(0 if (3,9) <= sys.version_info[:2] <= (3,12) else 1)' 2>/dev/null; then PY="$p"; break; fi
done
if [ -z "$PY" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    fail "Python 3.9 to 3.12 is needed. Run: xcode-select --install   (or install Python 3.12 from python.org), then run this installer again."
  fi
  fail "Python 3.9 to 3.12 is needed. Install it, then run this installer again."
fi
say "Using $("$PY" --version) at $PY"

if [ ! -x "$DIR/venv/bin/python" ] || ! "$DIR/venv/bin/python" -c 'import sys' 2>/dev/null; then
  rm -rf "$DIR/venv"; "$PY" -m venv "$DIR/venv" || fail "Could not create a Python environment."
fi
say "Installing hand tracking and mouse control (first time takes a minute or two)"
"$DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check --upgrade pip
"$DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check -r "$DIR/app/requirements.txt" || fail "Installing the Python packages failed (see above)."

if [ ! -s "$DIR/hand_landmarker.task" ]; then
  say "Downloading the hand tracking model"
  curl -fsSL "$MODEL_URL" -o "$DIR/hand_landmarker.task.part" && mv "$DIR/hand_landmarker.task.part" "$DIR/hand_landmarker.task"
fi

cat > "$DIR/airpane" <<LAUNCH
#!/usr/bin/env bash
cd "$DIR/app" && exec "$DIR/venv/bin/python" -m airpane_desktop --model "$DIR/hand_landmarker.task" "\$@"
LAUNCH
chmod +x "$DIR/airpane"
"$DIR/venv/bin/python" -c "import sys; sys.path.insert(0, '$DIR/app'); import airpane_desktop.engine, cv2, mediapipe, importlib.util; assert importlib.util.find_spec('pynput')" || fail "Airpane was installed but does not start. Please share the error above."

if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Applications"
  printf '#!/usr/bin/env bash\nexec "%s/airpane"\n' "$DIR" > "$HOME/Applications/Airpane.command"
  chmod +x "$HOME/Applications/Airpane.command"
  say "Done. Start it any time by double-clicking Airpane in your Applications folder (in your home folder)."
  echo
  echo "  Two one-time permissions for Terminal, in System Settings > Privacy & Security:"
  echo "   1. Camera: macOS asks the first time. Click Allow."
  echo "   2. Accessibility: turn on Terminal so your hand can move the mouse, then start Airpane again."
  echo
else
  mkdir -p "$HOME/.local/bin"; ln -sf "$DIR/airpane" "$HOME/.local/bin/airpane"
  say "Done. Start it with: airpane"
fi
if [ "${AIRPANE_NO_START:-}" != "1" ]; then say "Starting Airpane"; exec "$DIR/airpane"; fi
