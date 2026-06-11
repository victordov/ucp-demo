#!/usr/bin/env python3
"""Generate stylized product images (WebP) persisted in the repo and served by
the merchant portal at /img/{product_id}.webp. Pure-PIL flat illustrations —
no licensing concerns, works offline."""
import math
from PIL import Image, ImageDraw, ImageFilter

OUT = "apps/merchant-portal/public/img"
W, H = 640, 480

PRODUCTS = {
    # id: (bg gradient top, bg gradient bottom, accent, kind)
    "cadence-anc-pro":  ((49, 46, 129),  (109, 40, 217), (236, 233, 254), "overear"),
    "halo-studio-nc":   ((12, 74, 110),  (2, 132, 199),  (224, 242, 254), "overear"),
    "lumen-air-max":    ((124, 45, 18),  (234, 88, 12),  (255, 237, 213), "overear"),
    "aria-open-air":    ((6, 78, 59),    (13, 148, 136), (204, 251, 241), "openback"),
    "pulse-buds-pro":   ((76, 29, 149),  (167, 139, 250),(245, 243, 255), "earbuds"),
    "nova-go-speaker":  ((30, 41, 59),   (71, 85, 105),  (226, 232, 240), "speaker"),
    "travel-hardcase":  ((41, 37, 36),   (87, 83, 78),   (231, 229, 228), "case"),
    "alu-stand":        ((15, 23, 42),   (51, 65, 85),   (226, 232, 240), "stand"),
    "tempo-sport-buds": ((127, 29, 29),  (239, 68, 68),  (254, 226, 226), "sportbuds"),
    "vault-dac-amp":    ((20, 83, 45),   (22, 163, 74),  (220, 252, 231), "dac"),
    "boombar-300":      ((49, 46, 129),  (79, 70, 229),  (224, 231, 255), "soundbar"),
    "aria-cast-mic":    ((112, 26, 117), (192, 38, 211), (250, 232, 255), "mic"),
    "aria-plush-pads":  ((6, 78, 59),    (16, 185, 129), (209, 250, 229), "pads"),
    "buds-shell-case":  ((88, 28, 135),  (147, 51, 234), (243, 232, 255), "budscase"),
}

def gradient(d, top, bottom):
    for y in range(H):
        t = y / H
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (W, y)], fill=c)

