"""Records what the computer actually receives (mouse and keys), as JSON lines."""
import json, sys, time
from pynput import keyboard, mouse
out = open(sys.argv[1], "w")
def w(**k): out.write(json.dumps({"t": round(time.time(), 3), **k}) + "\n"); out.flush()
mouse.Listener(on_move=lambda x, y: w(ev="move", x=x, y=y), on_click=lambda x, y, b, p: w(ev="click", x=x, y=y, b=b.name, down=p),
               on_scroll=lambda x, y, dx, dy: w(ev="scroll", dy=dy)).start()
keyboard.Listener(on_press=lambda k: w(ev="key", key=str(k)), on_release=lambda k: w(ev="keyup", key=str(k))).start()
w(ev="ready")
time.sleep(float(sys.argv[2]))
