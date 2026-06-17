/* ============ Checkout · Google Pay · Receipt ============ */

function GPayMark({ size = 18 }) {
  // generic "G Pay" wordmark built from basic shapes (not the proprietary button asset)
  return (
    <span className="gpay-mark" style={{ fontSize: size }}>
      <span style={{ fontWeight: 500, letterSpacing: "-0.01em" }}>
        <span style={{ color: "#4285F4" }}>G</span>
        <span style={{ color: "#EA4335" }}>o</span>
        <span style={{ color: "#FBBC05" }}>o</span>
        <span style={{ color: "#4285F4" }}>g</span>
        <span style={{ color: "#34A853" }}>l</span>
        <span style={{ color: "#EA4335" }}>e</span>
      </span>
      <span style={{ fontWeight: 600, marginLeft: 5, color: "#5F6368" }}>Pay</span>
    </span>
  );
}

function AddressBlock({ address, editing, draft, setDraft, onEdit, onSave, locked }) {
  if (editing) {
    return (
      <div className="addr-form">
        <div className="fld full"><label>Full name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
        <div className="fld full"><label>Address line 1</label><input value={draft.line1} onChange={(e) => setDraft({ ...draft, line1: e.target.value })} /></div>
        <div className="fld"><label>Apt / unit</label><input value={draft.line2} onChange={(e) => setDraft({ ...draft, line2: e.target.value })} /></div>
        <div className="fld"><label>City</label><input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} /></div>
        <div className="fld"><label>State</label><input value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })} /></div>
        <div className="fld"><label>ZIP</label><input value={draft.zip} onChange={(e) => setDraft({ ...draft, zip: e.target.value })} /></div>
        <div className="fld full" style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <button className="rcpt-btn primary" style={{ flex: "0 0 auto", padding: "0 18px", height: 36 }} onClick={onSave}>Save address</button>
        </div>
      </div>
    );
  }
  return (
    <div className="addr-card">
      <div className="addr-pin"><Icon name="pin" size={18} /></div>
      <div className="addr-body">
        <div className="addr-name">{address.name}</div>
        <div className="addr-lines">
          {address.line1}{address.line2 ? ", " + address.line2 : ""}<br />
          {address.city}, {address.state} {address.zip}<br />
          {address.country} · {address.phone}
        </div>
        <div className="addr-default"><Icon name="checkSmall" size={11} stroke={2.6} /> Default address · prefilled</div>
      </div>
      {!locked && <button className="co-edit" onClick={onEdit}>Edit</button>}
    </div>
  );
}