def soft_shadow(im, bbox, blur=18, alpha=90):
    sh = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ds = ImageDraw.Draw(sh)
    ds.ellipse(bbox, fill=(0, 0, 0, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    im.alpha_composite(sh)

def draw_overear(d, im, acc, open_back=False):
    cx = W // 2
    soft_shadow(im, (cx - 170, 392, cx + 170, 430))
    # headband
    d.arc((cx - 150, 70, cx + 150, 370), start=180, end=360, fill=acc, width=26)
    d.arc((cx - 128, 96, cx + 128, 350), start=180, end=360, fill=tuple(int(c*0.75) for c in acc), width=8)
    # yokes
    for sx in (-150, 150):
        d.line((cx + sx, 218, cx + sx, 268), fill=acc, width=18)
    # ear cups
    for sx in (-150, 150):
        x = cx + sx
        d.rounded_rectangle((x - 58, 252, x + 58, 408), radius=52, fill=acc)
        inner = tuple(int(c * 0.72) for c in acc)
        d.rounded_rectangle((x - 40, 270, x + 40, 392), radius=40, fill=inner)
        if open_back:  # open-back grill
            for gy in range(286, 384, 14):
                d.line((x - 28, gy, x + 28, gy), fill=acc, width=4)
        else:
            d.ellipse((x - 22, 308, x + 22, 352), fill=tuple(int(c * 0.55) for c in acc))

def draw_earbuds(d, im, acc):
    soft_shadow(im, (W//2 - 180, 400, W//2 + 180, 436))
    for i, cx in enumerate((W // 2 - 95, W // 2 + 95)):
        # bud body
        d.ellipse((cx - 52, 150, cx + 52, 254), fill=acc)
        d.ellipse((cx - 30, 172, cx + 30, 232), fill=tuple(int(c * 0.72) for c in acc))
        # stem
        d.rounded_rectangle((cx - 18, 230, cx + 18, 380), radius=18, fill=acc)
        d.rounded_rectangle((cx - 8, 330, cx + 8, 368), radius=8, fill=tuple(int(c * 0.6) for c in acc))

def draw_speaker(d, im, acc):
    soft_shadow(im, (W//2 - 190, 398, W//2 + 190, 436))
    x0, y0, x1, y1 = W//2 - 170, 110, W//2 + 170, 400
    d.rounded_rectangle((x0, y0, x1, y1), radius=56, fill=acc)
    inner = tuple(int(c * 0.72) for c in acc)
    # grill dots
    for gy in range(y0 + 46, y1 - 60, 30):
        for gx in range(x0 + 44, x1 - 30, 30):
            d.ellipse((gx - 6, gy - 6, gx + 6, gy + 6), fill=inner)
    # bottom bar
    d.rounded_rectangle((x0 + 40, y1 - 48, x1 - 40, y1 - 22), radius=12, fill=inner)

def draw_case(d, im, acc):
    soft_shadow(im, (W//2 - 200, 396, W//2 + 200, 434))
    x0, y0, x1, y1 = W//2 - 185, 140, W//2 + 185, 392
    d.rounded_rectangle((x0, y0, x1, y1), radius=72, fill=acc)
    inner = tuple(int(c * 0.78) for c in acc)
    d.rounded_rectangle((x0 + 18, y0 + 18, x1 - 18, y1 - 18), radius=58, outline=inner, width=6)
    # zipper
    d.arc((x0 + 30, y0 + 30, x1 - 30, y1 + 110), start=200, end=340, fill=inner, width=8)
    d.ellipse((W//2 + 96, y0 + 38, W//2 + 120, y0 + 62), fill=inner)

def draw_stand(d, im, acc):
    soft_shadow(im, (W//2 - 150, 408, W//2 + 150, 440))
    cx = W // 2
    inner = tuple(int(c * 0.72) for c in acc)
    # curved top rest
    d.arc((cx - 90, 110, cx + 90, 230), start=180, end=360, fill=acc, width=30)
    # column
    d.rounded_rectangle((cx - 14, 170, cx + 14, 400), radius=14, fill=acc)
    # base
    d.rounded_rectangle((cx - 130, 388, cx + 130, 418), radius=15, fill=acc)
    d.rounded_rectangle((cx - 130, 404, cx + 130, 418), radius=14, fill=inner)

def draw_sportbuds(d, im, acc):
    soft_shadow(im, (W//2 - 180, 400, W//2 + 180, 436))
    for cx in (W // 2 - 95, W // 2 + 95):
        d.ellipse((cx - 48, 180, cx + 48, 276), fill=acc)
        d.ellipse((cx - 26, 200, cx + 26, 254), fill=tuple(int(c * 0.72) for c in acc))
        # ear hook
        d.arc((cx - 56, 120, cx + 56, 300), start=250, end=20, fill=acc, width=18)

def draw_dac(d, im, acc):
    soft_shadow(im, (W//2 - 180, 398, W//2 + 180, 434))
    x0, y0, x1, y1 = W//2 - 165, 160, W//2 + 165, 360
    d.rounded_rectangle((x0, y0, x1, y1), radius=34, fill=acc)
    inner = tuple(int(c * 0.72) for c in acc)
    # volume knob
    d.ellipse((x1 - 120, y0 + 40, x1 - 30, y1 - 70), fill=inner)
    d.ellipse((x1 - 100, y0 + 60, x1 - 50, y1 - 90), fill=acc)
    # display strip
    d.rounded_rectangle((x0 + 30, y0 + 44, x0 + 150, y0 + 96), radius=10, fill=inner)
    # jack dots
    for i in range(2):
        d.ellipse((x0 + 36 + i*44, y1 - 64, x0 + 64 + i*44, y1 - 36), fill=inner)

def draw_soundbar(d, im, acc):
    soft_shadow(im, (W//2 - 230, 360, W//2 + 230, 396))
    x0, y0, x1, y1 = W//2 - 230, 210, W//2 + 230, 330
    d.rounded_rectangle((x0, y0, x1, y1), radius=56, fill=acc)
    inner = tuple(int(c * 0.72) for c in acc)
    for gy in range(y0 + 28, y1 - 20, 22):
        for gx in range(x0 + 40, x1 - 28, 24):
            d.ellipse((gx - 5, gy - 5, gx + 5, gy + 5), fill=inner)

def draw_mic(d, im, acc):
    soft_shadow(im, (W//2 - 140, 408, W//2 + 140, 440))
    cx = W // 2
    inner = tuple(int(c * 0.72) for c in acc)
    # capsule
    d.rounded_rectangle((cx - 64, 110, cx + 64, 290), radius=64, fill=acc)
    for gy in range(140, 262, 18):
        d.line((cx - 44, gy, cx + 44, gy), fill=inner, width=5)
    # yoke + stand
    d.arc((cx - 86, 170, cx + 86, 330), start=20, end=160, fill=acc, width=14)
    d.rounded_rectangle((cx - 12, 320, cx + 12, 400), radius=12, fill=acc)
    d.rounded_rectangle((cx - 110, 392, cx + 110, 420), radius=14, fill=inner)

def draw_pads(d, im, acc):
    soft_shadow(im, (W//2 - 190, 392, W//2 + 190, 430))
    inner = tuple(int(c * 0.72) for c in acc)
    for cx in (W // 2 - 105, W // 2 + 105):
        d.ellipse((cx - 92, 152, cx + 92, 388), fill=acc)
        d.ellipse((cx - 56, 196, cx + 56, 344), fill=inner)

def draw_budscase(d, im, acc):
    soft_shadow(im, (W//2 - 160, 396, W//2 + 160, 432))
    x0, y0, x1, y1 = W//2 - 145, 150, W//2 + 145, 390
    d.rounded_rectangle((x0, y0, x1, y1), radius=70, fill=acc)
    inner = tuple(int(c * 0.72) for c in acc)
    # lid seam
    d.line((x0 + 10, 252, x1 - 10, 252), fill=inner, width=8)
    d.rounded_rectangle((W//2 - 26, 238, W//2 + 26, 266), radius=12, fill=inner)
    # LED
    d.ellipse((W//2 - 8, 300, W//2 + 8, 316), fill=inner)

import os
os.makedirs(OUT, exist_ok=True)
for pid, (top, bottom, acc, kind) in PRODUCTS.items():
    im = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(im)
    gradient(d, top, bottom)
    # subtle vignette circle behind the product
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dg = ImageDraw.Draw(glow)
    dg.ellipse((W//2 - 210, 40, W//2 + 210, 460), fill=(255, 255, 255, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    im.alpha_composite(glow)
    d = ImageDraw.Draw(im)
    if kind == "overear": draw_overear(d, im, acc)
    elif kind == "openback": draw_overear(d, im, acc, open_back=True)
    elif kind == "earbuds": draw_earbuds(d, im, acc)
    elif kind == "speaker": draw_speaker(d, im, acc)
    elif kind == "case": draw_case(d, im, acc)
    elif kind == "stand": draw_stand(d, im, acc)
    elif kind == "sportbuds": draw_sportbuds(d, im, acc)
    elif kind == "dac": draw_dac(d, im, acc)
    elif kind == "soundbar": draw_soundbar(d, im, acc)
    elif kind == "mic": draw_mic(d, im, acc)
    elif kind == "pads": draw_pads(d, im, acc)
    elif kind == "budscase": draw_budscase(d, im, acc)
    im.convert("RGB").save(f"{OUT}/{pid}.webp", "WEBP", quality=88)
    print("wrote", f"{OUT}/{pid}.webp")
