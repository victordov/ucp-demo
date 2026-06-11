/* ============ Shoppy — main app / conversation state machine ============ */
const { useState, useEffect, useRef } = React;
const { Avatar, Bubble, Typing, ProductResults } = ChatUI;
const { CheckoutCard, GooglePaySheet, Receipt, GPayMark } = Checkout;
const S = window.SHOPPY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _uid = 0;
const nextUid = () => "u" + _uid++;

function computeTotals(items) {
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const shipping = 0;
  const discount = items.length ? 5 : 0;
  const tax = +((subtotal - discount) * 0.08625).toFixed(2);
  const total = +(subtotal - discount + shipping + tax).toFixed(2);
  return { subtotal: +subtotal.toFixed(2), shipping, discount, tax, total };
}

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

  const [cart, setCart] = useState({ merchant: null, items: [] });
  const [selected, setSelected] = useState(null);
  const [address, setAddress] = useState(S.DEFAULT_ADDRESS);
  const [editingAddr, setEditingAddr] = useState(false);
  const [draftAddr, setDraftAddr] = useState(S.DEFAULT_ADDRESS);

  const [paying, setPaying] = useState(false);
  const [gpayOpen, setGpayOpen] = useState(false);
  const [order, setOrder] = useState(null);
  const [shipped, setShipped] = useState(false);
  const [input, setInput] = useState("");

  const busy = useRef(false);
  const threadRef = useRef(null);
  const ids = useRef({});

  // mirror to refs for async closures
  const cartRef = useRef(cart); useEffect(() => { cartRef.current = cart; }, [cart]);
  const addrRef = useRef(address); useEffect(() => { addrRef.current = address; }, [address]);

  // apply tweaks to CSS vars
  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty("--accent", t.accent);
    r.style.setProperty("--radius", t.radius + "px");
  }, [t.accent, t.radius]);

  // autoscroll
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, typing]);

  // greeting
  useEffect(() => {
    (async () => {
      await sleep(450);
      addBot(`Hi Alex — I'm <b>Shoppy</b>. Tell me what you're shopping for, plus your budget and any must-haves, and I'll search across merchants and handle checkout for you.`);
    })();
  }, []);

  /* ---------- primitives ---------- */
  function addBot(html) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind: "text", html }]); }
  function addUser(text) { setMessages((m) => [...m, { id: nextUid(), role: "user", kind: "text", html: text }]); }
  function addBlock(kind) { setMessages((m) => [...m, { id: nextUid(), role: "bot", kind }]); }

  async function botType(ms = 750) { setTyping(true); await sleep(ms); setTyping(false); }

  function emit(builder, ctx, auto = false) {
    const ev = builder(ctx);
    if (ev._checkoutId) ids.current.checkoutId = ev._checkoutId;
    ev.uid = "ev" + _uid++;
    ev.ts = Date.now();
    ev._auto = auto;
    setTrace((tr) => [...tr, ev]);
    setTraceUnseen((n) => (traceOpenRef.current ? 0 : n + 1));
    if (t.autoOpenTrace && ev.layer === "AP2" && !traceOpenRef.current) openTrace();
  }
  const traceOpenRef = useRef(traceOpen); useEffect(() => { traceOpenRef.current = traceOpen; }, [traceOpen]);
  function openTrace() { setTraceOpen(true); setTraceUnseen(0); }

  /* ---------- flow: search ---------- */
  async function runIntent(userText) {
    if (busy.current) return; busy.current = true;
    addUser(userText || S.USER_INTENT_TEXT);
    await botType(900);
    emit(S.TRACE.discovery);
    await sleep(260); emit(S.TRACE.negotiate);
    await sleep(320); emit(S.TRACE.intentMandate, null, true);
    addBot(`Locked in. I captured your constraints as a signed <span class="hl">Intent Mandate</span> — <b>over-ear · noise-cancelling · under $300 · 2-day delivery</b>. That's the boundary I'll shop within.`);
    await sleep(500);
    emit(S.TRACE.catalogSearch);
    await botType(950);
    addBot(`I queried <b>4 merchants</b> and found <b>3</b> that fit. Here they are — the <span class="hl">Cadence ANC Pro</span> is my pick, and I've lined up every merchant's price so you can choose where to buy.`);
    await sleep(200);
    addBlock("products");
    setPhase("results");
    busy.current = false;
  }

  /* ---------- flow: select offer ---------- */
  async function selectOffer(product, offer) {
    if (busy.current) return; busy.current = true;
    const m = S.MERCHANTS[offer.merchant];
    setSelected({ productId: product.id, merchant: offer.merchant });
    const item = { id: product.id, name: product.name, brand: product.brand, price: offer.price, qty: 1 };
    setCart({ merchant: m, items: [item] });
    addUser(`Add the ${product.name} from ${m.name} — ${S.money(offer.price)}.`);
    await botType(800);
    const canUpsell = offer.merchant === "wavelength" && product.id === "cadence-anc-pro";
    if (canUpsell) {
      addBot(`Great choice. <b>${product.name}</b> from <span class="hl">${m.name}</span> at <b>${S.money(offer.price)}</b> with free 2-day shipping. Since you're buying from ${m.name}, I can add a matching <b>Travel Hardcase</b> for <b>${S.money(S.ACCESSORY.price)}</b> to the same checkout — one payment, one shipment. Want it?`);
      setPhase("selected-upsell");
    } else {
      addBot(`Done — <b>${product.name}</b> from <span class="hl">${m.name}</span> at <b>${S.money(offer.price)}</b>. Ready to check out whenever you are. One session, one payment.`);
      setPhase("selected");
    }
    busy.current = false;
  }

  async function addAccessory() {
    if (busy.current) return; busy.current = true;
    const a = S.ACCESSORY;
    setCart((c) => ({ ...c, items: [...c.items, { id: a.id, name: a.name, brand: a.brand, price: a.price, qty: 1 }] }));
    addUser(`Yes, add the travel case.`);
    await botType(650);
    addBot(`Added the <b>${a.name}</b> (${a.note}). Both items ship together from Wavelength. Let's check out.`);
    setPhase("selected");
    busy.current = false;
  }

  /* ---------- flow: open checkout ---------- */
  async function goCheckout() {
    if (busy.current) return; busy.current = true;
    addUser(`Let's check out.`);
    await botType(850);
    const c = cartRef.current;
    const totals = computeTotals(c.items);
    emit(S.TRACE.createCheckout, { merchant: c.merchant, items: c.items, address: addrRef.current });
    await sleep(320);
    emit(S.TRACE.updateCheckout, { checkoutId: ids.current.checkoutId, address: addrRef.current, ...totals });
    await sleep(340);
    const cm = S.TRACE.cartMandate({ merchant: c.merchant, items: c.items, checkoutId: ids.current.checkoutId, total: totals.total });
    cm.uid = "ev" + _uid++; cm.ts = Date.now(); cm._auto = true;
    ids.current.cartId = cm.mandate.id;
    setTrace((tr) => [...tr, cm]);
    setTraceUnseen((n) => (traceOpenRef.current ? 0 : n + 1));
    if (t.autoOpenTrace && !traceOpenRef.current) openTrace();
    addBot(`Here's your checkout with <span class="hl">${c.merchant.name}</span>. I attached your <b>default shipping address</b> and sealed a <span class="hl">Cart Mandate</span> for <b>${S.money(totals.total)}</b> — verified to sit under your $300 intent. Review it and pay with Google Pay when ready.`);
    await sleep(150);
    addBlock("checkout");
    setPhase("checkout");
    busy.current = false;
  }

  /* ---------- checkout interactions ---------- */
  function changeQty(id, delta) {
    setCart((c) => {
      let items = c.items.map((i) => (i.id === id ? { ...i, qty: Math.max(1, i.qty + delta) } : i));
      return { ...c, items };
    });
  }
  function startEditAddr() { setDraftAddr(address); setEditingAddr(true); }
  function saveAddr() { setAddress(draftAddr); setEditingAddr(false); }

  /* ---------- pay ---------- */
  async function onPay() {
    if (busy.current) return; busy.current = true;
    setPaying(true);
    emit(S.TRACE.mintInstrument, null, false);
    await sleep(700);
    setPaying(false);
    setGpayOpen(true);
    busy.current = false;
  }

  async function onPayConfirm() {
    setGpayOpen(false);
    const c = cartRef.current;
    const totals = computeTotals(c.items);
    // payment mandate
    const pm = S.TRACE.paymentMandate({ merchant: c.merchant, total: totals.total, cartId: ids.current.cartId });
    pm.uid = "ev" + _uid++; pm.ts = Date.now(); pm._auto = true; ids.current.payId = pm.mandate.id;
    setTrace((tr) => [...tr, pm]);
    setTraceUnseen((n) => (traceOpenRef.current ? 0 : n + 1));
    await sleep(450);
    const orderId = "ord_" + S.shortHash(12);
    const eta = new Date(Date.now() + 2 * 864e5).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    ids.current.orderId = orderId; ids.current.eta = eta;
    emit(S.TRACE.completeCheckout, { checkoutId: ids.current.checkoutId, orderId, total: totals.total, cartId: ids.current.cartId, payId: ids.current.payId, eta });
    setOrder({ id: orderId, eta });
    await botType(900);
    addBot(`<b>Paid.</b> Your order with <span class="hl">${c.merchant.name}</span> is confirmed — <b>${S.money(totals.total)}</b> charged via Google Pay, arriving <b>${eta}</b>. Here's your receipt.`);
    addBlock("receipt");
    setPhase("paid");
  }

  /* ---------- track / webhook ---------- */
  async function trackOrder() {
    if (busy.current) return; busy.current = true;
    addUser(`Track my order.`);
    await botType(700);
    emit(S.TRACE.webhook, { orderId: ids.current.orderId, eta: ids.current.eta }, false);
    setShipped(true);
    addBot(`Good news — ${cartRef.current.merchant.name} just shipped it. A <span class="hl">UCP order webhook</span> pushed the update to me: it's with <b>UPS</b>, still on track for <b>${ids.current.eta}</b>. I'll ping you if anything changes.`);
    setPhase("done");
    busy.current = false;
  }

  /* ---------- chips per phase ---------- */
  function chipsFor() {
    switch (phase) {
      case "intro":
        return [{ t: "Find me noise-cancelling headphones", ic: "headphones", run: () => runIntent() }];
      case "results":
        return [{ t: "Why the Cadence?", ic: "spark", run: explainPick }];
      case "selected-upsell":
        return [
          { t: `Add the ${S.money(S.ACCESSORY.price)} travel case`, ic: "plus", run: addAccessory },
          { t: "Just the headphones — checkout", ic: "cart", run: goCheckout },
        ];
      case "selected":
        return [{ t: "Go to checkout", ic: "cart", run: goCheckout }];
      case "checkout":
        return [{ t: "Change shipping address", ic: "pin", run: startEditAddr }];
      case "paid":
        return [{ t: "Track my order", ic: "truck", run: trackOrder }];
      default:
        return [];
    }
  }

  async function explainPick() {
    if (busy.current) return; busy.current = true;
    addUser(`Why the Cadence?`);
    await botType(750);
    addBot(`Three reasons: it's the only one with <b>hybrid ANC</b> (best at plane/office rumble), it lands at <b>$274</b> from Wavelength — well under budget — and it's the <b>cheapest 2-day</b> option. The Halo wins on battery if that matters more to you; the Lumen is the value pick at $189.`);
    busy.current = false;
  }

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (phase === "intro") { runIntent(text); return; }
    // gentle fallback for free-typed messages mid-flow
    (async () => {
      addUser(text);
      await botType(650);
      const hint = { results: "Pick a merchant on any card above and I'll start the checkout.", "selected": "Tap “Go to checkout” below whenever you're ready.", "selected-upsell": "Want the travel case, or should I go straight to checkout?", checkout: "Everything's set — hit <b>Pay with Google Pay</b> to finish.", paid: "Your order's placed — I can track it for you.", done: "All done! Anything else you'd like to find?" };
      addBot(hint[phase] || "I'm here whenever you're ready to keep shopping.");
    })();
  }

  /* ---------- render a message ---------- */
  function renderMsg(msg) {
    if (msg.kind === "products")
      return <ProductResults products={S.PRODUCTS} merchants={S.MERCHANTS} onSelect={selectOffer} selected={selected} />;
    if (msg.kind === "checkout") {
      const totals = computeTotals(cart.items);
      return (
        <CheckoutCard merchant={cart.merchant} items={cart.items} onQty={changeQty}
          address={address} editingAddr={editingAddr} draftAddr={draftAddr} setDraftAddr={setDraftAddr}
          onEditAddr={startEditAddr} onSaveAddr={saveAddr} totals={totals} onPay={onPay} paying={paying} />
      );
    }
    if (msg.kind === "receipt") {
      const totals = computeTotals(cart.items);
      return (
        <Receipt orderId={order?.id} merchant={cart.merchant} items={cart.items} totals={totals}
          address={address} eta={order?.eta} shipped={shipped} payInstrument="4291" onTrack={openTrace} />
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
          <button className="rail-btn" title="Orders"><Icon name="box" size={20} /></button>
          <button className="rail-btn" title="Saved"><Icon name="tag" size={20} /></button>
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
              <div className="topbar-sub"><span className="dot-live" /> Agentic checkout · UCP + AP2</div>
            </div>
          </div>
          <div className="topbar-spacer" />
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
                placeholder={phase === "intro" ? "Describe what you want, your budget, and constraints…" : "Message Shoppy…"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <button className="send" disabled={!input.trim()} onClick={handleSend}><Icon name="arrowUp" size={19} /></button>
            </div>
            <div className="composer-hint">Shoppy shops across merchants and pays with your authorized mandates · this is a protocol demo</div>
          </div>
        </div>

        {gpayOpen && (
          <GooglePaySheet total={computeTotals(cart.items).total} address={address} merchant={cart.merchant}
            onClose={() => setGpayOpen(false)} onConfirm={onPayConfirm} />
        )}
      </main>

      {/* inspector */}
      {traceOpen && <Inspector events={trace} onClose={() => setTraceOpen(false)} />}

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

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
