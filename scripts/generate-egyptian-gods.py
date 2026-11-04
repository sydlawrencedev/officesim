#!/usr/bin/env python3
"""Generate Egyptian god character spritesheets from the long- and short-haired base sprites.

Each god recolours a base body (skin, hair, robe, eyes) and then draws pixel
details (animal heads, ears, horns, crowns, sun disks...) anchored to the head
in every frame so they follow the walk/typing/reading bobs. Animal-headed gods
get fur for skin and solid animal eyes so they read as clearly not human.
"""
from __future__ import annotations

import colorsys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CHAR_DIR = ROOT / "public" / "assets" / "characters"
FIRST_INDEX = 82
FRAME_W, FRAME_H, FRAMES, ROWS = 16, 32, 7, 3
DIRS = ["down", "up", "right"]

RGB = tuple[int, int, int]

GOLD: RGB = (222, 178, 60)
GOLD_LIGHT: RGB = (246, 214, 110)
GOLD_DARK: RGB = (164, 120, 34)
SUN: RGB = (246, 196, 72)
LAPIS: RGB = (48, 88, 170)

# Explicit colour -> role maps for the two base bodies.
BASES: dict[str, dict] = {
    "long": {
        "file": "char_1.png",
        "roles": {
            "hair": [(135, 58, 32), (181, 115, 76), (199, 148, 118), (216, 179, 157)],
            "skin": [(213, 174, 152), (224, 195, 178), (208, 164, 138), (233, 212, 200),
                     (191, 134, 102), (196, 142, 111)],
            "robe": [(27, 35, 47), (31, 41, 55), (19, 25, 33)],
            "iris": [(26, 67, 132), (30, 75, 148), (28, 72, 142)],
            "eyewhite": [(255, 255, 255)],
        },
        "ref": {"hair": (135, 58, 32), "skin": (213, 174, 152), "robe": (27, 35, 47), "iris": (26, 67, 132)},
    },
    "short": {
        "file": "char_4.png",
        "roles": {
            "hair": [(63, 39, 25), (44, 28, 18), (81, 51, 32), (95, 60, 37), (50, 41, 41)],
            "skin": [(219, 174, 146), (203, 142, 104), (214, 164, 132), (228, 195, 174),
                     (236, 212, 197), (199, 135, 94)],
            "robe": [(212, 212, 212), (238, 238, 238), (189, 189, 189), (81, 70, 71)],
            "legs": [(7, 28, 46), (47, 57, 74), (53, 64, 83), (39, 51, 67), (19, 25, 33)],
            "belt": [(10, 14, 16)],
            "iris": [(84, 73, 74), (95, 82, 83)],
            "eyewhite": [(255, 255, 255)],
        },
        "ref": {"hair": (63, 39, 25), "skin": (219, 174, 146), "robe": (212, 212, 212),
                "legs": (53, 64, 83), "iris": (84, 73, 74)},
    },
}

# animal=True: skin becomes fur and the eye whites take the iris colour.
GODS: list[dict] = [
    dict(name="thoth", base="short", skin=(238, 234, 224), hair=(238, 234, 224), robe=(28, 102, 112),
         iris=(214, 160, 40), animal=True),
    dict(name="geb", base="short", skin=(112, 86, 68), hair=(42, 36, 30), robe=(92, 112, 56),
         iris=(60, 44, 30)),
    dict(name="ra", base="short", skin=(214, 160, 112), hair=(222, 170, 52), robe=(140, 42, 26),
         iris=(60, 34, 20)),
    dict(name="bastet", base="short", skin=(226, 194, 156), hair=(214, 180, 142), robe=(96, 48, 112),
         iris=(234, 196, 60), animal=True),
    dict(name="isis", base="long", skin=(200, 138, 98), hair=(28, 24, 22), robe=(30, 76, 118),
         iris=(40, 30, 24)),
    dict(name="hathor", base="long", skin=(214, 160, 124), hair=(78, 28, 44), robe=(140, 44, 76),
         iris=(214, 160, 40)),
    dict(name="sekhmet", base="short", skin=(222, 146, 72), hair=(176, 76, 40), robe=(142, 40, 28),
         iris=(246, 206, 70), animal=True),
    dict(name="khnum", base="short", skin=(204, 178, 140), hair=(186, 158, 118), robe=(104, 72, 40),
         iris=(214, 160, 40), animal=True),
    dict(name="maat", base="long", skin=(216, 172, 132), hair=(24, 30, 26), robe=(30, 82, 66),
         iris=(40, 30, 24)),
    dict(name="seshat", base="long", skin=(198, 146, 112), hair=(18, 22, 30), robe=(36, 54, 94),
         iris=(120, 160, 200)),
    dict(name="ptah", base="short", skin=(222, 204, 172), hair=(36, 36, 36), robe=(70, 70, 66),
         iris=(196, 150, 40)),
    dict(name="anubis", base="short", skin=(40, 40, 46), hair=(30, 30, 36), robe=(52, 38, 66),
         iris=(234, 180, 40), animal=True),
]


