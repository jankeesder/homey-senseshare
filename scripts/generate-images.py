#!/usr/bin/env python3
"""Generates the App Store and driver PNG images with Pillow.

Usage: python3 scripts/generate-images.py   (from the app root)

App images:    250x175, 500x350, 1000x700  (isometric landscape: houses and
               sensor stations linked by radio)
Driver images: 75x75, 500x500, 1000x1000   (device on a white background)
Everything is drawn at 2x the largest size and scaled down for smooth edges.
"""

import math
from functools import partial
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = (47, 125, 91)
BRAND_DARK = (31, 92, 66)
WHITE = (255, 255, 255)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def shade(colour, factor):
    return tuple(max(0, min(255, round(v * factor))) for v in colour)


def circle(cx, cy, r):
    return [cx - r, cy - r, cx + r, cy + r]


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        draw.line([(0, y), (width, y)], fill=mix(top, bottom, y / max(1, height - 1)))
    return image


def station(draw, x, y, s, body, accent, pole=0.9):
    """A small sensor station seen from the front: box on a pole with an antenna."""
    draw.rectangle([x + s * 0.47, y + s * 0.9, x + s * 0.53, y + s * (1 + pole)], fill=body)
    draw.rounded_rectangle([x, y, x + s, y + s], radius=s * 0.12, fill=body)
    for i in range(3):
        top = y + s * (0.3 + i * 0.2)
        draw.rounded_rectangle([x + s * 0.2, top, x + s * 0.8, top + s * 0.07], radius=s * 0.03, fill=accent)
    draw.line([(x + s * 0.8, y), (x + s * 0.8, y - s * 0.45)], fill=body, width=max(2, round(s * 0.07)))
    for radius in (0.22, 0.4):
        rr = s * radius
        cx, cy = x + s * 0.8, y - s * 0.45
        draw.arc([cx - rr, cy - rr, cx + rr, cy + rr], start=200, end=340, fill=body, width=max(2, round(s * 0.06)))


# ------------------------------------------------------------ app image parts

class Iso:
    """Isometric projection of tile coordinates (x, y on the ground, z up)."""

    def __init__(self, cx, cy, k):
        self.cx, self.cy, self.k = cx, cy, k

    def p(self, x, y, z=0.0):
        return (self.cx + (x - y) * 0.866 * self.k, self.cy + (x + y) * 0.5 * self.k - z * self.k)


def cloud(draw, cx, cy, s, fill):
    for dx, dy, rx, ry in ((0, 0.22, 0.95, 0.26), (-0.5, 0.05, 0.36, 0.32), (0.05, -0.12, 0.45, 0.42),
                           (0.55, 0.06, 0.34, 0.3)):
        draw.ellipse([cx + (dx - rx) * s, cy + (dy - ry) * s, cx + (dx + rx) * s, cy + (dy + ry) * s], fill=fill)


def iso_house(draw, iso, x0, x1, y0, y1, h, rise, wall, roof, window, ridge="x"):
    P = iso.p
    wall_left, wall_right = wall, shade(wall, 0.82)
    draw.polygon([P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, h), P(x0, y1, h)], fill=wall_left)
    draw.polygon([P(x1, y0, 0), P(x1, y1, 0), P(x1, y1, h), P(x1, y0, h)], fill=wall_right)
    # windows and a door on the visible walls
    for xa, xb in ((x0 + 0.18 * (x1 - x0), x0 + 0.36 * (x1 - x0)), (x0 + 0.64 * (x1 - x0), x0 + 0.82 * (x1 - x0))):
        draw.polygon([P(xa, y1, h * 0.45), P(xb, y1, h * 0.45), P(xb, y1, h * 0.78), P(xa, y1, h * 0.78)], fill=window)
    xa, xb = x0 + 0.44 * (x1 - x0), x0 + 0.56 * (x1 - x0)
    draw.polygon([P(xa, y1, 0), P(xb, y1, 0), P(xb, y1, h * 0.62), P(xa, y1, h * 0.62)], fill=shade(roof, 0.7))
    ya, yb = y0 + 0.35 * (y1 - y0), y0 + 0.65 * (y1 - y0)
    draw.polygon([P(x1, ya, h * 0.45), P(x1, yb, h * 0.45), P(x1, yb, h * 0.78), P(x1, ya, h * 0.78)],
                 fill=shade(window, 0.88))
    light_roof, dark_roof = roof, shade(roof, 0.78)
    if ridge == "x":
        ym = (y0 + y1) / 2
        draw.polygon([P(x0, ym, h + rise), P(x1, ym, h + rise), P(x1, y0, h), P(x0, y0, h)], fill=dark_roof)
        draw.polygon([P(x1, y0, h), P(x1, y1, h), P(x1, ym, h + rise)], fill=wall_right)
        draw.polygon([P(x0 - 0.06, ym, h + rise), P(x1 + 0.06, ym, h + rise), P(x1 + 0.06, y1 + 0.08, h - 0.05),
                      P(x0 - 0.06, y1 + 0.08, h - 0.05)], fill=light_roof)
    else:
        xm = (x0 + x1) / 2
        draw.polygon([P(xm, y0, h + rise), P(xm, y1, h + rise), P(x0, y1, h), P(x0, y0, h)], fill=light_roof)
        draw.polygon([P(x0, y1, h), P(x1, y1, h), P(xm, y1, h + rise)], fill=wall_left)
        draw.polygon([P(xm, y0 - 0.06, h + rise), P(xm, y1 + 0.06, h + rise), P(x1 + 0.08, y1 + 0.06, h - 0.05),
                      P(x1 + 0.08, y0 - 0.06, h - 0.05)], fill=dark_roof)


