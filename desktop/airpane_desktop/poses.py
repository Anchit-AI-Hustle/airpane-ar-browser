"""Hand pose recognition from the 21 MediaPipe hand landmarks.

Works on distances relative to the palm, so it does not depend on how far the
hand is from the camera or how it is rotated. Coordinates are normalized image
coordinates (x, y in 0..1, y down), already mirrored so left/right match the user.
"""
from __future__ import annotations

import math

WRIST = 0
THUMB = (1, 2, 3, 4)
INDEX = (5, 6, 7, 8)
MIDDLE = (9, 10, 11, 12)
RING = (13, 14, 15, 16)
PINKY = (17, 18, 19, 20)

POSES = {
    "point": "Index finger up",
    "pinch": "Thumb and index finger touching",
    "pinch_middle": "Thumb and middle finger touching",
    "peace": "Index and middle finger up (V)",
    "three": "Three fingers up",
    "open_palm": "Open hand, all fingers up",
    "fist": "Closed fist",
    "thumbs_up": "Thumbs up",
    "rock": "Index and pinky up",
    "thumbs_down": "Thumbs down",
    "call": "Only the pinky up (call-me sign)",
    "four": "Four fingers up, thumb folded in",
}

# Pinch hysteresis: touching below ENTER, released above EXIT (fraction of palm size).
PINCH_ENTER = 0.30
PINCH_EXIT = 0.45
# A pinching finger reaches out from its knuckle; a curled finger (fist, or the
# thumb resting on it) does not. Fraction of palm size.
PINCH_REACH = 0.5


def dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def palm_size(lm) -> float:
    return max(1e-6, dist(lm[WRIST], lm[MIDDLE[0]]))


def finger_up(lm, finger) -> bool:
    """A finger is extended when its tip is clearly farther from the wrist than its
    middle joint. Rotation independent."""
    mcp, pip, _, tip = finger
    w = lm[WRIST]
    return dist(w, lm[tip]) > dist(w, lm[pip]) * 1.12 and dist(w, lm[tip]) > dist(w, lm[mcp]) * 1.25


def thumb_out(lm) -> bool:
    """Thumb sticks out away from the palm."""
    p = palm_size(lm)
    return dist(lm[THUMB[3]], lm[INDEX[0]]) > 0.55 * p and dist(lm[THUMB[3]], lm[PINKY[0]]) > 0.9 * p


def fingers(lm) -> dict:
    return {
        "thumb": thumb_out(lm),
        "index": finger_up(lm, INDEX),
        "middle": finger_up(lm, MIDDLE),
        "ring": finger_up(lm, RING),
        "pinky": finger_up(lm, PINKY),
    }


def pinch_ratio(lm, tip=INDEX[3]) -> float:
    return dist(lm[THUMB[3]], lm[tip]) / palm_size(lm)


def reach(lm, finger) -> float:
    return dist(lm[finger[3]], lm[finger[0]]) / palm_size(lm)


def classify(lm, was_pinched: bool = False, was_pinched_middle: bool = False) -> str:
    """Return one pose name from POSES, or "none".

    was_pinched* carry the previous state so a pinch does not flicker at the edge."""
    if lm is None or len(lm) < 21:
        return "none"
    f = fingers(lm)
    pi = pinch_ratio(lm, INDEX[3])
    pm = pinch_ratio(lm, MIDDLE[3])
    others_up = (f["middle"] + f["ring"] + f["pinky"]) >= 2
    # Thumb on index: a pinch when the index reaches out, or when two or more of the
    # other fingers are up (an OK sign, where the index curls into a ring). With everything curled
    # it is a fist with the thumb resting on the index.
    if pi < (PINCH_EXIT if was_pinched else PINCH_ENTER) and (reach(lm, INDEX) > PINCH_REACH or others_up):
        return "pinch"
    # Thumb on middle, index free. Pinky down, so the rock sign (thumb holding the
    # middle and ring fingers) is not taken for it.
    if (pm < (PINCH_EXIT if was_pinched_middle else PINCH_ENTER) and pi > PINCH_EXIT
            and reach(lm, MIDDLE) > PINCH_REACH and not f["pinky"]):
        return "pinch_middle"
    up = [f["index"], f["middle"], f["ring"], f["pinky"]]
    n = sum(up)
    p = palm_size(lm)
    t_tip, t_mcp = lm[THUMB[3]], lm[THUMB[1]]
    if n == 0:
        # thumb pointing down: tip clearly below its base (a fist's thumb sits above it)
        if (t_tip[1] - t_mcp[1]) > 0.3 * p and dist(t_tip, t_mcp) > 0.4 * p:
            return "thumbs_down"
        # thumbs up: thumb out and pointing up in the image
        if f["thumb"] and (t_mcp[1] - t_tip[1]) > 0.5 * p:
            return "thumbs_up"
        return "fist"
    if up == [False, False, False, True]:
        return "call"
    if up == [True, False, False, False]:
        return "point"
    if up == [True, True, False, False]:
        return "peace"
    if up == [True, True, True, False]:
        return "three"
    if up == [True, False, False, True]:
        return "rock"
    if n == 4:
        # thumb folded across the palm (tip near the pinky knuckle) = four; else open hand
        return "four" if dist(t_tip, lm[PINKY[0]]) < 0.66 * p else "open_palm"
    return "none"
