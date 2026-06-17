#!/usr/bin/env python3
"""Generate the two PROPOSITION.html illustrations (WebP) in the page's brand style.

  assets/proposition-product.webp      — product-level view: gateway between AI buyers
                                         and merchants + the six benefit families + model
  assets/proposition-architecture.webp — architecture: 5 layers (high level) with the
                                         components inside each (medium level) + cross-cutting
"""
from PIL import Image, ImageDraw, ImageFont

# ---------- brand ----------
BG      = (247, 247, 251)
CARD    = (255, 255, 255)
LINE    = (226, 228, 238)
INK     = (21, 23, 28)
MUTED   = (102, 112, 133)
INDIGO  = (79, 70, 229)
INDIGO_S= (238, 242, 255)
TEAL    = (13, 148, 136)
TEAL_S  = (204, 251, 241)
AMBER   = (180, 83, 9)
AMBER_S = (254, 243, 199)

F = "/usr/share/fonts/truetype/dejavu/"
def font(sz, bold=False, cond=False):
    name = ("DejaVuSansCondensed" if cond else "DejaVuSans") + ("-Bold" if bold else "") + ".ttf"
    return ImageFont.truetype(F + name, sz)

def rr(d, xy, r, fill=None, outline=None, width=2):
    d.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

def text(d, xy, s, f, fill=INK, anchor="la"):
    d.text(xy, s, font=f, fill=fill, anchor=anchor)

def ctext(d, cx, y, s, f, fill=INK):
    d.text((cx, y), s, font=f, fill=fill, anchor="ma")

def chip(d, x, y, s, f, fg, bg, pad=10, r=12):
    w = d.textlength(s, font=f)
    h = f.size + pad
    rr(d, (x, y, x + w + 2*pad, y + h), r, fill=bg)
    d.text((x + pad, y + pad/2 + 1), s, font=f, fill=fg)
    return x + w + 2*pad

def arrow(d, x1, y1, x2, y2, color=MUTED, w=3, head=9):
    d.line((x1, y1, x2, y2), fill=color, width=w)
    import math
    a = math.atan2(y2-y1, x2-x1)
    for da in (2.6, -2.6):
        d.line((x2, y2, x2 - head*math.cos(a+da)*1.6, y2 - head*math.sin(a+da)*1.6), fill=color, width=w)

# ============================================================
# 1) PRODUCT IMAGE — 1680 x 980
# ============================================================
W, H = 1680, 980
im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(im)

# header
text(d, (60, 44), "AGENTIC COMMERCE GATEWAY", font(22, True), INDIGO)
text(d, (60, 80), "One integration. Every AI buyer.", font(46, True))
text(d, (60, 140), "We make any merchant discoverable, trusted, payable and serviceable by AI agents —", font(23), MUTED)
text(d, (60, 172), "and operate everything hard underneath, so merchants never touch a signature, mandate or spec revision.", font(23), MUTED)

# middle band: buyers -> gateway -> merchant
band_y, band_h = 232, 170
def node(x, w, title, sub, hub=False):
    fill = INDIGO_S if hub else CARD
    outline = INDIGO if hub else LINE
    rr(d, (x, band_y, x+w, band_y+band_h), 18, fill=fill, outline=outline, width=4 if hub else 2)
    ctext(d, x+w/2, band_y+34, title, font(30 if hub else 26, True), INDIGO if hub else INK)
    for i, line in enumerate(sub):
        ctext(d, x+w/2, band_y+82+i*30, line, font(20), MUTED)

node(60, 380, "AI buyers", ["Gemini · Claude · ChatGPT-class", "shopping & enterprise agents"])
node(560, 560, "OUR GATEWAY", ["protocols · trust · spend policy", "rails · identity · evidence"], hub=True)
node(1240, 380, "Merchant backend", ["Shopify · Woo · Magento · custom", "any platform · any region"])
arrow(d, 446, band_y+band_h/2, 554, band_y+band_h/2, INDIGO, 5)
arrow(d, 554, band_y+band_h/2-28, 446, band_y+band_h/2-28, INDIGO, 5)
arrow(d, 1126, band_y+band_h/2, 1234, band_y+band_h/2, TEAL, 5)
arrow(d, 1234, band_y+band_h/2-28, 1126, band_y+band_h/2-28, TEAL, 5)
ctext(d, 500, band_y+band_h+10, "UCP + AP2 (signed, verified)", font(17), INDIGO)
ctext(d, 1180, band_y+band_h+10, "5 plain callbacks — zero crypto", font(17), TEAL)