def iso_shadow(draw, iso, x, y, r, fill):
    gx, gy = iso.p(x, y)
    R = r * iso.k
    draw.ellipse([gx - R * 0.95, gy - R * 0.5, gx + R * 0.95, gy + R * 0.5], fill=fill)


def iso_tree(draw, iso, x, y, h, r, leaf, light, trunk, shadow):
    iso_shadow(draw, iso, x + 0.1, y + 0.1, r, shadow)
    ground, top = iso.p(x, y), iso.p(x, y, h)
    draw.line([ground, top], fill=trunk, width=round(iso.k * 0.1))
    R = r * iso.k
    draw.ellipse(circle(top[0], top[1], R), fill=leaf)
    draw.ellipse([top[0] - R * 0.72, top[1] - R * 0.8, top[0] + R * 0.1, top[1] - R * 0.05], fill=light)


def iso_pine(draw, iso, x, y, h, r, leaf, light, trunk, shadow):
    iso_shadow(draw, iso, x + 0.1, y + 0.1, r * 0.8, shadow)
    R = r * iso.k
    draw.line([iso.p(x, y), iso.p(x, y, h * 0.3)], fill=trunk, width=round(iso.k * 0.1))
    for t0, f in ((0.2, 1.0), (0.45, 0.8), (0.68, 0.58)):
        base = iso.p(x, y, h * t0)
        top = iso.p(x, y, h * (t0 + 0.42))
        draw.polygon([top, (base[0] - R * f, base[1]), (base[0] + R * f, base[1])], fill=leaf)
        draw.polygon([top, (base[0] - R * f, base[1]), (base[0] - R * f * 0.1, base[1])], fill=light)


def iso_station(draw, iso, x, y, pole, b, body, vent, shadow):
    """Sensor box on a pole with an antenna. Returns the antenna tip."""
    P = iso.p
    iso_shadow(draw, iso, x + 0.08, y + 0.08, 0.22, shadow)
    draw.line([P(x, y, 0), P(x, y, pole)], fill=shade(body, 0.75), width=round(iso.k * 0.07))
    x0, x1, y0, y1, z0, z1 = x - b / 2, x + b / 2, y - b / 2, y + b / 2, pole, pole + b
    draw.polygon([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)], fill=body)
    draw.polygon([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)], fill=shade(body, 0.8))
    draw.polygon([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], fill=body)
    for i in range(3):
        z = z0 + b * (0.25 + 0.22 * i)
        draw.polygon([P(x0 + b * 0.18, y1, z), P(x1 - b * 0.18, y1, z), P(x1 - b * 0.18, y1, z + b * 0.08),
                      P(x0 + b * 0.18, y1, z + b * 0.08)], fill=vent)
    base = P(x1 - b * 0.15, y0 + b * 0.15, z1)
    tip = P(x1 - b * 0.15, y0 + b * 0.15, z1 + b * 0.9)
    draw.line([base, tip], fill=body, width=round(iso.k * 0.05))
    return tip