function CheckoutCard(props) {
  const { merchant, items, onQty, address, editingAddr, draftAddr, setDraftAddr, onEditAddr, onSaveAddr, totals, onPay, paying, mandateHint, rail, paid } = props;
  // After the order is placed the card becomes a read-only record — like a
  // completed checkout in ChatGPT's Instant Checkout, you can't keep editing
  // quantities or pay a second time.
  return (
    <div className={"checkout" + (paid ? " paid" : "")}>
      <div className="co-head">
        <div className="co-merch-logo" style={{ background: merchant.color }}>{merchant.short}</div>
        <div className="co-head-t">
          <div className="co-title">Checkout · {merchant.name}</div>
          <div className="co-sub">{merchant.domain}</div>
        </div>
        <div className="co-secure"><Icon name="lock" size={13} /> Secure</div>
      </div>

      <div className="co-section">
        <div className="co-section-h"><span>Order · {items.reduce((a, i) => a + i.qty, 0)} items</span></div>
        {items.map((it) => (
          <div className="co-item" key={it.id}>
            <div className="co-item-img">
              {it.image ? <img src={it.image} alt={it.name} /> : <Icon name={it.id.includes("case") ? "box" : "headphones"} size={20} />}
            </div>
            <div className="co-item-info">
              <div className="co-item-name">{it.name}</div>
              <div className="co-item-meta">{it.brand}</div>
            </div>
            <div className="co-qty">
              <button onClick={() => onQty(it.id, -1)} disabled={paying || paid}><Icon name="minus" size={13} /></button>
              <span>{it.qty}</span>
              <button onClick={() => onQty(it.id, 1)} disabled={paying || paid}><Icon name="plus" size={13} /></button>
            </div>
            <div className="co-item-price">{SHOPPY.money(it.price * it.qty)}</div>
          </div>
        ))}
      </div>

      <div className="co-section">
        <div className="co-section-h"><span>Ship to</span></div>
        <AddressBlock address={address} editing={!paid && editingAddr} draft={draftAddr} setDraft={setDraftAddr} onEdit={onEditAddr} onSave={onSaveAddr} locked={paid} />
      </div>

      <div className="co-totals">
        <div className="trow"><span>Subtotal</span><span className="v">{SHOPPY.money(totals.subtotal)}</span></div>
        <div className="trow"><span>Shipping · 2-day</span><span className="v">{totals.shipping === 0 ? "Free" : SHOPPY.money(totals.shipping)}</span></div>
        {totals.discount > 0 && <div className="trow discount"><span>Agent discount</span><span className="v">−{SHOPPY.money(totals.discount)}</span></div>}
        <div className="trow"><span>Tax</span><span className="v">{SHOPPY.money(totals.tax)}</span></div>
        <div className="trow grand"><span>Total</span><span className="v">{SHOPPY.money(totals.total)}</span></div>
      </div>

      <div className="co-foot">
        {paid ? (
          <div className="pay-done"><Icon name="checkSmall" size={16} stroke={2.6} /> Paid — order placed</div>
        ) : (
          <button className="pay-btn" onClick={onPay} disabled={paying || editingAddr}>
            {paying
              ? <><Icon name="refresh" size={18} className="spin" /> Opening…</>
              : rail === "rtp"
                ? <><RtpMark size={15} /> Pay · Instant Bank Transfer</>
                : <>Pay with <GPayMark size={17} /></>}
          </button>
        )}
        <div className="co-mandate-hint">
          <Icon name="seal" size={12} /> {paid ? "Payment Mandate executed · see the receipt below" : (mandateHint || "Checkout Mandate ready to sign")}
          {!paid && rail === "rtp" && <span> · settles via <b>RTP</b> (wallet policy)</span>}
        </div>
      </div>
    </div>
  );
}

/** Multi-rail: RTP (instant bank transfer) brand mark. */
function RtpMark({ size = 16 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 700 }}>
      <span style={{ width: size + 2, height: size + 2, borderRadius: 5, background: "#0d9488", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size - 4 }}>⚡</span>
      RTP
    </span>
  );
}

/* ============ Wallet payment sheet — sandboxed cross-origin iframe ============
 * Google-Pay-style isolation: the sheet UI (and the WebAuthn/SPC ceremony) is
 * served by the WALLET origin (Credentials Provider) and embedded here in a
 * sandboxed iframe with explicit `allow` delegation. The agent page never
 * renders the payment surface itself; it only brokers data over postMessage,
 * with every message pinned to the wallet origin in both directions.
 *
 * child → parent: wallet.ready | wallet.resize | wallet.close | wallet.confirm
 *                 | wallet.change_method | wallet.enroll | wallet.enrolled
 * parent → child: wallet.init | wallet.update | wallet.enroll_options | wallet.error
 */