# six benefit cards (2 rows x 3)
bens = [
    ("Reach",        "Compliant UCP endpoint, capability negotiation,", "catalog on agent surfaces — multi-protocol."),
    ("Trust",        "Know-Your-Agent registry, reputation scoring,", "velocity rules — traffic screened up front."),
    ("Money",        "Multi-rail settlement (card / instant bank),", "user spend-controls, SCA & 3-DS orchestration."),
    ("Relationship", "Identity Linking (OAuth): order history, returns,", "loyalty — plus post-purchase agency."),
    ("Insight",      "Agent-traffic analytics, hash-chained audit,", "one-click dispute evidence bundles."),
    ("Compliance",   "PCI scope reduction, GDPR selective disclosure,", "EU AI Act traceability, continuous conformance."),
]

gx, gy = 60, 472
cw, ch, gap = 506, 168, 21
for i, (t, l1, l2) in enumerate(bens):
    x = gx + (i % 3) * (cw + gap)
    y = gy + (i // 3) * (ch + gap)
    rr(d, (x, y, x+cw, y+ch), 16, fill=CARD, outline=LINE, width=2)
    accent = INDIGO if i % 2 == 0 else TEAL
    d.rectangle((x, y, x+8, y+ch), fill=accent)
    rr(d, (x+30, y+26, x+52, y+48), 7, fill=accent)
    text(d, (x+66, y+22), t, font(26, True))
    text(d, (x+30, y+70), l1, font(19), MUTED)
    text(d, (x+30, y+99), l2, font(19), MUTED)

# bottom ribbon: tiers + model
ry = gy + 2*ch + gap + 22
rr(d, (60, ry, W-60, ry+118), 16, fill=(21, 23, 28))
text(d, (92, ry+24), "OFFERING", font(16, True), (129, 140, 248))
text(d, (92, ry+52), "Hosted Gateway (SaaS + bps)   →   Gateway SDK (your VPC)   →   Merchant Agent (A2A, roadmap)", font(23, True), (255, 255, 255))
text(d, (92, ry+88), "Recurring: conformance-as-a-service · KYA registry seats · evidence retention · agent analytics", font(19), (160, 168, 188))
text(d, (W-92, ry+88), "backed by a working UCP+AP2 implementation · 111 checks green", font(17, True), (129, 140, 248), anchor="ra")

im.save("assets/proposition-product.webp", "WEBP", quality=92)
im.save("/tmp/prop-product.png")

# ============================================================
# 2) ARCHITECTURE IMAGE — 1680 x 1150
# ============================================================
W, H = 1680, 1150
im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(im)

text(d, (60, 40), "GATEWAY ARCHITECTURE", font(22, True), TEAL)
text(d, (60, 76), "Transport-agnostic core, five layers, cross-cutting controls", font(40, True))
text(d, (60, 132), "High level: the layers. Medium level: the components inside each — LIVE components run in the reference implementation today.", font(21), MUTED)

LX, LW = 60, 1240          # layer column
XX = LX + LW + 30          # cross-cutting column x
XW = W - XX - 60

layers = [
    ("1 · AGENT SURFACES", INDIGO,
     [("MCP / JSON-RPC tools-call", "live"), ("REST · OpenAPI", "road"), ("A2A Agent Card", "road"), ("Embedded", "road"),
      ("identity: meta ↔ signed UCP-Agent header", "live")]),
    ("2 · TRUST & IDENTITY", TEAL,
     [("RFC 9421 req+resp signatures", "live"), ("JWK discovery (.well-known/ucp)", "live"), ("KYA registry + reputation", "live"),
      ("velocity rules (per agent)", "live"), ("OAuth Identity Linking (RFC 8414)", "live"), ("network KYA interop", "road")]),
    ("3 · POLICY & PAYMENTS", TEAL,
     [("AP2 mandates: Checkout + Payment SD-JWT+kb", "live"), ("selective disclosure + key binding", "live"),
      ("spend policy — enforced at mint · sign · PSP", "live"), ("passkey UV (WebAuthn / SPC)", "live"),
      ("multi-rail: card token / RTP", "live"), ("3-DS escalation (continue_url)", "live"), ("split payments", "road")]),
    ("4 · COMMERCE ADAPTER", AMBER,
     [("searchCatalog", "live"), ("priceBasket (+ JWS re-sign)", "live"), ("reserveAndConfirm", "live"),
      ("fulfillmentStatus + signed webhooks", "live"), ("refund / dispute evidence", "live"), ("platform connectors", "road")]),
    ("5 · MERCHANT BACKEND", MUTED,
     [("existing catalog · OMS · fulfillment — untouched, zero cryptography", None)]),
]

fy = 190
layer_boxes = []
chip_f = font(19, cond=True)
tag_f = font(13, True)
for title, color, comps in layers:
    # measure: chips flow within LW-260, wrap
    x0, y0 = LX, fy
    inner_x = x0 + 250
    cx, cy = inner_x, y0 + 18
    maxx = x0 + LW - 24
    rows = 1
    pos = []
    for label, tag in comps:
        wlab = d.textlength(label, font=chip_f) + 20
        wtag = (d.textlength("LIVE" if tag == "live" else "ROADMAP", font=tag_f) + 14) if tag else 0
        w = wlab + wtag + (6 if tag else 0)
        if cx + w > maxx:
            cx = inner_x; cy += 52; rows += 1
        pos.append((cx, cy, label, tag, wlab, wtag))
        cx += w + 12
    lh = max(86, 18 + rows*52 + 6)
    rr(d, (x0, y0, x0+LW, y0+lh), 16, fill=CARD, outline=color, width=3)
    num, name = [t.strip() for t in title.split("·", 1)]
    text(d, (x0+24, y0+lh/2-30), num, font(34, True), color)
    nf = font(17, True, cond=True)
    words = name.split(); line=""; lines=[]
    for wd in words:
        if d.textlength((line+" "+wd).strip(), font=nf) > 200: lines.append(line); line=wd
        else: line=(line+" "+wd).strip()
    lines.append(line)
    for j, ln in enumerate(lines[:2]):
        text(d, (x0+24, y0+lh/2+12+j*22), ln, nf, INK)
    for (cx, cy, label, tag, wlab, wtag) in pos:
        rr(d, (cx, cy, cx+wlab, cy+36), 10, fill=BG, outline=LINE, width=2)
        d.text((cx+10, cy+8), label, font=chip_f, fill=INK)
        if tag:
            tg, tbg = (TEAL, TEAL_S) if tag == "live" else (AMBER, AMBER_S)
            ts = "LIVE" if tag == "live" else "ROADMAP"
            rr(d, (cx+wlab+6, cy+6, cx+wlab+6+wtag, cy+30), 8, fill=tbg)
            d.text((cx+wlab+13, cy+11), ts, font=tag_f, fill=tg)
    layer_boxes.append((y0, lh))
    fy = y0 + lh + 26

# arrows between layers
for i in range(len(layer_boxes)-1):
    y0, lh = layer_boxes[i]
    arrow(d, LX+125, y0+lh, LX+125, y0+lh+26, MUTED, 4)

# top label: AI agents in
arrow(d, LX+125, 158, LX+125, 188, INDIGO, 5)
text(d, (LX+145, 152), "AI agents (signed requests in · signed, verified responses out)", font(18, True), INDIGO)

# cross-cutting column
xc_items = [
    ("Observability", "protocol traces per hop · OTel export (roadmap) · agent analytics", INDIGO),
    ("Immutable audit", "hash-chained events · verify endpoint · evidence bundles", TEAL),
    ("Key management", "per-tenant ES256 JWKs · HSM + rotation (roadmap)", AMBER),
    ("Tenant isolation", "key namespaces · scoped profiles · RBAC portal", INDIGO),
    ("Conformance CI", "63 e2e + 20 schema + 28 spec checks on every change", TEAL),
]
top_y, bot_y = layer_boxes[0][0], layer_boxes[-1][0] + layer_boxes[-1][1]
xh = (bot_y - top_y - 4*16) / 5
y = top_y
text(d, (XX, top_y-32), "CROSS-CUTTING", font(17, True), MUTED)
for t, s, c in xc_items:
    rr(d, (XX, y, XX+XW, y+xh), 14, fill=CARD, outline=LINE, width=2)
    d.rectangle((XX, y, XX+7, y+xh), fill=c)
    text(d, (XX+24, y+16), t, font(22, True))
    # wrap sub
    words, line, lines = s.split(), "", []
    for wd in words:
        if d.textlength(line + " " + wd, font=font(17)) > XW-44: lines.append(line); line = wd
        else: line = (line + " " + wd).strip()
    lines.append(line)
    for i, ln in enumerate(lines[:3]):
        text(d, (XX+24, y+52+i*24), ln, font(17), MUTED)
    y += xh + 16

# footer strip
ctext(d, W/2, H-44, "Reference implementation: 4 services · 22 scenarios · multi-tenant merchant gateway · PKI everywhere (no DIDs)", font(18), MUTED)

im.save("assets/proposition-architecture.webp", "WEBP", quality=92)
im.save("/tmp/prop-arch.png")
print("done")
