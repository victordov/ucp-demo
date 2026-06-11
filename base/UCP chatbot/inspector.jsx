/* ============ Protocol Inspector — live UCP/AP2 trace ============ */
const { useState: useStateI } = React;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function highlightJSON(obj) {
  const json = JSON.stringify(obj, null, 2);
  // tokenize line by line to color keys/strings/numbers
  return escapeHtml(json)
    .replace(/&quot;([^&]+?)&quot;(\s*:)/g, '<span class="k">"$1"</span>$2')   // keys
    .replace(/: &quot;([^]*?)&quot;/g, ': <span class="s">"$1"</span>')          // string values
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="n">$1</span>')                   // numbers
    .replace(/: (true|false|null)/g, ': <span class="n">$1</span>');
}

function CodeBlock({ obj }) {
  return <pre className="code tr-scroll" dangerouslySetInnerHTML={{ __html: highlightJSON(obj) }} />;
}

function MandateCard({ ev }) {
  const m = ev.mandate;
  return (
    <div className="mandate">
      <div className="mandate-top">
        <div className="mandate-seal"><Icon name="seal" size={18} /></div>
        <div className="mandate-t">
          <div className="mandate-name">{m.kind}</div>
          <div className="mandate-id">{m.id}</div>
        </div>
        <div className="mandate-vstamp"><Icon name="checkSmall" size={13} stroke={2.6} /> {m.seal}</div>
      </div>
      <div className="mandate-rows">
        {m.rows.map(([k, v], i) => (
          <div className="mrow-d" key={i}>
            <span className="kk">{k}</span>
            <span className="vvv">{v}</span>
          </div>
        ))}
      </div>
      <div className="mandate-sig">
        sig <span className="sg">{m.sig}…</span>
      </div>
    </div>
  );
}

function TraceEvent({ ev, index, defaultOpen }) {
  const [open, setOpen] = useStateI(!!defaultOpen);
  const icnClass = ev.kind === "response" ? "ok" : ev.layer === "AP2" ? "ap2" : "ucp";
  const t = new Date(ev.ts || Date.now());
  const time = t.toLocaleTimeString("en-US", { hour12: false }) + "." + String(t.getMilliseconds()).padStart(3, "0");
  return (
    <div className="tev" style={{ animationDelay: "0ms" }}>
      <div className={"tev-head click"} onClick={() => setOpen((o) => !o)}>
        <div className={"tev-icn " + icnClass}>
          <Icon name={ev.layer === "AP2" ? "seal" : ev.kind === "response" ? "checkSmall" : "code"} size={14} />
        </div>
        <div className="tev-mid">
          <div className="tev-name">{ev.name}</div>
          <div className="tev-meta">
            <span className={"tev-tag " + ev.layer.toLowerCase()}>{ev.layer}</span>
            <span>{ev.method}</span>
          </div>
        </div>
        <Icon name="chevR" size={15} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s", color: "var(--tr-muted)" }} />
      </div>
      {open && (
        <div className="tev-body">
          <div className="tev-meta" style={{ marginBottom: 8, fontFamily: "var(--font-mono)", fontSize: 10 }}>{time}</div>
          <div className="tev-desc">{ev.desc}</div>
          {ev.mandate && <MandateCard ev={ev} />}
          <CodeBlock obj={ev.payload} />
        </div>
      )}
    </div>
  );
}

function Inspector({ events, onClose }) {
  const [tab, setTab] = useStateI("all");
  const bodyRef = React.useRef(null);
  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [events.length]);

  const shown = events.filter((e) => tab === "all" || (tab === "ap2" && e.layer === "AP2") || (tab === "ucp" && e.layer === "UCP"));
  const mandateCount = events.filter((e) => e.layer === "AP2").length;

  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="tev-icn ap2" style={{ width: 32, height: 32, borderRadius: 9 }}><Icon name="layers" size={17} /></div>
        <div>
          <div className="insp-title">Protocol Trace</div>
          <div className="insp-sub">UCP · AP2 mandates · live</div>
        </div>
        <div className="insp-spacer" />
        <button className="insp-x" onClick={onClose} title="Hide trace"><Icon name="x" size={15} /></button>
      </div>

      <div className="insp-tabs">
        <button className={"insp-tab " + (tab === "all" ? "active" : "")} onClick={() => setTab("all")}>All · {events.length}</button>
        <button className={"insp-tab " + (tab === "ucp" ? "active" : "")} onClick={() => setTab("ucp")}>UCP</button>
        <button className={"insp-tab " + (tab === "ap2" ? "active" : "")} onClick={() => setTab("ap2")}>Mandates · {mandateCount}</button>
      </div>
      <div className="insp-legend">
        <span><span className="lg-dot" style={{ background: "var(--tr-accent)" }} /> UCP commerce</span>
        <span><span className="lg-dot" style={{ background: "var(--tr-violet)" }} /> AP2 signed mandate</span>
        <span><span className="lg-dot" style={{ background: "var(--tr-green)" }} /> response</span>
      </div>

      <div className="insp-body tr-scroll" ref={bodyRef}>
        {shown.length === 0 ? (
          <div className="insp-empty">
            No events yet.<br />
            Protocol calls appear here in real time as Shoppy works.
          </div>
        ) : (
          shown.map((ev, i) => <TraceEvent key={ev.uid} ev={ev} index={i} defaultOpen={i === shown.length - 1 && ev._auto} />)
        )}
      </div>
    </aside>
  );
}

window.Inspector = Inspector;
