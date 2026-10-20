#!/usr/bin/env python3
"""Render the Mac-only icons for the Record Keeper desktop app.

  build/icon-mac.png       1024px app icon: the iOS icon (the record on the
                           charcoal ground) on Apple's rounded-square grid, so
                           macOS does not box a round icon in a gray tile.
  assets/trayTemplate.png  The menu bar icon, 18pt and @2x. Black and alpha
  assets/trayTemplate@2x.png only: the "Template" suffix tells macOS to tint it
                           for a light or dark menu bar, as every menu bar
                           icon is. Windows keeps the colored tray.png.

Run from native/recordkeeper/desktop:  python3 scripts/render-mac-icons.py
Needs Pillow. The outputs are committed; rerun only when the logo changes.
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent.parent
IOS_ICON = HERE.parent / 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'
LOGO = HERE / 'build/icon.png'  # the transparent record, 512px


def rounded_mask(size, radius, scale=4):
    big = Image.new('L', (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius * scale, fill=255)
    return big.resize((size, size), Image.LANCZOS)


def app_icon():
    # Apple's macOS grid: a 824px rounded square centred on a 1024px canvas,
    # corner radius about 185px, with a soft shadow below it.
    canvas, body, radius = 1024, 824, 185
    art = Image.open(IOS_ICON).convert('RGBA').resize((body, body), Image.LANCZOS)
    art.putalpha(rounded_mask(body, radius))
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    shadow_mask = Image.new('L', (canvas, canvas), 0)
    off = (canvas - body) // 2
    shadow_mask.paste(rounded_mask(body, radius), (off, off + 12))
    shadow.putalpha(shadow_mask.point(lambda a: int(a * 0.35)).filter(ImageFilter.GaussianBlur(14)))
    out.alpha_composite(shadow)
    out.alpha_composite(art, (off, off))
    out.save(HERE / 'build/icon-mac.png')


def tray_template(px):
    # The disc and the orange label are ink; the white grooves, the white ring
    # round the label and the ribbon are cut out, so the shape still reads as
    # the logo at menu bar size.
    logo = Image.open(LOGO).convert('RGBA')
    r, g, b, a = logo.split()
    lum = Image.merge('RGB', (r, g, b)).convert('L')
    white = lum.point(lambda v: 255 if v > 200 else 0)
    ink = ImageChops.subtract(a, white)
    # A little margin, as system menu bar icons have.
    pad = int(px * 0.06)
    inner = px - 2 * pad
    mask = ink.resize((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    glyph = Image.new('RGBA', (inner, inner), (0, 0, 0, 255))
    glyph.putalpha(mask)
    out.alpha_composite(glyph, (pad, pad))
    return out


if __name__ == '__main__':
    app_icon()
    tray_template(18).save(HERE / 'assets/trayTemplate.png')
    tray_template(36).save(HERE / 'assets/trayTemplate@2x.png')
    print('Wrote build/icon-mac.png, assets/trayTemplate.png, assets/trayTemplate@2x.png')
