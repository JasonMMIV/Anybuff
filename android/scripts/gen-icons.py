#!/usr/bin/env python
"""Generate the Android launcher + notification icons from the desktop icon.

Reuses the desktop AnyBuff icon (desktop/resources/icon-256.png) as the single
source of truth (user decision 2026-09-03: APP icon 沿用桌面版).

Outputs (into app/src/main/res):
  drawable/ic_launcher_background.png   — radial blue gradient (desktop orb),
                                           fills the whole adaptive layer
  drawable/ic_launcher_foreground.png   — white logo on transparent, 108dp grid
  drawable/ic_launcher_monochrome.png  — logo-only silhouette for themed icons
  drawable/ic_notification.png         — white glyph on transparent (API 24+)
  mipmap-*/ic_launcher.png              — legacy raster launchers (26→xxxhdpi)
  values/colors.xml                    — ic_launcher_background fallback color

The desktop icon is a radial blue-gradient orb (bright upper-left ~#1CAAFD
falling to deep saturated blue ~#002DFD at the rim) with a white "AnyBuff"
wordmark logo. The gradient was LOST in the first Android cut (flat #0170FC
background) — this version regenerates it as a full-layer radial so any
launcher mask shows the same bright-center / deep-rim look as the desktop orb.

Logo scale: the desktop logo is ~157px wide in a 256px canvas (~61%), and the
launcher's visible mask circle is 72/108 of the layer. We size the logo to
~40% of the layer so it reads at ~60% of the visible circle diameter — close
to the desktop's own logo-to-badge ratio and clearly smaller than the first
cut's 52% (user feedback 2026-09-04: 白色圖形縮小一點、忠於桌面板).
"""

from __future__ import annotations

import os
import math
import re

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "app", "src", "main", "res")
SOURCE = os.path.join(HERE, "..", "..", "desktop", "resources", "icon-256.png")

# Gradient stops sampled from the desktop orb (icon-256.png):
#   center-ish (upper-left): ~(28, 170, 253)   bright cyan-blue
#   far rim (bottom-right):  ~(0, 45, 253)     deep saturated blue
# B stays ~250-253 across the orb; the falloff lives in R/G.
BRIGHT = (28, 170, 253)
DEEP = (0, 45, 253)

# Logo width as a fraction of the adaptive layer (see module docstring).
LOGO_FRAC = 0.40

# ── The desktop logo, isolated ─────────────────────────────────────────────
# The wordmark is pure white on the blue orb. Alpha comes from the source's
# own alpha channel (corners are fully transparent).

src = Image.open(SOURCE).convert("RGBA")
S = src.size[0]

# 1. Isolate the white logo: white pixels keep their alpha, everything else
#    becomes fully transparent.
logo = Image.new("RGBA", src.size, (0, 0, 0, 0))
spx, lpx = src.load(), logo.load()
for y in range(src.size[1]):
    for x in range(src.size[0]):
        r, g, b, a = spx[x, y]
        if r > 200 and g > 200 and b > 200:
            lpx[x, y] = (255, 255, 255, a)
logo = logo.crop(logo.getbbox() or (0, 0, S, S))
lw, lh = logo.size
print(f"source logo bbox: {logo.getbbox()} size {lw}x{lh} ({lw / S:.3f} x {lh / S:.3f} of canvas)")


