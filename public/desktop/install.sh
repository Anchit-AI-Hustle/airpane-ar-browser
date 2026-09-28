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
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$BASE/airpane-desktop.zip" -o "$tmp/app.zip" || fail "Could not download Airpane. Check your internet connection."
rm -rf "$DIR/app.new"; mkdir -p "$DIR/app.new"
unzip -q "$tmp/app.zip" -d "$DIR/app.new"
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
