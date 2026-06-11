/* ============ Icon set — simple line icons ============ */
const Icon = ({ name, size = 18, stroke = 2, style }) => {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round", strokeLinejoin: "round", style };
  const I = {
    spark: <svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 4v3M20.5 5.5h-3" strokeWidth={stroke*0.8}/></svg>,
    send: <svg {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
    arrowUp: <svg {...p}><path d="M12 19V5M6 11l6-6 6 6"/></svg>,
    search: <svg {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>,
    headphones: <svg {...p}><path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>,
    shield: <svg {...p}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>,
    lock: <svg {...p}><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>,
    pin: <svg {...p}><path d="M12 21s-6-5.2-6-10a6 6 0 1112 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/></svg>,
    check: <svg {...p}><path d="M5 12l5 5L20 7"/></svg>,
    checkSmall: <svg {...p}><path d="M5 12l4 4 10-10"/></svg>,
    chevR: <svg {...p}><path d="M9 6l6 6-6 6"/></svg>,
    chevD: <svg {...p}><path d="M6 9l6 6 6-6"/></svg>,
    plus: <svg {...p}><path d="M12 5v14M5 12h14"/></svg>,
    minus: <svg {...p}><path d="M5 12h14"/></svg>,
    x: <svg {...p}><path d="M6 6l12 12M18 6L6 18"/></svg>,
    truck: <svg {...p}><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>,
    receipt: <svg {...p}><path d="M6 3h12v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2L6 21z"/><path d="M9 8h6M9 12h6"/></svg>,
    copy: <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>,
    finger: <svg {...p}><path d="M12 11v3a4 4 0 01-1 2.6M8.5 8.5a5 5 0 017 0M6.5 11a7 7 0 0111 0v1M9.5 13v1a6 6 0 01-.8 3"/></svg>,
    layers: <svg {...p}><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>,
    bolt: <svg {...p}><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></svg>,
    code: <svg {...p}><path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/></svg>,
    seal: <svg {...p}><path d="M12 3l2.2 1.6 2.7-.3 1 2.5 2.3 1.4-.6 2.7.9 2.6-2.1 1.7-.5 2.7-2.7.2L12 21l-2.4-1.2-2.7-.2-.5-2.7-2.1-1.7.9-2.6-.6-2.7 2.3-1.4 1-2.5 2.7.3z"/><path d="M9 12l2 2 4-4"/></svg>,
    cart: <svg {...p}><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.2 11h10l2-7H6"/></svg>,
    chat: <svg {...p}><path d="M4 5h16v11H9l-5 4z"/></svg>,
    clock: <svg {...p}><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>,
    star: <svg {...p}><path d="M12 4l2.3 4.7 5.2.8-3.8 3.6.9 5.1L12 16l-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z"/></svg>,
    tag: <svg {...p}><path d="M3 12l8-8h8v8l-8 8z"/><circle cx="15" cy="9" r="1.4"/></svg>,
    grid: <svg {...p}><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>,
    settings: <svg {...p}><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/></svg>,
    refresh: <svg {...p}><path d="M4 12a8 8 0 0114-5l2 2M20 12a8 8 0 01-14 5l-2-2"/><path d="M20 5v4h-4M4 19v-4h4"/></svg>,
    box: <svg {...p}><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>,
    download: <svg {...p}><path d="M12 4v10M8 11l4 4 4-4M5 19h14"/></svg>,
    dollar: <svg {...p}><path d="M12 3v18M16 7a4 3 0 00-4-2c-2.2 0-4 1.3-4 3s1.8 2.5 4 3 4 1.3 4 3-1.8 3-4 3a4 3 0 01-4-2"/></svg>,
  };
  return I[name] || null;
};
window.Icon = Icon;