def hls(rgb: RGB) -> tuple[float, float, float]:
    return colorsys.rgb_to_hls(*(c / 255 for c in rgb))


def shade(target: RGB, src: RGB, ref: RGB, k: float = 0.9) -> RGB:
    """Move `target` by the lightness offset `src` has from the role's reference shade."""
    th, tl, ts = hls(target)
    _, sl, _ = hls(src)
    _, rl, _ = hls(ref)
    nl = max(0.04, min(0.97, tl + (sl - rl) * k))
    r, g, b = colorsys.hls_to_rgb(th, nl, ts)
    return (round(r * 255), round(g * 255), round(b * 255))


def lighten(c: RGB, amt: float) -> RGB:
    h, l, s = hls(c)
    r, g, b = colorsys.hls_to_rgb(h, max(0.0, min(1.0, l + amt)), s)
    return (round(r * 255), round(g * 255), round(b * 255))


def mix(a: RGB, b: RGB, t: float) -> RGB:
    return tuple(round(x * (1 - t) + y * t) for x, y in zip(a, b))  # type: ignore[return-value]


class Frame:
    def __init__(self, img: Image.Image, base: dict, direction: str):
        self.img = img
        self.px = img.load()
        self.dir = direction
        lookup = {c: role for role, cols in base["roles"].items() for c in cols}
        self.role = [[lookup.get(self.px[x, y][:3]) if self.px[x, y][3] else None
                      for x in range(FRAME_W)] for y in range(FRAME_H)]
        hair_rows = [y for y in range(FRAME_H) if any(r == "hair" for r in self.role[y])]
        self.top = hair_rows[0]
        xs = [x for y in range(self.top, self.top + 6) for x in range(FRAME_W) if self.role[y][x] == "hair"]
        self.x0, self.x1 = min(xs), max(xs)
        self.cx = (self.x0 + self.x1) // 2
        eye_rows = [y for y in range(self.top, min(FRAME_H, self.top + 16))
                    if any(r == "eyewhite" for r in self.role[y])]
        self.eye = eye_rows[0] if eye_rows else None
        self.eye_last = eye_rows[-1] if eye_rows else None
        # Right-facing sprites: the face is on the right side of the head.
        face = [x for y in eye_rows for x in range(FRAME_W) if self.role[y][x] == "skin"]
        self.face_x1 = max(face) if face else self.x1
        robe_rows = [y for y in range(self.top + 6, FRAME_H)
                     if any(r == "robe" for r in self.role[y])]
        self.neck = robe_rows[0] if robe_rows else self.top + 16

    def put(self, x: int, y: int, c: RGB) -> None:
        if 0 <= x < FRAME_W and 0 <= y < FRAME_H:
            self.px[x, y] = (*c, 255)

    def clear(self, x: int, y: int) -> None:
        if 0 <= x < FRAME_W and 0 <= y < FRAME_H:
            self.px[x, y] = (0, 0, 0, 0)
            self.role[y][x] = None

    def is_role(self, x: int, y: int, *roles: str) -> bool:
        return 0 <= x < FRAME_W and 0 <= y < FRAME_H and self.role[y][x] in roles

    def opaque(self, x: int, y: int) -> bool:
        return 0 <= x < FRAME_W and 0 <= y < FRAME_H and self.px[x, y][3] > 0

    def row_span(self, y: int, *roles: str) -> list[int]:
        return [x for x in range(FRAME_W) if self.role[y][x] in roles]


