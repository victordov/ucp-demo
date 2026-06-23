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

function MerchantRow({ product, offer, merchants, onSelect, selected, readOnly }) {
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
      <button className={"m-add " + (isSel ? "added" : "")} disabled={readOnly && !isSel} onClick={() => { if (!readOnly) onSelect(product, offer); }}>
        {isSel ? <><Icon name="checkSmall" size={14} stroke={2.6} /> {readOnly ? "Agent picked" : "Added"}</> : <>Select</>}
      </button>
    </div>
  );
}

function ProductCard({ product, merchants, onSelect, selected, readOnly }) {
  const [expanded, setExpanded] = useStateI(product.recommended);
  const lowest = Math.min(...product.offers.map((o) => o.price));
  return (
    <div className={"pcard " + (product.recommended ? "recommended" : "")}>
      <div className="pcard-top">
        <div className="pcard-img">
          {product.image
            ? <img src={product.image} alt={product.name} loading="lazy" />
            : <><Icon name="headphones" size={40} /><div className="ph-label">product image</div></>}
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
          <MerchantRow key={i} product={product} offer={o} merchants={merchants} onSelect={onSelect} selected={selected} readOnly={readOnly} />
        ))}
      </div>
    </div>
  );
}

function ProductResults({ products, merchants, onSelect, selected, meta, readOnly }) {
  const pills = (meta && meta.pills) || [];
  return (
    <div className="cards">
      <div className="search-meta">
        <Icon name="search" size={14} />
        {pills.map((p, i) => <span className="pill" key={i}>{p}</span>)}
      </div>
      {products.map((p) => (
        <ProductCard key={p.id} product={p} merchants={merchants} onSelect={onSelect} selected={selected} readOnly={readOnly} />
      ))}
    </div>
  );
}

/* welcome hero — the first thing the user sees */
function WelcomeHero({ name, llmOn, llmChat, llmAgent, onSample, onScripted, onScenarios, onTrace }) {
  const cards = [
    {
      key: "llm", ic: "chat", title: "LLM chat", on: llmChat && llmAgent,
      desc: "A real LLM drives the chat — it searches, compares merchants, and asks before paying.",
      cta: "Try a sample search", run: onSample,
    },
    {
      key: "scr", ic: "code", title: "Scripted", on: !llmChat,
      desc: "Deterministic flow — you click to pick merchant, shipping & payment. No API key needed.",
      cta: llmChat ? "Switch to scripted" : "You're in scripted", run: onScripted,
    },
    {
      key: "scn", ic: "layers", title: "Scenarios",
      desc: "One-click automated demos covering success, failure & attack flows.",
      cta: "Open scenarios", run: onScenarios,
    },
  ];
  return (
    <div className="welcome">
      <div className="welcome-greet">
        Hi {name} — I'm <b>Shoppy</b>, an agentic-commerce demo. Pick how you'd like to start:
      </div>
      <div className="welcome-cards">
        {cards.map((c) => (
          <button className="wcard" key={c.key} onClick={c.run}>
            <div className={"wcard-ic " + c.key}><Icon name={c.ic} size={17} /></div>
            <div className="wcard-title">{c.title}{c.on && <span className="wcard-on">ON</span>}</div>
            <div className="wcard-desc">{c.desc}</div>
            <div className="wcard-cta">{c.cta} <Icon name="chevR" size={14} /></div>
          </button>
        ))}
      </div>
      <div className="welcome-foot">
        <Icon name="layers" size={14} style={{ color: "var(--muted)" }} />
        <span>Everything you do shows up as real signed calls in the</span>
        <button className="welcome-link" onClick={onTrace}>Protocol trace <Icon name="chevR" size={12} /></button>
      </div>
    </div>
  );
}

window.ChatUI = { Avatar, Bubble, Typing, ProductResults, WelcomeHero };
