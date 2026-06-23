/* ============ Shoppy — main app, driven by the REAL UCP+AP2 backend ============ */
const { useState, useEffect, useRef } = React;
const { Avatar, Bubble, Typing, ProductResults } = ChatUI;
const { CheckoutCard, WalletSheetFrame, Receipt, GPayMark } = Checkout;
const S = window.SHOPPY;
const API = window.ShoppyAPI;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _uid = 0;
const nextUid = () => "u" + _uid++;

// Detect a human-not-present request typed straight into the chat (mirrors the
// server's nlu.detectAutonomy), so HNP can be configured from chat — not just the
// toggle or the Scenarios panel.
const AUTO_RE = /\b(autonomous(?:ly)?|human[ -]?not[ -]?present|on my behalf|without me|while i'?m away|you decide|don'?t ask|just buy it|buy it for me|purchase it for me|go ahead and buy|buy the best)\b/i;
const DROP_RE = /(?:if|when|once)[^.]*?(?:drops?|falls?|below|under)\s*\$?\s*\d/i;
const looksAutonomous = (text) => AUTO_RE.test(text) || DROP_RE.test(text);

// Backend uses UCP/schema.org-style postal address fields (street_address, address_locality, …)
const toUiAddr = (a) => ({
  name: a.name || [a.first_name, a.last_name].filter(Boolean).join(" "),
  line1: a.street_address, line2: a.extended_address || "",
  city: a.address_locality, state: a.address_region, zip: a.postal_code,
  country: a.address_country === "US" ? "United States" : a.address_country,
  phone: a.phone, email: a.email,
});
const toApiAddr = (a) => ({
  name: a.name,
  first_name: (a.name || "").split(" ")[0], last_name: (a.name || "").split(" ").slice(1).join(" "),
  street_address: a.line1, extended_address: a.line2,
  address_locality: a.city, address_region: a.state, postal_code: a.zip,
  address_country: "US", phone: a.phone, email: a.email,
});

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#4f46e5",
  "radius": 16,
  "autoOpenTrace": false
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [messages, setMessages] = useState([]);
  const [trace, setTrace] = useState([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceUnseen, setTraceUnseen] = useState(0);
  const [typing, setTyping] = useState(false);
  const [phase, setPhase] = useState("intro");

  const [results, setResults] = useState(null); // { products, merchants, meta }
  const [selected, setSelected] = useState(null);
  const [upsell, setUpsell] = useState(null);
  const [checkout, setCheckout] = useState(null); // backend checkoutView
  const [address, setAddress] = useState(null);
  const [editingAddr, setEditingAddr] = useState(false);
  const [draftAddr, setDraftAddr] = useState(null);

  const [paying, setPaying] = useState(false);
  const [gpayOpen, setGpayOpen] = useState(false);
  const [threeds, setThreeds] = useState(null); // interactive 3-D Secure step-up: { continue_url, amount, assertion }
  const [payMethod, setPayMethod] = useState(null);
  const [payMethods, setPayMethods] = useState([]); // wallet methods for the in-sheet picker
  const [lastChatFail, setLastChatFail] = useState(null); // retry support for LLM chat
  const [passkey, setPasskey] = useState(null);
  const passkeySkipped = useRef(false); // session memory: user chose "pay without Touch ID"
  const [payRail, setPayRail] = useState("card_network"); // multi-rail: previewed from policy, confirmed at /pay
  const [order, setOrder] = useState(null);
  const [shipped, setShipped] = useState(false);
  const [urls, setUrls] = useState(null);
  const [input, setInput] = useState("");

  const [scenOpen, setScenOpen] = useState(false);
  const [scenarios, setScenarios] = useState([]);
  const [scenPasskey, setScenPasskey] = useState(false); // an enrolled passkey blocks unattended demos
  const [scenRunning, setScenRunning] = useState(null);
  const [scenResult, setScenResult] = useState(null);
  const [llmAgent, setLlmAgent] = useState(false);
  const [llmChat, setLlmChat] = useState(false); // interactive LLM chat mode (vs scripted)
  const [autonomous, setAutonomous] = useState(false); // human-not-present: agent signs & pays under user-signed open mandates
  const [hnpSetup, setHnpSetup] = useState(null); // interactive HNP authorize: { merchants, payment_methods, constraints }
  const [autoSnap, setAutoSnap] = useState(null); // snapshot from a scenario / LLM-agent run

  const busy = useRef(false);
  const coShown = useRef(false); // whether the checkout card is already on screen (LLM chat)
  const threadRef = useRef(null);
  const checkoutRef = useRef(null); useEffect(() => { checkoutRef.current = checkout; }, [checkout]);
  const traceOpenRef = useRef(traceOpen); useEffect(() => { traceOpenRef.current = traceOpen; }, [traceOpen]);

  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty("--accent", t.accent);
    r.style.setProperty("--radius", t.radius + "px");
  }, [t.accent, t.radius]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, typing]);

  // session bootstrap: connect to the agent backend + live protocol trace
  useEffect(() => {
    (async () => {
      try {
        const s = await API.init((ev) => {
          setTrace((tr) => [...tr, ev]);
          setTraceUnseen((n) => (traceOpenRef.current ? 0 : n + 1));
          if (TWEAK_DEFAULTS.autoOpenTrace && ev.layer === "AP2" && !traceOpenRef.current) openTrace();
        });
        setUrls(s.urls || null);
        const a = toUiAddr(s.address);
        setAddress(a); setDraftAddr(a);
        await sleep(400);
        const llmOn = !!s.llm;
        addWelcome(s.user.name.split(" ")[0], llmOn);
      } catch (e) {
        addBot(`<b>Backend unreachable.</b> Start all services with <code>npm run dev</code> and reload. (${e.message})`);
      }
    })();
  }, []);

  /* ---------- primitives ---------- */
  function addBot(html) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind: "text", html }]); }
  function addUser(text) { setMessages((m) => [...m, { id: nextUid(), role: "user", kind: "text", html: text }]); }
  function addBlock(kind) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind }]); }
  function addSnap(kind, snap, interactive) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind, snap, interactive }]); }
  function addWelcome(name, llmOn) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind: "welcome", name, llmOn }]); }
  async function botType(ms = 600) { setTyping(true); await sleep(ms); setTyping(false); }
  function openTrace() { setTraceOpen(true); setTraceUnseen(0); }
  // Friendlier failures: protocol error codes become styled cards with a fix-it hint.
  const ERR_TITLES = {
    approval_pending: ["⏳", "Waiting for your approval"],
    policy_per_tx_cap_exceeded: ["🛡", "Blocked by your spend policy"],
    policy_budget_exceeded: ["🛡", "Budget exhausted"],
    policy_merchant_not_allowed: ["🛡", "Merchant not on your allowlist"],
    policy_autonomy_violation: ["🛡", "Autonomy limit reached"],
    policy_window_expired: ["🛡", "Authorization window expired"],
    agent_untrusted: ["🚫", "Agent not trusted (KYA)"],
    velocity_exceeded: ["🚦", "Rate-limited by the PSP"],
    payment_declined: ["💳", "Payment declined"],
    token_revoked: ["🔒", "Payment token revoked"],
    user_verification_required: ["🔐", "Touch ID required"],
    user_verification_failed: ["🔐", "Touch ID verification failed"],
  };
  function fail(e) {
    const t = e.code && ERR_TITLES[e.code];
    if (t) {
      const portal = (e.hint || "").includes(urls?.paymentProvider) || (e.hint || "").includes("4103")
        ? (urls?.paymentProvider || "http://localhost:4103")
        : (urls?.credentialsProvider || "http://localhost:4102");
      addBot(
        `<div class="err-card"><div class="err-title">${t[0]} ${t[1]}</div>` +
        `<div class="err-msg">${e.message}</div>` +
        (e.hint ? `<div class="err-hint">💡 ${e.hint} <a href="${portal}" target="_blank" rel="noopener">Open →</a></div>` : "") +
        `</div>`
      );
    } else {
      addBot(
        `<div class="err-card"><div class="err-title">⚠️ Something went wrong</div>` +
        `<div class="err-msg">${e.message}</div>` +
        `<div class="err-hint">💡 Check the <b>Protocol trace →</b> for the underlying call, or start over with a fresh request.</div></div>`
      );
    }
  }

  /* ---------- scenario runner ---------- */
  useEffect(() => { API.scenarios().then((d) => { setScenarios(d.scenarios || []); setLlmAgent(!!d.llm_agent); setLlmChat(!!d.llm_agent); }).catch(() => {}); }, []);

  // Unattended demos can't press Touch ID — check for an enrolled passkey whenever the panel opens.
  useEffect(() => {
    if (scenOpen) API.passkeyStatus().then((s) => setScenPasskey(!!s.enrolled)).catch(() => setScenPasskey(false));
  }, [scenOpen]);

  async function removePasskeyForDemos() {
    try {
      await API.passkeyRemove();
      setScenPasskey(false);
      addBot(`🔓 <b>Passkey removed.</b> Checkout approval falls back to the simulated trusted surface, so automated demos can run unattended. You can re-enrol Touch ID any time from the payment sheet.`);
    } catch (e) { fail(e); }
  }

  // One interactive LLM chat turn — the model reasons, calls tools, and replies;
  // we render its words + whatever it found / put in the cart / bought this turn.
  // Typewriter: progressively reveal the LLM's reply word by word.
  async function addBotTyped(html) {
    const id = nextUid();
    setMessages((m) => [...m, { id, role: "bot", kind: "text", html: "" }]);
    const tokens = html.split(/( )/);
    let acc = "";
    for (let i = 0; i < tokens.length; i++) {
      acc += tokens[i];
      if (i % 3 === 0 || i === tokens.length - 1) {
        const cur = acc;
        setMessages((m) => m.map((x) => (x.id === id ? { ...x, html: cur } : x)));
        await sleep(14);
      }
    }
  }

  async function sendLlmTurn(text) {
    if (busy.current) return; busy.current = true;
    setLastChatFail(null);
    addUser(text); setTyping(true);
    try {
      const r = await API.chat(text);
      setTyping(false);
      const tools = (r.steps || []).map((s) => s.tool);
      if (tools.length) addBot(`<span style="color:var(--muted);font-size:12px">⚙ ${tools.map((t) => `<code>${t}</code>`).join(" → ")}</span>`);
      if (r.reply) await addBotTyped(r.reply.replace(/\n/g, "<br/>"));
      const snap = r.snapshot;
      setAutoSnap(snap); // keep latest for the receipt-PDF button
      if (tools.includes("search_products") && snap.products) addSnap("snap-products", snap, true); // clickable → talks to the LLM
      // Once the LLM has a checkout, hand off to the SAME interactive checkout
      // card + Google Pay flow as the scripted mode — the user reviews & pays.
      if (snap.checkout) {
        setCheckout(snap.checkout);
        previewRail(snap.checkout.totals?.total ?? 0);
        if (snap.checkout.address) { const a = toUiAddr(snap.checkout.address); setAddress(a); setDraftAddr(a); }
        if (!coShown.current) { coShown.current = true; addBlock("checkout"); }
        setPhase("checkout");
      } else {
        setPhase("llmchat");
      }
    } catch (e) { setTyping(false); addBot(`LLM error: ${e.message}`); }
    busy.current = false;
  }

  function resetForAuto() {
    coShown.current = false;
    setTrace([]); setTraceUnseen(0); setMessages([]); setResults(null); setCheckout(null); setOrder(null); setAutoSnap(null); setPhase("scenario");
  }

  // Render the rich result of an automated run: what the agent found, what it
  // picked, and the receipt — so autonomous flows are tangible, not just text.
  function renderSnapshot(snap) {
    if (!snap) return;
    setAutoSnap(snap);
    if (snap.products) addBlock("snap-products");
    if (snap.order && snap.checkout) addBlock("snap-receipt");
  }

  async function runScenario(sc) {
    if (scenRunning) return;
    setScenRunning(sc.id); setScenResult(null); setScenOpen(false);
    resetForAuto();
    addBot(`<b>⚙️ Automated demo · ${sc.title}</b><br/><span style="color:var(--muted)">${sc.blurb}</span><br/>This runs by itself (no manual choices) so you can watch the real protocol in the <b>Protocol trace →</b>`);
    openTrace();
    try {
      await API.reset((ev) => { setTrace((tr) => [...tr, ev]); setTraceUnseen((n) => n + 1); });
      const r = await API.runScenario(sc.id);
      setScenResult({ sc, r });
      const isFailure = sc.kind === "failure";
      const ok = !/unexpected/i.test(r.outcome); // failure flows end in a rejection outcome; anything "unexpected_success" is a bug
      const icon = ok ? (isFailure ? "🛡️" : "✅") : "⚠️";
      const verdict = isFailure
        ? ok
          ? `<b>${icon} Correctly ${r.outcome === "order_created_after_3ds" ? "recovered" : "rejected"}</b> — the protocol caught it${r.detail && r.detail.code ? ` with <code>${r.detail.code}</code>` : ""}.`
          : `<b>${icon} Unexpectedly succeeded</b> — this attack flow should have been rejected. Check the protocol trace.`
        : `<b>${icon} ${r.outcome.replace(/_/g, " ")}</b>`;
      addBot(`${verdict} ${r.detail && r.detail.error ? `<br/><span style="color:var(--muted)">${r.detail.error}</span>` : ""}`);
      renderSnapshot(r.snapshot);
    } catch (e) {
      setScenResult({ sc, r: { outcome: "could_not_complete", detail: { code: e.code, error: e.message } } });
      fail(e);
      if (e.code === "user_verification_required") setScenOpen(true); // reopen the panel — it shows the passkey notice + one-click fix
    }
    setScenRunning(null);
  }

  async function runLlmAgent() {
    const goal = input.trim() || "Find me over-ear noise-cancelling headphones under $300 with 2-day delivery and buy the best one.";
    setInput(""); setScenOpen(false);
    resetForAuto();
    addUser(goal);
    addBot(`<b>🤖 Autonomous mode (human-not-present).</b> You've signed open mandates authorizing me to act; I'll search, pick, check out, and sign the closed mandates myself under those open mandates — no card tap — then show you the result.`);
    openTrace();
    try {
      await API.reset((ev) => { setTrace((tr) => [...tr, ev]); setTraceUnseen((n) => n + 1); });
      await botType(700);
      const r = await API.agent(goal, false);
      addBot(`I called <b>${r.steps.length}</b> tools: ${r.steps.map((s) => `<code>${s.tool}</code>`).join(" → ")}.<br/>${r.final}`);
      renderSnapshot(r.snapshot);
    } catch (e) { addBot(`LLM agent error: ${e.message}. Set OPENAI_API_KEY or ANTHROPIC_API_KEY and restart.`); }
  }

  // Deterministic end-to-end HUMAN-NOT-PRESENT purchase (no LLM key needed): the
  // user authorizes once (open mandates) and leaves; the agent does the whole
  // task itself — search, pick, check out, sign the closed mandates, pay.
  // Interactive human-not-present, step 1: parse the request, then ASK the user
  // to choose the merchant allowlist + payment method (the authorization). The
  // agent only continues once the user authorizes — then it runs on its own.
  async function runAutonomousFlow(text) {
    resetForAuto();
    addUser(text);
    openTrace();
    setTyping(true);
    try {
      // Fresh session for the autonomous flow; prepare + authorize share it.
      await API.reset((ev) => { setTrace((tr) => [...tr, ev]); setTraceUnseen((n) => n + 1); });
      const setup = await API.autonomyPrepare(text);
      setTyping(false);
      const c = setup.constraints || {};
      const cap = c.buy_below != null ? `buy only at ≤ $${c.buy_below}` : c.max_total != null ? `budget ≤ $${c.max_total}` : "your budget";
      if (!setup.products?.length) { addBot(`I searched but nothing fit those constraints — try relaxing the budget or features.`); return; }
      setHnpSetup(setup);
      addBot(`<b>🤝 Human-not-present.</b> Before I shop on your own, authorize me <b>once</b>: choose which <b>merchants</b> I may use and the <b>payment method</b>. I'll sign Open Checkout + Payment Mandates to those constraints (${cap}), then complete the purchase myself — no further taps.`);
      addBlock("hnp-setup");
    } catch (e) { setTyping(false); fail(e); }
  }

  // Step 2: the user authorized — sign the open mandates with their choices and
  // run the purchase autonomously.
  async function authorizeHnp(merchantIds, methodId, methodLabel, merchantLabels) {
    setHnpSetup(null); // collapse the setup card
    addUser(`Authorize: merchants = ${merchantLabels || "any"} · pay with ${methodLabel || "default"}.`);
    addBot(`<b>🔐 Authorizing…</b> signing Open Checkout + Payment Mandates (allowed_merchants + payment method + cap) with your device key. <b>This is the only time you're in the loop</b> — then you can walk away.`);
    openTrace();
    try {
      // Same session as the prepare step — do NOT reset (that would drop the
      // discovered products/constraints the authorization needs).
      await botType(700);
      addBot(`<b>🚶 You leave.</b> No card tap, no Touch ID, no “confirm?” — I act within what you signed.`);
      await botType(500);
      const r = await API.autonomyAuthorize(merchantIds, methodId);
      if (r.order) {
        addBot(`<b>🤖 Bought it autonomously — you approved 0 times at checkout.</b> I picked <span class="hl">${r.product}</span> at the best authorized merchant, paid with ${r.payment_method || "your method"}, and signed the <b>closed</b> mandates with my <i>own</i> agent key (verified by merchant + PSP against your open mandates). Order <b>${r.order.id}</b> · <b>${S.money(r.total)}</b>.<br/><span style="color:var(--muted)">Human-present would have stopped here for your Touch ID + a tap — that's the difference.</span>`);
      } else if (r.watching) {
        const capTxt = r.cap != null ? `$${r.cap}` : "your";
        const priceTxt = r.current_total != null ? `<b>${S.money(r.current_total)}</b>` : "the best available price";
        const prod = r.product ? `for <span class="hl">${r.product}</span> ` : "";
        addBot(`<b>🤖 Held off — did NOT buy.</b> Best price ${prod}is ${priceTxt}, above your <b>${capTxt}</b> cap. Your Open Payment Mandate blocks overpaying — I'll complete only within cap. (Run the <b>HNP price-drop</b> scenario to watch the trigger fire.)`);
      } else {
        addBot(`None of the merchants you authorized had a matching offer, so I did <b>not</b> buy${r.note ? ` (${r.note})` : ""}.`);
      }
      renderSnapshot(r.snapshot);
    } catch (e) { fail(e); }
  }

  async function showOrders() {
    addUser("Show my orders.");
    await botType(500);
    try {
      const r = await API.orders(checkout && checkout.merchant_id);
      if (!r.orders.length) { addBot("No orders yet — complete a purchase or run a scenario first."); return; }
      addBot(`Linked your account via <b>OAuth</b> (scope <code>order:read</code>) and pulled <b>${r.orders.length}</b> order(s):<br/>` +
        r.orders.map((o) => `· <span class="hl">${o.id}</span> — ${SHOPPY.money((o.total||0)/100)} ${o.currency} <span style="color:var(--muted)">[${o.status}]</span>`).join("<br/>"));
    } catch (e) { fail(e); }
  }

  function snapPills(snap) {
    const c = snap.constraints || {};
    return [
      `${Object.keys(snap.products?.merchants || {}).length} merchants queried`,
      `${(snap.products?.products || []).length} within constraints`,
      [c.max_total != null ? "≤ $" + c.max_total : null, (c.features || [])[0], c.delivery_days != null ? c.delivery_days + "-day" : null].filter(Boolean).join(" · "),
    ].filter(Boolean);
  }

  function downloadReceiptPdf() {
    try {
      const co = checkout || (autoSnap && autoSnap.checkout);
      const ord = order || (autoSnap && autoSnap.order);
      const { jsPDF } = window.jspdf; const doc = new jsPDF();
      const m = co.merchant, t = co.totals;
      doc.setFontSize(18); doc.text("Receipt — " + (m.name || ""), 20, 22);
      doc.setFontSize(10); doc.setTextColor(120);
      doc.text("Order " + (ord.id || ""), 20, 30);
      doc.text("Paid with Google Pay •••• " + (ord.last4 || ""), 20, 36);
      doc.setTextColor(20); doc.setFontSize(11); let y = 50;
      co.items.forEach((it) => { doc.text(`${it.qty}× ${it.name}`, 20, y); doc.text(SHOPPY.money(it.price * it.qty), 170, y, { align: "right" }); y += 8; });
      y += 4; doc.setDrawColor(220); doc.line(20, y, 190, y); y += 8;
      const rows = [["Subtotal", t.subtotal], ["Shipping", t.shipping], ["Discount", -t.discount], ["Tax", t.tax]];
      rows.forEach(([k, v]) => { doc.text(k, 20, y); doc.text(SHOPPY.money(v), 170, y, { align: "right" }); y += 7; });
      doc.setFontSize(13); doc.text("Total", 20, y + 3); doc.text(SHOPPY.money(t.total), 170, y + 3, { align: "right" });
      y += 16; doc.setFontSize(9); doc.setTextColor(120);
      doc.text("AP2 mandates verified: Intent · Cart · Payment · Checkout (SD-JWT+kb). UCP + AP2 demo receipt.", 20, y);
      doc.save(`receipt-${ord.id || "order"}.pdf`);
    } catch (e) { addBot("Couldn't generate the PDF: " + e.message); }
  }

  /* ---------- flow: search ---------- */
  async function runIntent(userText) {
    if (busy.current) return; busy.current = true;
    const text = userText || "I'm looking for over-ear noise-cancelling headphones. Budget is under $300, and I need them delivered within 2 days.";
    addUser(text);
    setTyping(true);
    try {
      const r = await API.intent(text, autonomous ? false : undefined);
      setTyping(false);
      const c = r.constraints;
      const bits = [];
      if (c.category) bits.push(c.category);
      if (c.required_features?.length) bits.push(c.required_features.join(" · "));
      if (c.max_total != null) bits.push("under $" + c.max_total);
      if (c.delivery_days != null) bits.push(c.delivery_days + "-day delivery");
      addBot(
        autonomous
          ? `Locked in — <b>${bits.join(" · ") || c.query}</b>${c.engine === "llm" ? " (parsed by LLM)" : ""}. You signed <span class="hl">Open Checkout + Payment Mandates</span> (constraints + <code>cnf</code>=my key) — I'll buy autonomously within them, no card tap.`
          : `Locked in — <b>${bits.join(" · ") || c.query}</b>${c.engine === "llm" ? " (parsed by LLM)" : ""}. I'll show you options; you approve and pay. (The closed Checkout & Payment Mandates are signed at pay time.)`
      );
      await botType(500);
      if (!r.products.length) {
        addBot(`I queried <b>${r.merchantsQueried} merchants</b> over UCP but nothing fit those constraints. Try relaxing the budget or features.`);
        busy.current = false; return;
      }
      const pills = [
        `${r.merchantsQueried} merchants queried`,
        `${r.products.length} product${r.products.length > 1 ? "s" : ""} within constraints`,
        [c.max_total != null ? "≤ $" + c.max_total : null, c.required_features?.length ? c.required_features[0] : null, c.delivery_days != null ? c.delivery_days + "-day" : null].filter(Boolean).join(" · "),
      ].filter(Boolean);
      setResults({ products: r.products, merchants: r.merchants, meta: { pills } });
      const top = r.products[0];
      addBot(`I queried <b>${r.merchantsQueried} merchants</b> over signed JSON-RPC and found <b>${r.products.length}</b> matching product${r.products.length > 1 ? "s" : ""}. ${top.recommended ? `The <span class="hl">${top.name}</span> is my pick — ` : ""}I've lined up every merchant's live price so you can choose where to buy.`);
      await sleep(150);
      addBlock("products");
      setPhase("results");
    } catch (e) { setTyping(false); fail(e); }
    busy.current = false;
  }

  /* ---------- flow: select offer ---------- */
  async function selectOffer(product, offer) {
    if (busy.current) return; busy.current = true;
    const m = results.merchants[offer.merchant];
    setSelected({ productId: product.id, merchant: offer.merchant });
    addUser(`Add the ${product.name} from ${m.name} — ${S.money(offer.price)}.`);
    setTyping(true);
    try {
      const r = await API.select(product.id, offer.merchant);
      setTyping(false);
      if (r.upsell) {
        setUpsell(r.upsell);
        addBot(`Great choice. <b>${product.name}</b> from <span class="hl">${m.name}</span> at <b>${S.money(offer.price)}</b>. Since you're buying from ${m.name}, I can add a matching <b>${r.upsell.name}</b> for <b>${S.money(r.upsell.price)}</b> to the same checkout — one payment, one shipment. Want it?`);
        setPhase("selected-upsell");
      } else {
        addBot(`Done — <b>${product.name}</b> from <span class="hl">${m.name}</span> at <b>${S.money(offer.price)}</b>. Ready to check out whenever you are. One session, one payment.`);
        setPhase("selected");
      }
    } catch (e) { setTyping(false); fail(e); }
    busy.current = false;
  }

  async function addAccessory() {
    if (busy.current) return; busy.current = true;
    addUser(`Yes, add the ${upsell ? upsell.name.toLowerCase() : "accessory"}.`);
    setTyping(true);
    try {
      await API.accessory();
      setTyping(false);
      addBot(`Added the <b>${upsell.name}</b>${upsell.note ? ` (${upsell.note})` : ""}. Both items ship together. Let's check out.`);
      setPhase("selected");
    } catch (e) { setTyping(false); fail(e); }
    busy.current = false;
  }

  /* ---------- flow: open checkout ---------- */
  // Multi-rail preview: what rail will this checkout settle on? (explicit user
  // choice happens server-side; here we mirror policy preference / auto rule)
  async function previewRail(total) {
    try {
      const { policy } = await API.policy();
      const rail = policy.preferred_rail !== "auto" ? policy.preferred_rail : (total >= 500 ? "rtp" : "card_network");
      setPayRail(rail);
      return rail;
    } catch { return "card_network"; }
  }

  async function goCheckout() {
    if (busy.current) return; busy.current = true;
    addUser(`Let's check out.`);
    setTyping(true);
    try {
      const r = await API.checkout();
      setTyping(false);
      setCheckout(r);
      const m = r.merchant;
      const rail = await previewRail(r.totals.total);
      addBot(`Here's your live checkout with <span class="hl">${m.name}</span> — created over UCP, and the merchant's <b>signature on these exact terms verified</b>. I attached your default shipping address; on checkout you'll sign a <span class="hl">Checkout Mandate</span> over these exact terms for <b>${S.money(r.totals.total)}</b>. ${rail === "rtp" ? `Per your wallet policy this will settle via <span class="hl">RTP — instant bank transfer</span>.` : `Review it and pay with Google Pay when ready.`}`);
      await sleep(150);
      addBlock("checkout");
      setPhase("checkout");
    } catch (e) { setTyping(false); fail(e); }
    busy.current = false;
  }

  /* ---------- checkout interactions ---------- */
  async function changeQty(id, delta) {
    if (busy.current) return; busy.current = true;
    try {
      const r = await API.qty(id, delta);
      setCheckout(r);
    } catch (e) { fail(e); }
    busy.current = false;
  }
  function startEditAddr() { setDraftAddr(address); setEditingAddr(true); }
  async function saveAddr() {
    if (busy.current) return; busy.current = true;
    try {
      const r = await API.address(toApiAddr(draftAddr));
      setAddress(draftAddr);
      setCheckout(r);
      setEditingAddr(false);
    } catch (e) { fail(e); }
    busy.current = false;
  }

  /* ---------- pay ---------- */
  // Shape the /pay result into the view the wallet sheet consumes.
  function payView(r) {
    const rail = r.instrument?.rail === "rtp" ? "rtp" : "card_network";
    return {
      method: {
        id: r.method.id,
        network: r.method.network,
        rail,
        display: rail === "rtp" ? r.method.display.split("••••")[0].trim() : r.method.display.split("••••")[0].trim() + " · " + (r.method.network === "visa" ? "Debit" : "Credit"),
        last4: r.method.last4,
      },
      methods: r.methods || [],
      passkey: r.passkey || null,
    };
  }
  function applyPayResult(r) {
    const v = payView(r);
    setPayRail(v.method.rail);
    setPayMethod(v.method);
    setPayMethods(v.methods);
    setPasskey(v.passkey);
    return v;
  }

  // Shared "order confirmed" UI for both the human-present (card) path and the
  // autonomous (human-not-present) path.
  async function showPaidOrder(r, { assertion, auto } = {}) {
    setOrder({ id: r.order.id, eta: r.eta, last4: r.last4, total: r.total });
    await botType(500);
    const m = checkoutRef.current.merchant;
    const via = payRail === "rtp" ? "instant bank transfer (RTP)" : "Google Pay";
    const how = auto
      ? " — and I signed the closed mandates myself with my agent key under your pre-authorized open mandates (human-not-present: you approved 0 times here)"
      : ` — ✋ you approved it at checkout${assertion ? " with Touch ID" : " on the Google Pay sheet"}, and the closed mandates were signed by your device key`;
    addBot(`<b>Paid.</b> Your order with <span class="hl">${m.name}</span> is confirmed — <b>${S.money(r.total)}</b> charged via ${via}${how} (mandate chain verified by merchant and PSP), arriving <b>${r.eta}</b>. Here's your receipt.`);
    addBlock("receipt");
    setPhase("paid");
    coShown.current = false; // allow a fresh checkout card if the user shops again
  }

  async function onPay() {
    if (busy.current) return; busy.current = true;
    setPaying(true);
    try {
      const r = await API.pay();
      applyPayResult(r);
      setPaying(false);
      if (autonomous) {
        // Human-not-present: no Google Pay sheet — the agent pays autonomously
        // under the user's signed open mandates.
        const conf = await API.payConfirm(false);
        await showPaidOrder(conf, { auto: true });
      } else {
        setGpayOpen(true);
      }
    } catch (e) { setPaying(false); fail(e); }
    busy.current = false;
  }

  // In-sheet payment-method picker: re-mints the instrument for the chosen
  // method (new single-use token + handler + rail) without leaving the sheet.
  // Returns the refreshed view so the wallet frame can update itself.
  async function changePayMethod(methodId) {
    const r = await API.pay(methodId);
    return applyPayResult(r);
  }

  // Passkey enrollment, brokered for the wallet frame: the WebAuthn create()
  // ceremony runs INSIDE the wallet-origin iframe; this page only shuttles
  // options/response between the frame and the agent backend.
  function enrollOptions() {
    return API.passkeyRegisterOptions();
  }
  async function enrollComplete(response, challenge) {
    await API.passkeyRegister(response, challenge);
    const r = await API.pay(); // refresh — now enrolled, includes auth_options
    return applyPayResult(r);
  }

  async function onPayConfirm(assertion) {
    try {
      const r = await API.payConfirm(undefined, assertion);
      if (r.threeds) {
        // The issuer requires Strong Customer Authentication. Close the wallet
        // sheet and hand the bank's challenge page to the 3-D Secure modal — the
        // payment isn't done yet, so we do NOT show the wallet ✓.
        setGpayOpen(false);
        setThreeds({ continue_url: r.threeds.continue_url, amount: r.total, assertion });
        return false;
      }
      // Native-sheet behavior (Apple Pay / Google Pay): the sheet flashes a ✓
      // success state, then auto-dismisses — it must not stay interactive.
      setTimeout(() => setGpayOpen(false), 1100);
      await showPaidOrder(r, { assertion });
      return true; // tells the wallet frame to show its ✓ success state
    } catch (e) {
      setGpayOpen(false);
      fail(e);
      return false;
    }
  }

  // The bank page posted its result: on approval, resolve the challenge + retry
  // the authorization server-side; on cancel, leave the checkout payable.
  async function onThreeDsResult(outcome) {
    const t = threeds;
    setThreeds(null);
    if (outcome !== "success") {
      addBot("You cancelled 3-D Secure, so the payment wasn't completed. You can review the checkout and try paying again.");
      return;
    }
    setTyping(true);
    try {
      const r = await API.threedsResolve("success");
      setTyping(false);
      await showPaidOrder(r, { assertion: t && t.assertion });
    } catch (e) { setTyping(false); fail(e); }
  }

  /* ---------- track / webhook ---------- */
  async function trackOrder() {
    if (busy.current) return; busy.current = true;
    addUser(`Track my order.`);
    setTyping(true);
    try {
      const r = await API.track();
      setTyping(false);
      if (r.shipped) {
        setShipped(true);
        addBot(`Good news — ${checkoutRef.current.merchant.name} just shipped it. A signed <span class="hl">UCP order webhook</span> pushed the update to me: it's with <b>${r.carrier}</b> (tracking <span class="hl">${r.tracking}</span>), on track for <b>${r.eta}</b>. I'll ping you if anything changes.`);
      } else {
        addBot(`It's still being packed — the merchant's webhook hasn't fired yet. Ask me again in a few seconds.`);
      }
      setPhase("done");
    } catch (e) { setTyping(false); fail(e); }
    busy.current = false;
  }

  /* ---------- chips per phase ---------- */
  function chipsFor() {
    if (llmChat && llmAgent) {
      // In LLM chat mode, offer conversational starters that go through the LLM.
      const retry = lastChatFail ? [{ t: "↻ Retry last message", ic: "refresh", run: () => sendLlmTurn(lastChatFail) }] : [];
      // Next-step suggestion: items in the cart but no checkout yet → offer it,
      // mirroring the scripted flow's "Go to checkout" chip.
      const goCo = autoSnap && autoSnap.picked && !autoSnap.checkout
        ? [{ t: "🛒 Go to checkout", ic: "cart", run: () => sendLlmTurn("Please open the checkout for my cart.") }] : [];
      if (phase === "intro") return [...retry, { t: "Find me ANC headphones under $300, 2-day", ic: "headphones", run: () => sendLlmTurn("Find me over-ear noise-cancelling headphones under $300 with 2-day delivery.") }];
      if (phase === "paid" || phase === "done")
        return [
          ...retry,
          { t: "Track my order", ic: "truck", run: trackOrder },
          { t: "Check delivery promise", ic: "search", run: checkDeliveryChip },
          { t: "Export evidence bundle", ic: "shield", run: exportEvidence },
        ];
      return [...retry, ...goCo];
    }
    switch (phase) {
      case "intro":
        return [{ t: "Find me noise-cancelling headphones", ic: "headphones", run: () => runIntent() }];
      case "results":
        return [{ t: "Why this pick?", ic: "spark", run: explainPick }];
      case "selected-upsell":
        return [
          { t: `Add the ${upsell ? S.money(upsell.price) : ""} ${upsell ? upsell.name.split(" ").slice(-1)[0].toLowerCase() : "accessory"}`, ic: "plus", run: addAccessory },
          { t: "Just this — checkout", ic: "cart", run: goCheckout },
        ];
      case "selected":
        return [{ t: "Go to checkout", ic: "cart", run: goCheckout }];
      case "checkout":
        return [{ t: "Change shipping address", ic: "pin", run: startEditAddr }];
      case "paid":
        return [
          { t: "Track my order", ic: "truck", run: trackOrder },
          { t: "Check delivery promise", ic: "search", run: checkDeliveryChip },
          { t: "Export evidence bundle", ic: "shield", run: exportEvidence },
        ];
      case "done":
        return [
          { t: "View protocol trace", ic: "layers", run: openTrace },
          { t: "Check delivery promise", ic: "search", run: checkDeliveryChip },
          { t: "Export evidence bundle", ic: "shield", run: exportEvidence },
        ];
      default:
        return [];
    }
  }

  // Post-purchase agency: check the carrier's expectation vs the promise; if
  // late, offer to remediate (the agent secures a partial refund).
  async function checkDeliveryChip() {
    if (busy.current) return; busy.current = true;
    addUser("Is my delivery still on track?");
    try {
      await botType(500);
      const d = await API.deliveryCheck();
      if (d.late) {
        addBot(`<b>Heads up — your delivery slipped.</b> The merchant promised <b>${new Date(d.promised).toLocaleDateString()}</b> but the carrier now expects <b>${new Date(d.expected).toLocaleDateString()}</b>. I can get you a partial refund for the broken promise.`);
        await botType(600);
        const r = await API.deliveryRemediate();
        if (r.remediated) addBot(`Done — I secured a <b>${S.money((r.refund_minor || 0) / 100)} refund</b> (10% goodwill) from the merchant. The PSP issued the credit and the order shows the adjustment.`);
      } else {
        addBot(`<b>On track.</b> ${d.expected ? `The carrier expects delivery by <b>${new Date(d.expected).toLocaleDateString()}</b>, within the promise made at checkout.` : "No carrier update yet — I'll keep an eye on it."}`);
      }
    } catch (e) { fail(e); }
    busy.current = false;
  }

  // Immutable audit trail: verify the hash chain and download the evidence bundle.
  async function exportEvidence() {
    if (busy.current) return; busy.current = true;
    addUser("Export the evidence bundle");
    try {
      await botType(400);
      const audit = await API.auditVerify();
      const bundle = await API.auditBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `evidence-${bundle.session_id || "session"}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      addBot(`<b>Evidence bundle exported.</b> The audit trail is a tamper-evident hash chain — <b>${audit.length} events</b>, chain ${audit.valid ? "✓ valid" : "✗ BROKEN at " + audit.broken_at}. The bundle includes every signed mandate (the Checkout + Payment Mandates as SD-JWT+kb; open mandates when autonomous) and the chained event log — dispute-ready.`);
    } catch (e) { fail(e); }
    busy.current = false;
  }

  async function explainPick() {
    if (busy.current) return; busy.current = true;
    addUser(`Why this pick?`);
    await botType(600);
    const top = results && results.products[0];
    if (top) {
      const best = top.offers[0];
      const m = results.merchants[best.merchant];
      addBot(`The <b>${top.name}</b> hits every constraint you set, and the best live offer is <b>${S.money(best.price)}</b> from <span class="hl">${m.name}</span> (${best.ship}). ${top.note || ""} Every price you see came back from a real signed <b>catalog.search</b> call — open the protocol trace to inspect the raw JSON-RPC.`);
    }
    busy.current = false;
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    submitText(text);
  }
  // Route a message through the right flow — shared by the composer and the
  // welcome card's "try a sample search" CTA.
  function submitText(text) {
    text = (text || "").trim();
    if (!text) return;
    // Human-not-present toggle takes precedence in EVERY mode (scripted or LLM
    // chat): it routes to the interactive authorize flow (merchants + payment).
    if (autonomous) { runAutonomousFlow(text); return; }
    if (llmChat && llmAgent) { sendLlmTurn(text); return; } // real LLM, turn by turn
    if (phase === "intro" && looksAutonomous(text)) { runAutonomousFlow(text); return; } // HNP configured straight from chat
    if (phase === "intro") { runIntent(text); return; }
    (async () => {
      addUser(text);
      await botType(500);
      const hint = {
        results: "Pick a merchant on any card above and I'll start the checkout.",
        "selected": "Tap “Go to checkout” below whenever you're ready.",
        "selected-upsell": "Want the accessory, or should I go straight to checkout?",
        checkout: "Everything's set — hit <b>Pay with Google Pay</b> to finish.",
        paid: "Your order's placed — I can track it for you.",
        done: "All done! Reload the page to start a fresh session.",
      };
      addBot(hint[phase] || "I'm here whenever you're ready to keep shopping.");
    })();
  }

  /* ---------- render a message ---------- */
  function renderMsg(msg) {
    // Once the order is placed, earlier shopping surfaces become read-only —
    // mirroring real agentic checkouts (ChatGPT Instant Checkout, Apple/Google
    // Pay): the purchase controls don't stay live behind the receipt.
    const orderPlaced = phase === "paid" || phase === "done";
    if (msg.kind === "welcome")
      return <WelcomeHero name={msg.name} llmOn={msg.llmOn} llmChat={llmChat} llmAgent={llmAgent}
        onSample={() => { if (!busy.current) submitText("find ANC headphones under $300, 2-day"); }}
        onScripted={() => setLlmChat(false)} onScenarios={() => setScenOpen(true)} onTrace={openTrace} />;
    if (msg.kind === "products" && results)
      return <ProductResults products={results.products} merchants={results.merchants} onSelect={selectOffer} selected={selected} meta={results.meta} readOnly={orderPlaced} />;
    if (msg.kind === "checkout" && checkout) {
      const items = checkout.items.map((i) => ({ id: i.id, name: i.name, brand: i.brand, price: i.price, qty: i.qty }));
      return (
        <CheckoutCard rail={payRail} merchant={checkout.merchant} items={items} onQty={changeQty}
          address={address} editingAddr={editingAddr} draftAddr={draftAddr} setDraftAddr={setDraftAddr}
          onEditAddr={startEditAddr} onSaveAddr={saveAddr} totals={checkout.totals} onPay={onPay} paying={paying} paid={orderPlaced}
          mandateHint={`Merchant-signed checkout verified${checkout.merchant_signed ? " ✓" : ""} · Checkout Mandate signed at pay time`} />
      );
    }
    if (msg.kind === "receipt" && checkout && order) {
      const items = checkout.items.map((i) => ({ id: i.id, name: i.name, brand: i.brand, price: i.price, qty: i.qty }));
      return (
        <Receipt orderId={order.id} merchant={checkout.merchant} items={items} totals={checkout.totals}
          address={address} eta={order.eta} shipped={shipped} payInstrument={order.last4} onTrack={openTrace} onPdf={downloadReceiptPdf} />
      );
    }
    // ----- interactive human-not-present authorization (the one human step) -----
    if (msg.kind === "hnp-setup") {
      return hnpSetup ? <HnpSetupCard setup={hnpSetup} onAuthorize={authorizeHnp} /> : null;
    }
    // ----- automated-run (scenario / LLM agent / chat) result cards -----
    const snap = msg.snap || autoSnap;
    if (msg.kind === "snap-products" && snap && snap.products) {
      const interactive = msg.interactive && llmChat && llmAgent;
      const onPick = interactive
        ? (product, offer) => sendLlmTurn(`Add the ${product.name} from ${snap.products.merchants[offer.merchant]?.name || offer.merchant} (${S.money(offer.price)}) to my cart.`)
        : () => {};
      const showGoCheckout = interactive && autoSnap && autoSnap.picked && !autoSnap.checkout;
      return (
        <div>
          <div className="auto-cap"><Icon name="search" size={13} /> {interactive ? "Click Select (or just tell me) to add an item to your cart" : `What the agent found${snap.picked ? " · it picked the highlighted offer" : ""}`}</div>
          <ProductResults products={snap.products.products} merchants={snap.products.merchants}
            onSelect={onPick} readOnly={!interactive} meta={{ pills: snapPills(snap) }}
            selected={snap.picked ? { productId: snap.picked.productId, merchant: snap.picked.merchant } : null} />
          {showGoCheckout && (
            <button className="llm-next" onClick={() => sendLlmTurn("Please open the checkout for my cart.")}>
              <Icon name="cart" size={15} /> Go to checkout →
            </button>
          )}
        </div>
      );
    }
    if (msg.kind === "snap-checkout" && snap && snap.checkout) {
      const c = snap.checkout, t = c.totals;
      // Stop offering "Confirm & pay" once this checkout has been paid.
      const interactive = msg.interactive && llmChat && llmAgent && !(autoSnap && autoSnap.order);
      return (
        <div className="snap-co">
          <div className="auto-cap"><Icon name="cart" size={13} /> In the cart at <b style={{ color: "var(--ink)" }}>{c.merchant.name}</b> · signed checkout</div>
          {c.items.map((i) => (
            <div className="snap-co-row" key={i.id}><span>{i.qty}× {i.name}</span><span>{S.money(i.price * i.qty)}</span></div>
          ))}
          <div className="snap-co-row tot"><span>Total</span><span>{S.money(t.total)}</span></div>
          {interactive ? (
            <button className="pay-btn" style={{ marginTop: 10 }} onClick={() => sendLlmTurn("Yes, please pay now.")}>
              <Icon name="lock" size={15} /> Confirm &amp; pay {S.money(t.total)}
            </button>
          ) : (
            <div className="auto-cap" style={{ marginTop: 6 }}>
              {autoSnap && autoSnap.order ? "✓ Paid — see the receipt below." : "Tell me to pay to complete, or change the merchant / shipping."}
            </div>
          )}
        </div>
      );
    }
    if (msg.kind === "snap-receipt" && snap && snap.checkout && snap.order) {
      const c = snap.checkout;
      const items = c.items.map((i) => ({ id: i.id, name: i.name, brand: i.brand, price: i.price, qty: i.qty }));
      return (
        <Receipt orderId={snap.order.id} merchant={c.merchant} items={items} totals={c.totals}
          address={c.address ? toUiAddr(c.address) : address} eta={snap.order.eta}
          shipped={!!snap.shipped} payInstrument={snap.order.last4} onTrack={openTrace} onPdf={downloadReceiptPdf} />
      );
    }
    return <Bubble role={msg.role} html={msg.html} />;
  }

  const chips = chipsFor();

  return (
    <div className="app">
      {/* left rail */}
      <nav className="rail">
        <div className="rail-logo"><Icon name="spark" size={22} /></div>
        <div className="rail-icons">
          <button className="rail-btn active" title="Chat"><Icon name="chat" size={20} /></button>
          <button className="rail-btn" title="Orders (identity-linked)" onClick={showOrders}><Icon name="box" size={20} /></button>
          <button className={"rail-btn " + (scenOpen ? "active" : "")} title="Scenarios" onClick={() => setScenOpen((v) => !v)}><Icon name="layers" size={20} /></button>
        </div>
        <div className="rail-spacer" />
        <button className="rail-btn" title="Settings"><Icon name="settings" size={20} /></button>
        <div className="rail-avatar">AM</div>
      </nav>

      {/* center */}
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <div className="msg-av bot" style={{ width: 36, height: 36 }}><Icon name="spark" size={19} /></div>
            <div>
              <div className="topbar-name">Shoppy</div>
              <div className="topbar-sub"><span className="dot-live" /> Agentic checkout · UCP + AP2 · live backend</div>
            </div>
          </div>
          <div className="topbar-spacer" />
          <button className={"trace-toggle " + (scenOpen ? "on" : "")} style={{ marginRight: 8 }} onClick={() => setScenOpen((v) => !v)}>
            <Icon name="spark" size={16} /> Scenarios
          </button>
          <button className={"trace-toggle " + (traceOpen ? "on" : "")} onClick={() => (traceOpen ? setTraceOpen(false) : openTrace())}>
            <Icon name="layers" size={16} />
            {traceOpen ? "Hide trace" : "Protocol trace"}
            {trace.length > 0 && <span className="tt-count">{trace.length}</span>}
            {!traceOpen && traceUnseen > 0 && <span className="dot-live pulse" style={{ background: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" }} />}
          </button>
        </header>

        <div className="thread-wrap scroll" ref={threadRef}>
          <div className="thread">
            {messages.map((msg) => (
              <div className={"msg " + msg.role} key={msg.id}>
                <Avatar role={msg.role} />
                <div className="msg-col">{renderMsg(msg)}</div>
              </div>
            ))}
            {typing && <Typing />}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer-inner">
            {chips.length > 0 && !typing && (
              <div className="chips">
                {chips.map((c, i) => (
                  <button className="chip" key={i} style={{ animationDelay: i * 60 + "ms" }} onClick={() => { if (!busy.current) c.run(); }}>
                    <span className="chip-ic"><Icon name={c.ic} size={15} /></span>{c.t}
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                rows={1}
                placeholder={llmChat && llmAgent ? "Chat with the LLM — e.g. “find ANC headphones under $300, 2-day”…" : (phase === "intro" ? "Describe what you want, your budget, and constraints…" : "Message Shoppy…")}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <button className="send" disabled={!input.trim()} onClick={handleSend}><Icon name="arrowUp" size={19} /></button>
            </div>
            <div className="composer-hint">
              <span className="hint-text">{autonomous ? "Human-not-present — say what you want; I'll ask you to authorize merchants + a payment method once, then buy on my own (no card tap)" : (llmChat && llmAgent ? "Real LLM, step by step — it searches, presents options, and asks before paying" : "Scripted flow — deterministic, no API key needed")} · everything in the trace is real</span>
              <div className="composer-toggles">
                <button className={"mode-toggle " + (autonomous ? "on" : "")} title="Human-present (you approve & pay) vs human-not-present (agent buys autonomously under signed open mandates)"
                  onClick={() => { setAutonomous((v) => !v); }}>
                  <span className="dot" /> {autonomous ? "🤝 Human-not-present" : "🙋 Human-present"}
                </button>
                {llmAgent && (
                  <button className={"mode-toggle " + (llmChat ? "on" : "")} title="Toggle real LLM chat vs scripted flow"
                    onClick={() => { setLlmChat((v) => !v); }}>
                    <span className="dot" /> {llmChat ? "🤖 LLM chat" : "📜 Scripted"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {gpayOpen && checkout && (
          <WalletSheetFrame walletOrigin={(urls && urls.credentialsProvider) || "http://localhost:4102"}
            total={checkout.totals.total} address={address} merchant={checkout.merchant} method={payMethod}
            methods={payMethods} passkey={passkey}
            skipPasskeyEnroll={passkeySkipped.current} onPasskeySkipped={() => { passkeySkipped.current = true; }}
            onClose={() => setGpayOpen(false)} onConfirm={onPayConfirm}
            onChangeMethod={changePayMethod} onEnrollOptions={enrollOptions} onEnrollComplete={enrollComplete} />
        )}
        {threeds && (
          <ThreeDSModal continueUrl={threeds.continue_url} amount={threeds.amount} onResult={onThreeDsResult} />
        )}
        {scenOpen && (
          <ScenarioPanel scenarios={scenarios} running={scenRunning} result={scenResult} llmAgent={llmAgent}
            passkeyEnrolled={scenPasskey} onRemovePasskey={removePasskeyForDemos}
            onRun={runScenario} onClose={() => setScenOpen(false)} onLlm={runLlmAgent} />
        )}
      </main>

      {/* inspector — slide-in overlay (click-away to close) */}
      {traceOpen && (
        <div className="insp-scrim" onClick={(e) => { if (e.target === e.currentTarget) setTraceOpen(false); }}>
          <Inspector events={trace} onClose={() => setTraceOpen(false)} />
        </div>
      )}

      {/* tweaks */}
      <TweaksPanel>
        <TweakSection label="Appearance" />
        <TweakColor label="Accent" value={t.accent}
          options={["#4f46e5", "#0d9488", "#e0662b", "#7c3aed", "#0f766e"]}
          onChange={(v) => setTweak("accent", v)} />
        <TweakSlider label="Corner radius" value={t.radius} min={6} max={24} unit="px"
          onChange={(v) => setTweak("radius", v)} />
        <TweakSection label="Protocol trace" />
        <TweakToggle label="Auto-open on mandates" value={t.autoOpenTrace}
          onChange={(v) => setTweak("autoOpenTrace", v)} />
      </TweaksPanel>
    </div>
  );
}

// Interactive human-not-present authorization card: the user picks the merchant
// allowlist + payment method ONCE, then the agent runs the purchase on its own.
function HnpSetupCard({ setup, onAuthorize }) {
  const merchants = setup.merchants || [];
  const methods = setup.payment_methods || [];
  const [picked, setPicked] = useState(() => new Set(merchants.map((m) => m.id))); // default: all allowed
  const [method, setMethod] = useState(() => (methods.find((m) => m.default) || methods[0] || {}).id);
  const toggle = (id) => setPicked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const ids = [...picked];
  const allOn = picked.size === merchants.length;
  const methodObj = methods.find((m) => m.id === method);
  const merchantLabels = allOn ? `any (${merchants.length})` : merchants.filter((m) => picked.has(m.id)).map((m) => m.name).join(", ");
  const ready = picked.size > 0 && !!method;
  const chip = (on) => ({ padding: "6px 12px", borderRadius: 999, border: "1px solid var(--line, #e5e7eb)", background: on ? "var(--accent, #2563eb)" : "transparent", color: on ? "#fff" : "var(--ink, #111)", cursor: "pointer", fontSize: 13, fontWeight: 600 });
  const lbl = { fontSize: 12, color: "var(--muted, #6b7280)", margin: "12px 0 5px", textTransform: "uppercase", letterSpacing: ".04em" };
  return (
    <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 14, padding: 14, background: "var(--card, #fff)" }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>🤝 Authorize autonomous shopping</div>
      <div style={{ fontSize: 12.5, color: "var(--muted, #6b7280)" }}>Choose once — then I act on my own within these constraints.</div>
      <div style={lbl}>Merchants I may use</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {merchants.map((m) => (
          <button key={m.id} type="button" style={chip(picked.has(m.id))} onClick={() => toggle(m.id)}>
            {picked.has(m.id) ? "✓ " : ""}{m.name}
          </button>
        ))}
      </div>
      <div style={lbl}>Payment method</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {methods.map((m) => (
          <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer", opacity: method === m.id ? 1 : 0.85 }}>
            <input type="radio" name="hnp-method" checked={method === m.id} onChange={() => setMethod(m.id)} />
            {m.display}
          </label>
        ))}
      </div>
      <button type="button" disabled={!ready}
        style={{ marginTop: 14, width: "100%", padding: "10px 14px", borderRadius: 10, border: "none", background: ready ? "var(--accent, #2563eb)" : "var(--muted, #9ca3af)", color: "#fff", fontWeight: 700, cursor: ready ? "pointer" : "default" }}
        onClick={() => onAuthorize(ids, method, methodObj?.display, merchantLabels)}>
        🔐 Authorize &amp; let the agent buy
      </button>
      <div style={{ fontSize: 12, color: "var(--muted, #6b7280)", marginTop: 8 }}>You'll sign Open Checkout + Payment Mandates to these constraints — the only time you're asked. After this the agent completes the purchase itself (no card tap).</div>
    </div>
  );
}

function ScenarioPanel({ scenarios, running, result, llmAgent, passkeyEnrolled, onRemovePasskey, onRun, onClose, onLlm }) {
  const groups = [
    { kind: "success", label: "Success flows", color: "var(--success)" },
    { kind: "failure", label: "Failure & attack flows", color: "#dc2626" },
    { kind: "feature", label: "Capabilities", color: "var(--accent)" },
  ];
  return (
    <div className="scen-scrim" onClick={(e) => { if (e.target.classList.contains("scen-scrim")) onClose(); }}>
      <div className="scen-panel">
        <div className="scen-head">
          <div><b>Automated demos</b><div className="scen-sub">These run by themselves — no manual choices. To choose things yourself, close this and just type a request in the chat.</div></div>
          <button className="insp-x" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
        {passkeyEnrolled && (
          <div className="scen-warn">
            <div className="scen-warn-t">🔐 Touch ID passkey enrolled — demos that pay will be blocked</div>
            <div className="scen-warn-s">
              These demos run unattended, but your wallet now requires a real Touch ID assertion for every payment —
              a security feature working as designed. Demos that don't reach payment still work. To run the rest,
              temporarily remove the passkey (approval falls back to the simulated trusted surface):
            </div>
            <button className="scen-run warn" onClick={onRemovePasskey}>Remove passkey for demos</button>
          </div>
        )}
        <div className="scen-llm">
          <div className="scen-llm-t"><Icon name="spark" size={14} /> Autonomous AI purchase</div>
          <div className="scen-llm-s">{llmAgent ? "An LLM drives the tool calls end-to-end. Type a goal in the chat composer, then run:" : "Set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable the LLM loop. Without a key, use the scripted scenarios below."}</div>
          <button className="scen-run llm" disabled={!llmAgent} onClick={onLlm}>Run LLM agent →</button>
        </div>
        <div className="scen-body">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="scen-group" style={{ color: g.color }}>{g.label}</div>
              {scenarios.filter((s) => s.kind === g.kind).map((s) => (
                <button key={s.id} className={"scen-item " + (running === s.id ? "running" : "")} disabled={!!running} onClick={() => onRun(s)}>
                  <div className="scen-dot" style={{ background: g.color }} />
                  <div className="scen-info"><b>{s.title}</b><span>{s.blurb}</span></div>
                  {running === s.id ? <Icon name="refresh" size={15} className="spin" /> : <Icon name="chevR" size={15} />}
                </button>
              ))}
            </div>
          ))}
        </div>
        {result && (
          <div className="scen-result">
            <b>{result.sc.title}</b> → <span className="hl">{result.r.outcome.replace(/_/g, " ")}</span>
            {result.r.detail && result.r.detail.code && <code> {result.r.detail.code}</code>}
            {result.r.outcome === "could_not_complete" && (
              <div className="scen-result-why">
                This demo couldn't finish: {result.r.detail && result.r.detail.error ? result.r.detail.error : "an unexpected error occurred"}.
                {result.r.detail && result.r.detail.code === "user_verification_required" && " See the notice above for the one-click fix."}
              </div>
            )}
            <pre>{JSON.stringify(result.r.detail, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