def recolor(f: Frame, base: dict, god: dict) -> None:
    hair, robe = god["hair"], god["robe"]
    animal = god.get("animal", False)
    targets = {"skin": god["skin"], "hair": hair, "robe": robe, "iris": god["iris"],
               "legs": lighten(robe, -0.12), "belt": GOLD}
    if animal:
        targets["eyewhite"] = god["iris"]
    ref = dict(base["ref"])
    ref["eyewhite"] = (255, 255, 255)
    for y in range(FRAME_H):
        for x in range(FRAME_W):
            role = f.role[y][x]
            if role not in targets:
                continue
            src = f.px[x, y][:3]
            if role == "belt":
                f.put(x, y, GOLD)
            elif role == "eyewhite":
                f.put(x, y, god["iris"])
            elif role == "hair":
                # Softer stripes, plus a dark rim so pale hair keeps its silhouette.
                edge = any(not f.opaque(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                c = shade(hair, src, ref["hair"], 0.55 if not animal else 0.35)
                f.put(x, y, mix(hair, (34, 34, 44), 0.6) if edge and hls(hair)[1] > 0.5 else c)
            elif role == "skin" and animal:
                f.put(x, y, shade(targets["skin"], src, ref["skin"], 0.5))
            else:
                f.put(x, y, shade(targets[role], src, ref[role]))
    collar(f)


def collar(f: Frame) -> None:
    """Egyptian broad collar: a gold row then a lapis/gold beaded row over the shoulders."""
    y = f.neck
    for x in f.row_span(y, "robe"):
        f.put(x, y, GOLD)
    if f.dir != "up":
        for x in f.row_span(y + 1, "robe"):
            f.put(x, y + 1, LAPIS if x % 2 else GOLD_LIGHT)


# ─── accessories ──────────────────────────────────────────────────────────────

def hair_band(f: Frame, y: int, colors: list[RGB]) -> None:
    for i, x in enumerate(f.row_span(y, "hair")):
        f.put(x, y, colors[i % len(colors)])


def clear_top(f: Frame, rows: int) -> None:
    """Trim the base's spiky hair tuft so animal ears / crowns sit on a rounded head."""
    for y in range(f.top, f.top + rows):
        for x in f.row_span(y, "hair"):
            f.clear(x, y)


def ears(f: Frame, fur: RGB, inner: RGB, tall: bool = False) -> None:
    """Big pointed ears rising from the head (rows f.top..f.top+3, freed by clear_top)."""
    outline = mix(fur, (16, 16, 22), 0.65)
    spots = [f.x0 + 4, f.x0 + 8] if f.dir == "right" else [f.x0 + 3, f.x1 - 3]
    # (row offset from f.top, half-width); tall ears are narrower and pointier.
    shape = [(0, 0), (1, 0), (2, 1), (3, 1)] if tall else [(0, 0), (1, 1), (2, 1), (3, 2)]
    for x in spots:
        for dy, hw in shape:
            y = f.top + dy
            for dx in range(-hw, hw + 1):
                f.put(x + dx, y, fur)
            if f.dir != "up" and dy >= 1 and hw >= 1:
                f.put(x, y, inner)
            if dy < 3:
                f.put(x - hw - 1, y, outline)
                f.put(x + hw + 1, y, outline)
        f.put(x, f.top - 1, outline)


def muzzle(f: Frame, color: RGB, nose: RGB, length: int = 1) -> None:
    """Animal muzzle: lighter patch + nose below the eyes, protruding in side view."""
    if f.eye_last is None or f.dir == "up":
        return
    y = f.eye_last
    if f.dir == "down":
        for x in range(f.cx - 1, f.cx + 3):
            if f.is_role(x, y + 1, "skin", "hair"):
                f.put(x, y + 1, color)
        f.put(f.cx, y, nose)
        f.put(f.cx + 1, y, nose)
    else:
        x1 = f.face_x1
        for i in range(length + 1):
            f.put(x1 + i, y, color)
            f.put(x1 + i, y + 1, color)
        f.put(x1 + length, y, nose)
        f.put(x1 + length + 1, y, nose) if length > 1 else None


def disk(f: Frame, y: int, x: int, color: RGB = SUN, rim: RGB = GOLD_DARK) -> None:
    """A tiny 3x2 sun disk centred on x (top row at y)."""
    for dx in (-1, 0, 1):
        f.put(x + dx, y + 1, color)
    f.put(x, y, color)
    f.put(x - 1, y, rim)
    f.put(x + 1, y, rim)


def accessory(f: Frame, god: dict) -> None:
    name, d = god["name"], f.dir
    fur, hair = god["skin"], god["hair"]
    cx = f.cx if d != "right" else f.cx - 1
    if name == "thoth":
        # Ibis head: long curved dark beak, moon disk on top.
        clear_top(f, 3)
        disk(f, f.top + 1, cx, (240, 214, 120), GOLD)
        beak, beak_hi = (84, 92, 110), (168, 174, 190)
        if f.eye_last is not None:
            y = f.eye_last
            if d == "right":
                # Long beak from the face, curving down at the tip.
                for x in range(f.face_x1 - 1, FRAME_W):
                    f.put(x, y + 1, beak)
                for x in range(f.face_x1 - 1, FRAME_W - 2):
                    f.put(x, y, beak_hi)
                f.put(FRAME_W - 1, y + 2, beak)
            elif d == "down":
                # Seen head-on the beak hangs down over the chest.
                for i in range(6):
                    x = f.cx + (1 if i >= 3 else 0)
                    f.put(x, y + i, beak)
                    f.put(x + 1, y + i, beak_hi if i < 4 else beak)
    elif name == "geb":
        # Goose perched on his head.
        clear_top(f, 3)
        goose, goose_dark = GOLD, GOLD_DARK
        y = f.top + 2
        if d == "right":
            for x in range(cx - 1, cx + 2):
                f.put(x, y, goose)
            f.put(cx + 2, y - 1, goose)
            f.put(cx + 3, y - 1, (40, 30, 20))
            f.put(cx - 2, y - 1, goose_dark)
        else:
            for x in range(cx - 1, cx + 3):
                f.put(x, y, goose)
            f.put(cx, y - 1, goose)
            f.put(cx + 1, y - 1, goose_dark)
            if d == "down":
                f.put(cx, y - 1, (40, 30, 20))
    elif name == "ra":
        # Gold nemes-style crown with red peak, sun disk above.
        clear_top(f, 3)
        disk(f, f.top + 1, cx)
        for i in range(2):
            y = f.top + 3 + i
            for x in f.row_span(y, "hair"):
                f.put(x, y, (176, 42, 30) if i == 0 else (214, 64, 40))
        # Blue nemes stripes on the headcloth.
        for y in range(f.top + 6, f.neck, 2):
            for x in f.row_span(y, "hair"):
                f.put(x, y, LAPIS)
        if f.eye is not None:
            # Gold mask band across the eyes, like the avatar.
            for x in f.row_span(f.eye - 1, "skin"):
                f.put(x, f.eye - 1, GOLD)
    elif name == "bastet":
        clear_top(f, 3)
        ears(f, fur, (232, 150, 170))
        muzzle(f, (250, 240, 226), (224, 110, 136))
        if f.eye_last is not None and d == "down":
            # Whiskers poking out of the cheeks.
            y = f.eye_last + 1
            f.put(f.x0 - 1, y, (250, 246, 236))
            f.put(f.x1 + 1, y, (250, 246, 236))
    elif name == "isis":
        # Throne hieroglyph headdress + gold wings on the shoulders.
        x = cx
        f.put(x - 1, f.top - 2, GOLD)
        f.put(x, f.top - 2, GOLD_LIGHT)
        f.put(x + 1, f.top - 1, GOLD)
        f.put(x - 1, f.top - 1, GOLD)
        f.put(x, f.top - 1, GOLD)
        hair_band(f, f.top + 1, [GOLD, GOLD_LIGHT])
        if d != "up":
            y = f.neck + 1
            robe = f.row_span(y, "robe")
            if robe:
                f.put(min(robe) - 1, y, GOLD_LIGHT)
                f.put(max(robe) + 1, y, GOLD_LIGHT)
    elif name == "hathor":
        # Sun disk cradled between cow horns.
        horn, horn_dark = GOLD_LIGHT, GOLD
        disk(f, f.top - 2, cx, (240, 90, 60), GOLD)
        if d == "right":
            f.put(cx - 3, f.top, horn_dark)
            f.put(cx - 3, f.top - 1, horn)
            f.put(cx - 2, f.top - 2, horn)
        else:
            for side in (-1, 1):
                x = cx + side * 3 + (1 if side > 0 else 0)
                f.put(x, f.top, horn_dark)
                f.put(x, f.top - 1, horn)
                f.put(x - side, f.top - 2, horn)
    elif name == "sekhmet":
        # Lioness: mane stays as hair, pointed ears, muzzle, sun disk between the ears.
        clear_top(f, 3)
        ears(f, fur, (160, 50, 30))
        muzzle(f, (246, 206, 150), (60, 26, 20))
        for y in range(f.top + 4, f.neck):
            for x in (f.x0, f.x1):
                if f.is_role(x, y, "hair") and y % 2:
                    f.put(x, y, (140, 40, 26))
    elif name == "khnum":
        # Ram: curled golden horns and a tall crown.
        clear_top(f, 3)
        f.put(cx, f.top, GOLD_LIGHT)
        f.put(cx + (1 if d != "right" else 0), f.top, GOLD)
        f.put(cx, f.top + 1, GOLD)
        f.put(cx + (1 if d != "right" else 0), f.top + 1, GOLD_DARK)
        f.put(cx, f.top + 2, GOLD)
        horn, horn_dark = (244, 228, 160), (170, 132, 56)
        if f.eye is not None or d == "up":
            y = (f.eye if f.eye is not None else f.top + 13) - 4
            sides = [(f.x0 + 2, 1)] if d == "right" else [(f.x0, 1), (f.x1, -1)]
            for x, s in sides:
                # 3x4 curled horn: over the top, down the outside, curling back in.
                for dx in range(3):
                    f.put(x + s * dx, y, horn)
                f.put(x, y + 1, horn)
                f.put(x + s * 2, y + 1, horn_dark)
                f.put(x, y + 2, horn)
                f.put(x + s, y + 2, horn_dark)
                f.put(x + s, y + 3, horn)
        muzzle(f, (236, 222, 196), (110, 84, 60))
    elif name == "maat":
        # Ostrich feather of truth rising from a gold headband.
        hair_band(f, f.top + 2, [GOLD, GOLD_LIGHT])
        x = cx + 1
        f.put(x, f.top - 2, (250, 250, 244))
        f.put(x, f.top - 1, (232, 240, 226))
        f.put(x - 1, f.top - 1, (250, 250, 244))
        f.put(x, f.top, (206, 220, 200))
        f.put(x, f.top + 1, GOLD)
    elif name == "seshat":
        # Seven-pointed star rosette headdress.
        x = cx
        f.put(x - 1, f.top - 2, GOLD)
        f.put(x, f.top - 2, GOLD_LIGHT)
        f.put(x + 1, f.top - 2, GOLD)
        f.put(x - 1, f.top - 1, GOLD)
        f.put(x, f.top - 1, (24, 36, 70))
        f.put(x + 1, f.top - 1, GOLD)
        f.put(x, f.top, GOLD_DARK)
        hair_band(f, f.top + 2, [GOLD])
    elif name == "ptah":
        # Pale-faced craftsman god: skullcap, straight beard, gold was-sceptre.
        clear_top(f, 3)
        if f.eye_last is not None and d != "up":
            bx = f.cx if d == "down" else f.face_x1 - 1
            for y in range(f.eye_last + 1, f.eye_last + 5):
                f.put(bx, y, (30, 30, 32))
                f.put(bx + 1, y, (54, 54, 56) if d == "down" else (30, 30, 32))
        if d != "up":
            x = 1 if d == "down" else FRAME_W - 2
            for y in range(f.neck + 1, min(FRAME_H - 2, f.neck + 11)):
                f.put(x, y, GOLD)
            f.put(x, f.neck, GOLD_LIGHT)
            f.put(x + (1 if d == "down" else -1), f.neck, GOLD_LIGHT)
    elif name == "anubis":
        # Jackal: tall black ears with gold insides, long muzzle.
        clear_top(f, 3)
        ears(f, fur, GOLD_LIGHT, tall=True)
        muzzle(f, (58, 58, 66), (10, 10, 12), 2)
        if d != "up":
            hair_band(f, f.top + 3, [lighten(hair, 0.06)])


def build(god: dict) -> Image.Image:
    base = BASES[god["base"]]
    src = Image.open(CHAR_DIR / base["file"]).convert("RGBA")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    for row in range(ROWS):
        for col in range(FRAMES):
            box = (col * FRAME_W, row * FRAME_H, (col + 1) * FRAME_W, (row + 1) * FRAME_H)
            f = Frame(src.crop(box), base, DIRS[row])
            recolor(f, base, god)
            accessory(f, god)
            out.paste(f.img, box[:2])
    return out


def main() -> None:
    for i, god in enumerate(GODS):
        path = CHAR_DIR / f"char_{FIRST_INDEX + i}.png"
        build(god).save(path)
        print(f"{path.name}: {god['name']}")


if __name__ == "__main__":
    main()
