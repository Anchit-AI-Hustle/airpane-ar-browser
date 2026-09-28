# Airpane Desktop

Control your whole computer with your hand, through the webcam. Point to move the cursor, pinch to click and drag, make a V to scroll, swipe to change desktops, and set your own gestures for anything else.

## Install (Mac)

Open Terminal and run:

```
curl -fsSL https://airpane.anchit-tandon.com/desktop/install.sh | bash
```

After that, start it from **Airpane** in the Applications folder in your home folder. The settings page opens in your browser.

The first time, allow two things for Terminal in **System Settings > Privacy & Security**:

1. **Camera**: macOS asks automatically. Click Allow.
2. **Accessibility**: switch on Terminal so Airpane can move the mouse and press keys. Then start Airpane again.

## Default gestures

| Gesture | Does |
|---|---|
| Index finger up, move hand | Move the cursor |
| Thumb and index touch briefly | Click |
| Thumb and index touch and move | Drag |
| Thumb and middle finger touch | Right click |
| V sign, move up or down | Scroll |
| Swipe left or right, open hand | Next or previous desktop |
| Swipe up or down, open hand | Mission Control or show desktop |
| Three fingers, hold | Switch app |
| Thumbs up, hold | Volume up (repeats) |
| Thumbs down, hold | Volume down (repeats) |
| Index and pinky up, hold | Play or pause |
| Only the pinky up (call-me sign), hold | Mute |
| Four fingers up, thumb folded in, hold | Screenshot (then pinch and drag to select) |
| Fist, hold about a second | Pause or resume Airpane |

Each gesture has exactly one job. Every gesture, hold time, repeat, cooldown and action can be changed on the settings page, and gestures already in use are greyed out there, so two actions can never share one. Airpane also refuses a duplicate that arrives any other way (for example an edited settings file) and shows why.

## Safety

- Ctrl + Alt + P pauses and Ctrl + Alt + Q quits (the keyboard shortcuts need Input Monitoring permission for Terminal on a Mac).
- If your hand leaves the camera while dragging, the mouse button is released.
- Test mode shows what each gesture would do without touching the computer.
- The settings page is only reachable from this computer. Camera video and gestures never leave your machine, and Airpane never runs commands, only the clicks and keys you choose.

## Tips

- Sit about an arm's length from the camera with your hand in good, even light.
- If the cursor feels too fast or needs too much arm movement, change **Hand travel**. If it shakes, raise **Steadiness**.

## Run from source

```
pip install -r requirements.txt
python -m airpane_desktop            # add --dry-run for test mode
python -m unittest discover -s tests -p 'test_engine.py'
```
