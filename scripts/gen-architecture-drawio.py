#!/usr/bin/env python3
"""Generate assets/architecture.drawio — a UML SEQUENCE diagram of one full
purchase across the UCP + AP2 reference suite. Vertical lifelines per service;
time-ordered messages each labeled by the protocol they use (MCP/JSON-RPC,
REST, OAuth, webhook). Import into app.diagrams.net (File ▸ Open)."""
import html, os

cells = []
_id = [1]
def nid():
    _id[0] += 1
    return f"n{_id[0]}"
def esc(s):
    return html.escape(s, quote=True)

def raw(xml):
    cells.append(xml)

def box(x, y, w, h, label, style, cid=None):
    cid = cid or nid()
    raw(f'<mxCell id="{cid}" value="{esc(label)}" style="{style}" vertex="1" parent="1">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return cid

def line(x1, y1, x2, y2, style):
    raw(f'<mxCell id="{nid()}" style="{style}" edge="1" parent="1">'
        f'<mxGeometry relative="1" as="geometry">'
        f'<mxPoint x="{x1}" y="{y1}" as="sourcePoint"/>'
        f'<mxPoint x="{x2}" y="{y2}" as="targetPoint"/>'
        f'</mxGeometry></mxCell>')

def msg(y, x1, x2, label, color, dashed=False, ret=False, width=2):
    arrow = "open" if ret else "block"
    s = (f"html=1;endArrow={arrow};startArrow=none;rounded=0;strokeColor={color};strokeWidth={width};"
         f"fontSize=10;fontColor=#111827;fontStyle=0;labelBackgroundColor=#ffffff;align=center;verticalAlign=bottom;")
    if dashed: s += "dashed=1;dashPattern=6 4;"
    raw(f'<mxCell id="{nid()}" value="{esc(label)}" style="{s}" edge="1" parent="1">'
        f'<mxGeometry relative="1" as="geometry">'
        f'<mxPoint x="{x1}" y="{y}" as="sourcePoint"/>'
        f'<mxPoint x="{x2}" y="{y}" as="targetPoint"/>'
        f'</mxGeometry></mxCell>')

INDIGO, TEAL, VIOLET, AMBER, GRAY, SLATE = "#4f46e5", "#0d9488", "#7c3aed", "#b45309", "#94a3b8", "#64748b"

# ---------- lifelines (lanes) ----------
TOP, BOT = 200, 2030
lanes = [
    ("User\n(browser)",                   140, "#dbeafe", "#1d4ed8"),
    ("Shopping Agent\n:4100 · Platform",  470, "#eef2ff", INDIGO),
    ("Merchant\n:4101 · Business",        820, "#f0fdfa", TEAL),
    ("Credentials Provider\n:4102 · Walletly", 1170, "#f5f3ff", VIOLET),
    ("Payment Provider\n:4103 · PayStream",    1520, "#fffbeb", AMBER),
    ("LLM provider\n(optional, ext.)",    1820, "#f8fafc", SLATE),
]
X = {name.split("\n")[0]: cx for name, cx, *_ in lanes}
def lx(k): return X[k]

# title
box(60, 24, 1300, 70,
    '<b style="font-size:19px">UCP 2026-04-08 + AP2 — One Purchase, End to End (Sequence)</b><br/>'
    '<font style="font-size:12px;color:#64748b">Vertical lifelines = the running services. Each message is labeled by the '
    'protocol it uses. ① ② ③ mark the three spend-policy enforcement gates.</font>',
    "text;html=1;align=left;verticalAlign=top;")

# legend (top-right)
box(1500, 18, 420, 150, "", "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#e6e7ee;")
box(1514, 24, 300, 18, "<b>Message protocol legend</b>", "text;html=1;fontSize=11;align=left;")
def legrow(y, color, txt, dashed=False):
    st = f"html=1;endArrow=block;strokeColor={color};strokeWidth=3;" + ("dashed=1;dashPattern=6 4;" if dashed else "")
    raw(f'<mxCell id="{nid()}" style="{st}" edge="1" parent="1"><mxGeometry relative="1" as="geometry">'
        f'<mxPoint x="1516" y="{y}" as="sourcePoint"/><mxPoint x="1560" y="{y}" as="targetPoint"/></mxGeometry></mxCell>')
    box(1570, y-10, 350, 20, txt, "text;html=1;fontSize=10;align=left;fontColor=#374151;")
legrow(58, INDIGO, "MCP · JSON-RPC 2.0 (tools/call, RFC 9421-signed)")
legrow(80, VIOLET, "AP2 wallet / credentials (over MCP)")
legrow(102, AMBER, "AP2 payment processing (over MCP)")
legrow(124, TEAL,  "OAuth 2.0 / order webhook (REST, signed)", dashed=True)
legrow(146, GRAY,  "plain REST / HTTPS (UI · discovery · 3-DS · LLM)", dashed=True)

# phase frames (drawn first so they sit behind the messages)
def frame(y, h, x1, x2, label, color):
    box(x1, y, x2 - x1, h, "",
        f"rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor={color};dashed=1;dashPattern=4 4;opacity=70;")
    box(x1 + 6, y + 4, 360, 20, f'<b>{label}</b>',
        f"text;html=1;fontSize=10;fontColor={color};align=left;fontStyle=1;")
frame(230, 170, 90, 1900, "① DISCOVERY  &  INTENT", SLATE)
frame(410, 200, 90, 1260, "② CATALOG  &  CART", INDIGO)
frame(620, 260, 90, 1620, "③ USER APPROVAL  &  TOKENIZATION  (policy gates ①②)", VIOLET)
frame(890, 360, 90, 1620, "④ COMPLETION  &  PAYMENT  (KYA · gate ③ · multi-rail)", AMBER)
frame(1270, 150, 90, 1260, "⑤ POST-PURCHASE", TEAL)

# lifeline headers + dashed lines
for name, cx, fill, stroke in lanes:
    box(cx - 110, TOP - 60, 220, 50,
        "<b>" + name.split("\n")[0] + "</b><br/><font style='font-size:9px'>" + name.split("\n")[1] + "</font>",
        f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};fontColor=#111827;verticalAlign=middle;")
    line(cx, TOP - 10, cx, BOT, f"html=1;endArrow=none;strokeColor={stroke};strokeWidth=1.5;dashed=1;dashPattern=3 4;")
    box(cx - 110, BOT, 220, 30, "", f"rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};")

# activation bar on the Agent (it orchestrates most of the flow)
box(lx("Shopping Agent") - 6, 250, 12, 1080, "",
    "rounded=0;fillColor=#c7d2fe;strokeColor=#4f46e5;opacity=80;html=1;")

# ---------- messages ----------
y = 268
S = 50  # step
def step():
    global y; y += S; return y

msg(y, lx("User"), lx("Shopping Agent"), "“ANC headphones < $300, 2-day”  · REST + SSE (UI)", GRAY, dashed=True)
msg(step(), lx("Shopping Agent"), lx("LLM provider"), "parse intent / drive chat  · HTTPS (optional)", GRAY, dashed=True)
msg(step(), lx("Shopping Agent"), lx("Merchant"), "GET /.well-known/ucp  · REST (discovery + JWKs)", GRAY, dashed=True)
# phase 2
y = 430
msg(y, lx("Shopping Agent"), lx("Credentials Provider"), "sign_mandate(IntentMandate)  · MCP", VIOLET)
msg(step(), lx("Shopping Agent"), lx("Merchant"), "search_catalog / lookup  · MCP (JSON-RPC tools/call)", INDIGO)
msg(step(), lx("Shopping Agent"), lx("Merchant"), "create_checkout → checkout + merchant_authorization (detached JWS)  · MCP", INDIGO)
msg(step(), lx("Shopping Agent"), lx("Credentials Provider"), "sign_mandate(CartMandate)  · MCP", VIOLET)
# phase 3
y = 644
msg(y, lx("User"), lx("Credentials Provider"), "Touch ID — WebAuthn/SPC over SHA-256(JCS(checkout))  · REST", TEAL, dashed=True)
msg(step(), lx("Shopping Agent"), lx("Credentials Provider"), "① mint_instrument  (policy gate 1: cap/budget/allowlist/autonomy)  · MCP", VIOLET)
msg(step(), lx("Credentials Provider"), lx("Shopping Agent"), "single-use token + policy snapshot bound in", VIOLET, ret=True)
msg(step(), lx("Shopping Agent"), lx("Credentials Provider"), "② sign_mandate(PaymentMandate)  (policy gate 2)  · MCP", VIOLET)
msg(step(), lx("Shopping Agent"), lx("Credentials Provider"), "sign_mandate(CheckoutMandate → SD-JWT+kb, aud=merchant)  · MCP", VIOLET)
# phase 4
y = 910
msg(y, lx("Shopping Agent"), lx("Merchant"), "complete_checkout (composite token + checkout & intent mandates)  · MCP", INDIGO, width=3)
msg(step(), lx("Merchant"), lx("Payment Provider"), "lookup_agent  (Know-Your-Agent gate)  · MCP", AMBER)
msg(step(), lx("Merchant"), lx("Merchant"), "verify SD-JWT+kb · merchant_authorization · terms · intent ceiling", TEAL)
msg(step(), lx("Merchant"), lx("Payment Provider"), "authorize_payment (composite token + intent)  · MCP", AMBER, width=3)
msg(step(), lx("Payment Provider"), lx("Credentials Provider"), "③ release_credentials  (policy gate 3 — re-check from token)  · MCP", VIOLET)
msg(step(), lx("Credentials Provider"), lx("Payment Provider"), "credentials + behavior + rail", VIOLET, ret=True)
msg(step(), lx("Payment Provider"), lx("Merchant"), "authorized (rail recorded)", AMBER, ret=True)
msg(step()-8, lx("Merchant"), lx("Payment Provider"), "capture_payment  · MCP", AMBER)
msg(step(), lx("Merchant"), lx("Shopping Agent"), "completed checkout + order {id, permalink}  · MCP response, @status-signed", INDIGO, ret=True)
# phase 5
y = 1290
msg(y, lx("Merchant"), lx("Shopping Agent"), "order.shipped / delivered / refunded  · REST webhook (RFC 9421-signed)", TEAL, dashed=True)
msg(step(), lx("Shopping Agent"), lx("Merchant"), "get_order (delivery monitor) · list_orders (after OAuth identity link)  · MCP", INDIGO)

# side note: OAuth identity linking + 3-DS as alternate REST flows
box(60, 1410, 470, 90,
    "<b>Other protocol surfaces (not on this happy path):</b><br/>"
    "• <b>OAuth 2.0</b> Identity Linking — Agent ↔ Merchant /oauth/* (RFC 8414 + PKCE), scope order:read · REST<br/>"
    "• <b>3-DS escalation</b> — PSP returns continue_url; User completes the step-up in the browser · REST<br/>"
    "• Approval inbox — autonomy-blocked buys wait for the User's decision in Walletly · REST",
    "rounded=1;whiteSpace=wrap;html=1;fillColor=#f8fafc;strokeColor=#cbd5e1;align=left;verticalAlign=top;spacing=8;fontSize=10;fontColor=#334155;")

# emit
body = "\n".join(cells)
xml = (
    '<mxfile host="app.diagrams.net" version="24.0.0">\n'
    '  <diagram id="ucp-ap2-sequence" name="UCP+AP2 Purchase Sequence">\n'
    '    <mxGraphModel dx="1900" dy="1500" grid="0" gridSize="10" guides="1" tooltips="1" '
    'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1980" pageHeight="2120" math="0" shadow="0">\n'
    '      <root>\n'
    '        <mxCell id="0"/>\n'
    '        <mxCell id="1" parent="0"/>\n'
    f'{body}\n'
    '      </root>\n'
    '    </mxGraphModel>\n'
    '  </diagram>\n'
    '</mxfile>\n'
)
os.makedirs("assets", exist_ok=True)
with open("assets/architecture.drawio", "w") as f:
    f.write(xml)
print("wrote assets/architecture.drawio (sequence) ·", len(cells), "cells")