def waves(draw, tip, s, colour, count=2):
    cx, cy = tip
    for i in range(count):
        draw.arc(circle(cx, cy, s * (0.24 + 0.2 * i)), start=205, end=335, fill=colour, width=max(2, round(s * 0.06)))


def link_dots(a, b, lift, gap, steps=400):
    """Evenly spaced points on an upward arc from a to b, without the ends."""
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift)
    curve = []
    for i in range(steps + 1):
        t = i / steps
        curve.append(((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * mid[0] + t * t * b[0],
                      (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * mid[1] + t * t * b[1]))
    dots, travelled = [], 0.0
    for p, q in zip(curve, curve[1:]):
        travelled += math.dist(p, q)
        if travelled >= gap:
            dots.append(q)
            travelled = 0.0
    return dots[1:-1]


def river_x(y):
    return 6.4 - 0.25 * y + 0.8 * math.sin(y * 0.75)


def app_image():
    """A floating piece of land with a village, a farm, a river and fields.
    Four sensor stations, at houses and out in the landscape, form a radio mesh."""
    width, height = 2000, 1400
    image = vertical_gradient((width, height), (206, 234, 244), (232, 246, 238))
    shadow_mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(shadow_mask).ellipse([260, 1250, 1740, 1370], fill=90)
    image.paste(Image.new("RGB", image.size, (120, 160, 150)), (0, 0), shadow_mask.filter(ImageFilter.GaussianBlur(40)))
    draw = ImageDraw.Draw(image)
    cloud(draw, 300, 260, 120, WHITE)
    cloud(draw, 1720, 330, 95, WHITE)

    n, thickness = 10, 0.75
    iso = Iso(1000, 290, 92)
    P = iso.p

    # the tile: grass on top, a grass edge and soil on the sides
    draw.polygon([P(0, n, 0), P(n, n, 0), P(n, n, -0.16), P(0, n, -0.16)], fill=(96, 166, 110))
    draw.polygon([P(n, 0, 0), P(n, n, 0), P(n, n, -0.16), P(n, 0, -0.16)], fill=(78, 144, 96))
    draw.polygon([P(0, n, -0.16), P(n, n, -0.16), P(n, n, -thickness), P(0, n, -thickness)], fill=(176, 128, 92))
    draw.polygon([P(n, 0, -0.16), P(n, n, -0.16), P(n, n, -thickness), P(n, 0, -thickness)], fill=(146, 104, 76))
    draw.polygon([P(0, 0), P(n, 0), P(n, n), P(0, n)], fill=(128, 196, 140))

    for (x0, x1, y0, y1), crop in (((7.4, 8.5, 0.4, 2.3), (210, 206, 120)), ((8.65, 9.7, 0.4, 2.3), (160, 204, 116)),
                                   ((7.4, 8.5, 2.45, 4.4), (150, 196, 110)), ((8.65, 9.7, 2.45, 4.4), (220, 190, 110))):
        draw.polygon([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], fill=crop)
        for i in range(1, 6):
            row = y0 + (y1 - y0) * i / 6
            draw.line([P(x0 + 0.05, row), P(x1 - 0.05, row)], fill=shade(crop, 0.88), width=4)

    # river, with its cut in the front side
    half = 0.48
    ys = [i / 20 * n for i in range(21)]
    draw.polygon([P(river_x(y) - half, y) for y in ys] + [P(river_x(y) + half, y) for y in reversed(ys)],
                 fill=(96, 170, 220))
    draw.line([P(river_x(y) + 0.12, y) for y in ys], fill=(160, 210, 238), width=8)
    rx = river_x(n)
    draw.polygon([P(rx - half, n, 0), P(rx + half, n, 0), P(rx + half, n, -0.12), P(rx - half, n, -0.12)],
                 fill=(80, 150, 200))

    # path from the village over a bridge to the farm
    draw.line([P(x, y) for x, y in ((2.2, 2.4), (3.6, 4.6), (4.6, 5.6), (6.0, 6.2), (7.2, 6.6))],
              fill=(226, 212, 168), width=16, joint="curve")
    bx = river_x(5.75)
    draw.polygon([P(bx - 0.7, 5.5, 0.05), P(bx + 0.7, 5.8, 0.05), P(bx + 0.7, 6.1, 0.05), P(bx - 0.7, 5.8, 0.05)],
                 fill=(150, 104, 72))

    # everything standing on the tile, drawn back to front
    shadow, trunk = (108, 176, 122), (120, 90, 66)
    objects = []
    for x0, x1, y0, y1, h, rise, wall, roof, ridge in (
            (1.0, 2.1, 1.0, 1.8, 0.75, 0.45, (250, 244, 232), (204, 88, 66), "x"),
            (2.7, 3.5, 2.9, 3.9, 0.7, 0.42, (246, 238, 222), (90, 96, 110), "y"),
            (0.9, 1.8, 3.6, 4.5, 0.65, 0.4, (250, 244, 232), (186, 78, 58), "x"),
            (7.0, 8.4, 6.1, 7.3, 0.9, 0.6, (196, 74, 62), (88, 88, 98), "y"),
            (8.0, 9.0, 8.0, 8.8, 0.7, 0.42, (250, 244, 232), (204, 88, 66), "x")):
        objects.append((x1 + y1 - 0.4, partial(iso_house, draw, iso, x0, x1, y0, y1, h, rise, wall, roof,
                                               (176, 214, 232), ridge)))
    for x, y, h, r in ((0.5, 0.5, 1.0, 0.42), (3.3, 0.7, 0.9, 0.38), (4.2, 2.0, 1.1, 0.45), (0.5, 2.5, 0.9, 0.36),
                       (1.2, 6.3, 1.0, 0.42), (2.4, 9.0, 0.9, 0.4), (0.8, 8.3, 0.8, 0.34), (5.6, 9.4, 0.9, 0.36)):
        objects.append((x + y, partial(iso_tree, draw, iso, x, y, h, r, (70, 150, 96), (104, 182, 120), trunk, shadow)))
    for x, y in ((9.4, 5.2), (9.5, 6.3), (6.3, 8.6), (7.2, 9.4), (5.4, 0.4)):
        objects.append((x + y, partial(iso_pine, draw, iso, x, y, 1.3, 0.34, (54, 128, 84), (76, 152, 102), trunk,
                                       shadow)))
    tips = {}

    def place_station(key, x, y, pole):
        tips[key] = iso_station(draw, iso, x, y, pole, 0.42, WHITE, BRAND, shadow)

    for key, x, y, pole in (("village", 2.5, 1.55, 0.85), ("field", 8.57, 2.37, 0.95), ("meadow", 3.0, 7.6, 0.85),
                            ("farm", 6.3, 7.4, 0.9)):
        objects.append((x + y, partial(place_station, key, x, y, pole)))
    for _, paint in sorted(objects, key=lambda item: item[0]):
        paint()

    # radio waves and the dotted links between the stations
    for tip in tips.values():
        waves(draw, tip, 90, BRAND)
    for a, b in (("village", "field"), ("village", "meadow"), ("meadow", "farm"), ("farm", "field")):
        for x, y in link_dots(tips[a], tips[b], math.dist(tips[a], tips[b]) * 0.25, 30):
            draw.ellipse(circle(x, y, 8), fill=BRAND_DARK)
    return image


def driver_image():
    size = 2000
    image = Image.new("RGB", (size, size), WHITE)
    draw = ImageDraw.Draw(image)
    # Antenna arcs reach 0.85 s above the box, the pole 0.45 s below it.
    s = 760
    total = s * 0.85 + s * 1.45
    station(draw, (size - s) / 2 - s * 0.1, (size - total) / 2 + s * 0.85, s, BRAND, WHITE, pole=0.45)
    return image


def save(image, path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize(size, Image.LANCZOS).save(path, optimize=True)
    print(f"wrote {path.relative_to(ROOT)} {size[0]}x{size[1]}")


def main():
    app = app_image()
    for name, size in (("small", (250, 175)), ("large", (500, 350)), ("xlarge", (1000, 700))):
        save(app, ROOT / "assets" / "images" / f"{name}.png", size)

    driver = driver_image()
    for name, size in (("small", (75, 75)), ("large", (500, 500)), ("xlarge", (1000, 1000))):
        save(driver, ROOT / "drivers" / "sensebox" / "assets" / "images" / f"{name}.png", size)


if __name__ == "__main__":
    main()
