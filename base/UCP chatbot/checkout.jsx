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

function AddressBlock({ address, editing, draft, setDraft, onEdit, onSave }) {
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
      <button className="co-edit" onClick={onEdit}>Edit</button>
    </div>
  );
}

function CheckoutCard(props) {
  const { merchant, items, onQty, address, editingAddr, draftAddr, setDraftAddr, onEditAddr, onSaveAddr, totals, onPay, paying } = props;
  return (
    <div className="checkout">
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
            <div className="co-item-img"><Icon name={it.id.includes("case") ? "box" : "headphones"} size={20} /></div>
            <div className="co-item-info">
              <div className="co-item-name">{it.name}</div>
              <div className="co-item-meta">{it.brand}</div>
            </div>
            <div className="co-qty">
              <button onClick={() => onQty(it.id, -1)} disabled={paying}><Icon name="minus" size={13} /></button>
              <span>{it.qty}</span>
              <button onClick={() => onQty(it.id, 1)} disabled={paying}><Icon name="plus" size={13} /></button>
            </div>
            <div className="co-item-price">{SHOPPY.money(it.price * it.qty)}</div>
          </div>
        ))}
      </div>

      <div className="co-section">
        <div className="co-section-h"><span>Ship to</span></div>
        <AddressBlock address={address} editing={editingAddr} draft={draftAddr} setDraft={setDraftAddr} onEdit={onEditAddr} onSave={onSaveAddr} />
      </div>

      <div className="co-totals">
        <div className="trow"><span>Subtotal</span><span className="v">{SHOPPY.money(totals.subtotal)}</span></div>
        <div className="trow"><span>Shipping · 2-day</span><span className="v">{totals.shipping === 0 ? "Free" : SHOPPY.money(totals.shipping)}</span></div>
        {totals.discount > 0 && <div className="trow discount"><span>Agent discount</span><span className="v">−{SHOPPY.money(totals.discount)}</span></div>}
        <div className="trow"><span>Tax</span><span className="v">{SHOPPY.money(totals.tax)}</span></div>
        <div className="trow grand"><span>Total</span><span className="v">{SHOPPY.money(totals.total)}</span></div>
      </div>

      <div className="co-foot">
        <button className="pay-btn" onClick={onPay} disabled={paying || editingAddr}>
          {paying ? <><Icon name="refresh" size={18} className="spin" /> Opening…</> : <>Pay with <GPayMark size={17} /></>}
        </button>
        <div className="co-mandate-hint"><Icon name="seal" size={12} /> Merchant-signed checkout verified · you'll sign the Checkout Mandate · within your $300 limit</div>
      </div>
    </div>
  );
}

function GooglePaySheet({ total, address, merchant, onClose, onConfirm }) {
  const [stage, setStage] = useStateI("review"); // review | auth
  const confirm = () => {
    setStage("auth");
    setTimeout(() => onConfirm(), 1750);
  };
  return (
    <div className="sheet-scrim" onClick={(e) => { if (e.target.classList.contains("sheet-scrim") && stage === "review") onClose(); }}>
      <div className="gsheet">
        <div className="gsheet-head">
          <GPayMark size={19} />
          <div className="spacer" />
          {stage === "review" && <button className="gsheet-close" onClick={onClose}><Icon name="x" size={15} /></button>}
        </div>

        {stage === "review" ? (
          <div className="gsheet-body">
            <div className="gp-row">
              <div className="gp-card-brand">VISA</div>
              <div className="lbl"><div className="t">Visa · Debit</div><div className="s">•••• 4291</div></div>
              <Icon name="chevR" size={16} style={{ color: "var(--faint)" }} />
            </div>
            <div className="gp-row">
              <div className="ic"><Icon name="pin" size={18} /></div>
              <div className="lbl"><div className="t">{address.name}</div><div className="s">{address.line1}, {address.city} {address.state}</div></div>
              <Icon name="chevR" size={16} style={{ color: "var(--faint)" }} />
            </div>
            <div className="gp-row">
              <div className="ic"><Icon name="cart" size={18} /></div>
              <div className="lbl"><div className="t">{merchant.name}</div><div className="s">{merchant.domain}</div></div>
            </div>
            <div className="gp-total">
              <span className="t">Total</span>
              <span className="v">{SHOPPY.money(total)}</span>
            </div>
            <button className="gp-confirm" onClick={confirm}>
              <Icon name="lock" size={16} /> Confirm · Pay {SHOPPY.money(total)}
            </button>
            <div className="gp-secure-note"><Icon name="shield" size={13} /> Authorizes an AP2 Payment Mandate</div>
          </div>
        ) : (
          <div className="gsheet-body">
            <div className="gp-biometric">
              <div className="gp-bio-ring"><Icon name="finger" size={30} /></div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Verify with biometric</div>
              <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 5 }}>Authorizing {SHOPPY.money(total)} to {merchant.name}…</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Receipt({ orderId, merchant, items, totals, address, eta, onTrack, shipped, payInstrument }) {
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
            <div className="co-item-img"><Icon name={it.id.includes("case") ? "box" : "headphones"} size={20} /></div>
            <div className="co-item-info">
              <div className="co-item-name">{it.name}</div>
              <div className="co-item-meta">Qty {it.qty} · {merchant.name}</div>
            </div>
            <div className="co-item-price">{SHOPPY.money(it.price * it.qty)}</div>
          </div>
        ))}
      </div>

      <div className="rcpt-body">
        <div className="rcpt-line"><span className="k"><Icon name="dollar" size={15} /> Payment</span><span className="vv">Google Pay · Visa <span className="mono">•••• {payInstrument}</span></span></div>
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
        <button className="rcpt-btn primary"><Icon name="download" size={15} /> Receipt PDF</button>
      </div>
    </div>
  );
}

window.Checkout = { CheckoutCard, GooglePaySheet, Receipt, GPayMark };
