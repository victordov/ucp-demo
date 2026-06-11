/* ============ Chat UI + product results ============ */

function Avatar({ role }) {
  if (role === "user") return <div className="msg-av you">AM</div>;
  return <div className="msg-av bot"><Icon name="spark" size={18} /></div>;
}

function Bubble({ role, html, children }) {
  return (
    <div className={"bubble " + (role === "user" ? "you" : "bot")}>
      {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : children}
    </div>
  );
}

function Typing() {
  return (
    <div className="msg bot">
      <Avatar role="bot" />
      <div className="msg-col">
        <div className="bubble bot" style={{ padding: 0 }}>
          <div className="typing"><span></span><span></span><span></span></div>
        </div>
      </div>
    </div>
  );
}

function MerchantRow({ product, offer, merchants, onSelect, selected }) {
  const m = merchants[offer.merchant];
  const isSel = selected && selected.productId === product.id && selected.merchant === offer.merchant;
  return (
    <div className="mrow">
      <div className="m-logo" style={{ background: m.color }}>{m.short}</div>
      <div className="m-info">
        <div className="m-name">{m.name}</div>
        <div className="m-meta">
          <span><Icon name="star" size={11} style={{ verticalAlign: "-1px", color: "var(--warn)" }} /> {m.rating}</span>
          <span>·</span>
          <span className={offer.best ? "m-best" : ""}>{offer.ship}</span>
        </div>
      </div>
      <div className="m-price">
        {offer.was && <div className="m-was">{SHOPPY.money(offer.was)}</div>}
        <div className="m-amt">{SHOPPY.money(offer.price)}</div>
      </div>
      <button className={"m-add " + (isSel ? "added" : "")} onClick={() => onSelect(product, offer)}>
        {isSel ? <><Icon name="checkSmall" size={14} stroke={2.6} /> Added</> : <>Select</>}
      </button>
    </div>
  );
}

function ProductCard({ product, merchants, onSelect, selected }) {
  const [expanded, setExpanded] = useStateI(product.recommended);
  const lowest = Math.min(...product.offers.map((o) => o.price));
  return (
    <div className={"pcard " + (product.recommended ? "recommended" : "")}>
      <div className="pcard-top">
        <div className="pcard-img">
          <Icon name="headphones" size={40} />
          <div className="ph-label">product image</div>
        </div>
        <div className="pcard-body">
          <div className="pcard-head">
            <div>
              <div className="pcard-name">{product.name}</div>
              <div className="pcard-brand">{product.brand}</div>
            </div>
            {product.recommended && <div className="badge-rec">Top match</div>}
          </div>
          <div className="pcard-specs">
            {product.specs.map((s, i) => (
              <span className={"spec " + (s.match ? "match" : "")} key={i}>
                {s.match && <Icon name="checkSmall" size={11} stroke={2.6} />}{s.label}
              </span>
            ))}
          </div>
          <div className="pcard-note">{product.note}</div>
        </div>
      </div>

      <div className="merchants">
        <div className="merchants-h">
          <span>{product.offers.length} merchants · from {SHOPPY.money(lowest)}</span>
          {!expanded && (
            <button className="co-edit" onClick={() => setExpanded(true)}>Compare prices</button>
          )}
        </div>
        {(expanded ? product.offers : product.offers.slice(0, 1)).map((o, i) => (
          <MerchantRow key={i} product={product} offer={o} merchants={merchants} onSelect={onSelect} selected={selected} />
        ))}
      </div>
    </div>
  );
}

function ProductResults({ products, merchants, onSelect, selected }) {
  return (
    <div className="cards">
      <div className="search-meta">
        <Icon name="search" size={14} />
        <span className="pill">4 merchants queried</span>
        <span className="pill">3 within constraints</span>
        <span className="pill">≤ $300 · ANC · 2-day</span>
      </div>
      {products.map((p) => (
        <ProductCard key={p.id} product={p} merchants={merchants} onSelect={onSelect} selected={selected} />
      ))}
    </div>
  );
}

window.ChatUI = { Avatar, Bubble, Typing, ProductResults };