function WalletSheetFrame({ walletOrigin, total, address, merchant, method, methods, passkey, skipPasskeyEnroll, onPasskeySkipped, onClose, onConfirm, onChangeMethod, onEnrollOptions, onEnrollComplete }) {
  const frameRef = React.useRef(null);
  const [height, setHeight] = React.useState(420);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);
  const gotReady = React.useRef(false);
  // Latest props for the message handler without re-binding the listener.
  const stateRef = React.useRef(null);
  stateRef.current = { total, address, merchant, method, methods, passkey, skipPasskeyEnroll };

  // If the sheet never signals "ready" (mixed content, CSP, blocked third-party
  // storage…), show a retry fallback instead of a hanging, empty scrim.
  React.useEffect(() => {
    gotReady.current = false;
    setLoadError(false);
    const t = setTimeout(() => { if (!gotReady.current) setLoadError(true); }, 8000);
    return () => clearTimeout(t);
  }, [reloadKey, walletOrigin]);

  React.useEffect(() => {
    let disposed = false;
    const cleanWalletOrigin = new URL(walletOrigin).origin;
    async function onMsg(e) {
      if (e.origin !== cleanWalletOrigin || disposed) return; // origin pinning
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const post = (m) => frameRef.current && frameRef.current.contentWindow.postMessage(m, cleanWalletOrigin);
      const msg = e.data || {};
      try {
        if (msg.type === "wallet.ready") { gotReady.current = true; setLoadError(false); post({ type: "wallet.init", data: stateRef.current }); }
        else if (msg.type === "wallet.resize" && msg.height) setHeight(Math.max(240, Math.min(700, msg.height)));
        else if (msg.type === "wallet.close") onClose();
        else if (msg.type === "wallet.confirm") {
          // Native payment-sheet pattern (Apple Pay / Google Pay): on success the
          // sheet shows a brief ✓ confirmation and is then dismissed by the
          // parent — it never stays interactive after payment.
          if (msg.skipped_passkey && onPasskeySkipped) onPasskeySkipped(); // remember "pay without Touch ID" for the session
          const ok = await onConfirm(msg.assertion || null);
          if (ok) post({ type: "wallet.success" });
        }
        else if (msg.type === "wallet.change_method") { const v = await onChangeMethod(msg.id); post({ type: "wallet.update", data: v }); }
        else if (msg.type === "wallet.enroll") { const options = await onEnrollOptions(); post({ type: "wallet.enroll_options", options }); }
        else if (msg.type === "wallet.enrolled") { const v = await onEnrollComplete(msg.response, msg.challenge); post({ type: "wallet.update", data: v, continue: "auth" }); }
      } catch (err) {
        post({ type: "wallet.error", message: err.message || "Something went wrong." });
      }
    }
    window.addEventListener("message", onMsg);
    return () => { disposed = true; window.removeEventListener("message", onMsg); };
  }, [walletOrigin]);

  return (
    <div className="sheet-scrim">
      {loadError ? (
        <div className="wallet-frame" role="alert" style={{ height: 240, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
          <div style={{ fontWeight: 600 }}>Couldn’t load the secure payment sheet</div>
          <div style={{ fontSize: 13, color: "var(--muted)", maxWidth: 320 }}>Check your connection, or that the wallet origin is reachable over HTTPS, then try again.</div>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="button" className="pay-btn" style={{ width: "auto", padding: "0 18px", height: 38 }} onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
            <button type="button" className="co-edit" onClick={onClose}>Cancel</button>
          </div>
        </div>
      ) : (
        <iframe
          key={reloadKey}
          ref={frameRef}
          className="wallet-frame"
          title="Walletly — secure payment"
          src={walletOrigin + "/sheet.html?r=" + reloadKey}
          allow="payment; publickey-credentials-get; publickey-credentials-create"
          sandbox="allow-scripts allow-popups allow-same-origin allow-forms"
          style={{ height }}
        />
      )}
    </div>
  );
}

/* ============ 3-D Secure step-up — the bank's challenge page, framed ============
 * When the issuer requires Strong Customer Authentication, the agent returns the
 * bank's continue_url instead of an order. We frame it (cross-origin, sandboxed)
 * and wait for the page to post its result; the parent then resolves the
 * challenge + retries the authorization server-side. */
function ThreeDSModal({ continueUrl, amount, onResult }) {
  const pspOrigin = React.useMemo(() => { try { return new URL(continueUrl).origin; } catch { return null; } }, [continueUrl]);
  const cb = React.useRef(onResult); cb.current = onResult;
  React.useEffect(() => {
    function onMsg(e) {
      if (!pspOrigin || e.origin !== pspOrigin) return; // origin-pinned to the PSP
      const msg = e.data || {};
      if (msg.type === "threeds.result") cb.current(msg.outcome === "success" ? "success" : "cancelled");
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [pspOrigin]);
  return (
    <div className="sheet-scrim">
      <div style={{ width: 380, maxWidth: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "#fff", fontSize: 12.5, marginBottom: 10, opacity: .9 }}>
          <Icon name="lock" size={13} /> Your bank · 3-D Secure{amount != null ? " · " + SHOPPY.money(amount) : ""}
        </div>
        <iframe
          className="wallet-frame"
          title="3-D Secure — bank verification"
          src={continueUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
          style={{ height: 360, width: "100%" }}
        />
      </div>
    </div>
  );
}

function Receipt({ orderId, merchant, items, totals, address, eta, onTrack, shipped, payInstrument, onPdf }) {
  return (
    <div className="receipt">
      <div className="rcpt-head">
        <div className="rcpt-check"><Icon name="check" size={26} stroke={2.6} /></div>
        <div className="rcpt-title">Payment successful</div>
        <div className="rcpt-sub">{SHOPPY.money(totals.total)} paid to {merchant.name} with Google Pay</div>
        <div className="rcpt-order">Order {orderId}</div>
      </div>

      <div className="rcpt-items">
        {items.map((it) => (
          <div className="co-item" key={it.id} style={{ padding: "8px 0" }}>
            <div className="co-item-img">
              {it.image ? <img src={it.image} alt={it.name} /> : <Icon name={it.id.includes("case") ? "box" : "headphones"} size={20} />}
            </div>
            <div className="co-item-info">
              <div className="co-item-name">{it.name}</div>
              <div className="co-item-meta">Qty {it.qty} · {merchant.name}</div>
            </div>
            <div className="co-item-price">{SHOPPY.money(it.price * it.qty)}</div>
          </div>
        ))}
      </div>

      <div className="rcpt-body">
        <div className="rcpt-line"><span className="k"><Icon name="dollar" size={15} /> Payment</span><span className="vv">Google Pay <span className="mono">•••• {payInstrument}</span></span></div>
        <div className="rcpt-line"><span className="k"><Icon name="pin" size={15} /> Ship to</span><span className="vv">{address.name}<br /><span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>{address.city}, {address.state} {address.zip}</span></span></div>
        <div className="rcpt-line"><span className="k"><Icon name="truck" size={15} /> Delivery</span><span className="vv">{eta}<br /><span style={{ fontWeight: 400, color: "var(--success)", fontSize: 12 }}>2-day · {merchant.name}</span></span></div>
        <div className="rcpt-line"><span className="k"><Icon name="seal" size={15} /> Mandates</span><span className="vv" style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>Intent · Cart · Payment<br /><span style={{ color: "var(--success)" }}>all verified ✓</span></span></div>
      </div>

      <div className="rcpt-total">
        <span className="t">Total charged</span>
        <span className="v">{SHOPPY.money(totals.total)}</span>
      </div>

      <div style={{ padding: "16px 22px 4px" }}>
        <div className="track">
          <div className="track-step done"><div className="track-line" /><div className="track-dot" /><div className="track-lbl">Ordered</div></div>
          <div className={"track-step " + (shipped ? "done" : "active")}><div className="track-line" /><div className="track-dot" /><div className="track-lbl">{shipped ? "Shipped" : "Packing"}</div></div>
          <div className="track-step"><div className="track-line" /><div className="track-dot" /><div className="track-lbl">Out for delivery</div></div>
          <div className="track-step"><div className="track-dot" /><div className="track-lbl">Delivered</div></div>
        </div>
      </div>

      <div className="rcpt-foot">
        <button className="rcpt-btn" onClick={onTrack}><Icon name="layers" size={15} /> View mandates</button>
        <button className="rcpt-btn primary" onClick={onPdf}><Icon name="download" size={15} /> Receipt PDF</button>
      </div>
    </div>
  );
}

window.Checkout = { CheckoutCard, WalletSheetFrame, Receipt, GPayMark };
