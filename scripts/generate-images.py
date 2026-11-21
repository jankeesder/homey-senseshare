#!/usr/bin/env python3
"""Generates the App Store and driver PNG images with Pillow.

Usage: python3 scripts/generate-images.py   (from the app root)

App images:    250x175, 500x350, 1000x700  (illustration on brand colour)
Driver images: 75x75, 500x500, 1000x1000   (device on a white background)
Everything is drawn at 2x the largest size and scaled down for smooth edges.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BRAND = (47, 125, 91)
BRAND_DARK = (31, 92, 66)
BRAND_LIGHT = (120, 190, 150)
WHITE = (255, 255, 255)
SUN = (250, 204, 21)


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        colour = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=colour)
    return image


def pin(draw, cx, cy, r, fill, hole):
    """A map pin whose round head is centred at (cx, cy)."""
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    draw.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, cy + r * 2.1)], fill=fill)
    h = r * 0.42
    draw.ellipse([cx - h, cy - h, cx + h, cy + h], fill=hole)


def station(draw, x, y, s, body, accent, pole=0.9):
    """A small sensor station: box on a pole with an antenna and vents."""
    draw.rectangle([x + s * 0.47, y + s * 0.9, x + s * 0.53, y + s * (1 + pole)], fill=body)
    draw.rounded_rectangle([x, y, x + s, y + s], radius=s * 0.12, fill=body)
    for i in range(3):
        top = y + s * (0.3 + i * 0.2)
        draw.rounded_rectangle([x + s * 0.2, top, x + s * 0.8, top + s * 0.07], radius=s * 0.03, fill=accent)
    draw.line([(x + s * 0.8, y), (x + s * 0.8, y - s * 0.45)], fill=body, width=max(2, round(s * 0.07)))
    for i, radius in enumerate((0.22, 0.4)):
        rr = s * radius
        cx, cy = x + s * 0.8, y - s * 0.45
        draw.arc([cx - rr, cy - rr, cx + rr, cy + rr], start=200, end=340, fill=body, width=max(2, round(s * 0.06)))


def app_image():
    width, height = 2000, 1400
    image = vertical_gradient((width, height), BRAND, BRAND_DARK)
    draw = ImageDraw.Draw(image)

    # Faint map grid in the sky, then sun and hills on top
    for x in range(0, width, 160):
        draw.line([(x, 0), (x, height)], fill=(58, 138, 103), width=3)
    for y in range(0, height, 160):
        draw.line([(0, y), (width, y)], fill=(58, 138, 103), width=3)
    draw.ellipse([1500, 160, 1760, 420], fill=SUN)
    draw.ellipse([-400, 980, 1300, 1900], fill=BRAND_LIGHT)
    draw.ellipse([700, 1050, 2500, 2000], fill=(98, 170, 128))

    # Station in the garden sending to the map
    station(draw, 330, 640, 300, WHITE, BRAND)
    for radius in (220, 340, 460):
        draw.arc([640 - radius, 560 - radius, 640 + radius, 560 + radius], start=300, end=350, fill=WHITE, width=26)

    # Pins on the map
    pin(draw, 1180, 470, 95, WHITE, BRAND)
    pin(draw, 1500, 720, 70, (230, 245, 236), BRAND)
    pin(draw, 1720, 520, 55, (210, 235, 220), BRAND)
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