# ── Radial gradient background (desktop orb, recreated) ─────────────────────
def make_background(size: int) -> Image.Image:
    """Full-layer radial gradient: bright center offset toward upper-left,
    deep saturated blue at the far rim — matching the desktop orb."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    # Bright spot sits slightly above-left of center, like the desktop light.
    cx, cy = size * 0.46, size * 0.44
    # Farthest corner from the bright spot sets the deep stop.
    dmax = max(math.hypot(x - cx, y - cy)
               for x, y in ((0, 0), (size, 0), (0, size), (size, size)))
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - cx, y - cy) / dmax)
            # slight ease keeps the center bright longer, then falls to rim
            t = t ** 1.15
            r = int(BRIGHT[0] + (DEEP[0] - BRIGHT[0]) * t)
            g = int(BRIGHT[1] + (DEEP[1] - BRIGHT[1]) * t)
            b = int(BRIGHT[2] + (DEEP[2] - BRIGHT[2]) * t)
            px[x, y] = (r, g, b, 255)
    # Smooth the per-pixel steps into a band-free gradient.
    return img.filter(ImageFilter.GaussianBlur(1.2))


# ── Logo placement on a layer ──────────────────────────────────────────────
def place_logo(canvas: Image.Image, art: Image.Image, frac: float) -> None:
    """Scale + center [art] (white logo) so its width is [frac] of [canvas]."""
    cw, ch = canvas.size
    scale = (cw * frac) / art.size[0]
    w, h = max(1, int(art.size[0] * scale)), max(1, int(art.size[1] * scale))
    mark = art.resize((w, h), Image.LANCZOS)
    # Soothe threshold-induced jaggies (source is 256px; layers go to 432px).
    mark = mark.filter(ImageFilter.GaussianBlur(0.6))
    mark.putalpha(mark.getchannel("A").point(lambda v: 0 if v < 12 else v))
    canvas.alpha_composite(mark, ((cw - w) // 2, (ch - h) // 2))


# ── Silhouette (monochrome + notification glyph) ───────────────────────────
def silhouette() -> Image.Image:
    sil = Image.new("RGBA", logo.size, (255, 255, 255, 0))
    sil.putalpha(logo.getchannel("A"))
    return sil


FG_SIZE = 432  # 108dp @ xxxhdpi (4x)

# Foreground: white logo only (the background layer carries the gradient).
fg = Image.new("RGBA", (FG_SIZE, FG_SIZE), (0, 0, 0, 0))
place_logo(fg, logo, LOGO_FRAC)
os.makedirs(os.path.join(RES, "drawable"), exist_ok=True)
fg.save(os.path.join(RES, "drawable", "ic_launcher_foreground.png"))
print(f"foreground → drawable/ic_launcher_foreground.png ({FG_SIZE}px, logo {LOGO_FRAC:.0%})")

# Monochrome: same logo as a single-color silhouette (themed icons, 13+).
mono = Image.new("RGBA", (FG_SIZE, FG_SIZE), (0, 0, 0, 0))
place_logo(mono, silhouette(), LOGO_FRAC)
mono.save(os.path.join(RES, "drawable", "ic_launcher_monochrome.png"))
print(f"monochrome → drawable/ic_launcher_monochrome.png ({FG_SIZE}px)")

# Adaptive background: the radial gradient layer.
bg = make_background(FG_SIZE)
bg.save(os.path.join(RES, "drawable", "ic_launcher_background.png"))
print(f"background (radial gradient) → drawable/ic_launcher_background.png ({FG_SIZE}px)")

# colors.xml fallback: keep ic_launcher_background defined for pre-26 / any
# non-adaptive use, at the deep rim color (matches the gradient's far edge).
deep_hex = "#{:02X}{:02X}{:02X}".format(*DEEP)
colors_xml = os.path.join(RES, "values", "colors.xml")
with open(colors_xml, encoding="utf-8") as f:
    colors = f.read()
new_colors = re.sub(
    r'<color name="ic_launcher_background">[^<]*</color>',
    f'<color name="ic_launcher_background">{deep_hex}</color>',
    colors,
)
if "ic_launcher_background" not in new_colors:
    new_colors = new_colors.replace(
        "</resources>",
        f'    <color name="ic_launcher_background">{deep_hex}</color>\n</resources>',
    )
if new_colors != colors:
    with open(colors_xml, "w", encoding="utf-8") as f:
        f.write(new_colors)
    print(f"ic_launcher_background color → {deep_hex}")
else:
    print(f"ic_launcher_background color already {deep_hex}")

# ── Notification small icon: white glyph on transparent (API 24+) ──────────
notif_sizes = {"mdpi": 24, "hdpi": 36, "xhdpi": 48, "xxhdpi": 72, "xxxhdpi": 96}
sil = silhouette()
for density, size in notif_sizes.items():
    os.makedirs(os.path.join(RES, f"drawable-{density}"), exist_ok=True)
    sil.resize((size, size), Image.LANCZOS).save(
        os.path.join(RES, f"drawable-{density}", "ic_notification.png")
    )
print("notification glyph → drawable-*/ic_notification.png")

# ── Legacy launcher PNGs (pre-26 devices): gradient bg + white logo ────────
legacy_sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for density, size in legacy_sizes.items():
    os.makedirs(os.path.join(RES, f"mipmap-{density}"), exist_ok=True)
    out = make_background(size)
    place_logo(out, logo, LOGO_FRAC)
    out.save(os.path.join(RES, f"mipmap-{density}", "ic_launcher.png"))
print("legacy launcher rasters (gradient bg) → mipmap-*/ic_launcher.png")

print("done.")
