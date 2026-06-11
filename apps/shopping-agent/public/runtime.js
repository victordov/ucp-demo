/* ============ Shoppy runtime — backend API client (replaces simulated data.js) ============ */

window.SHOPPY = {
  money(n) { return "$" + Number(n).toFixed(2); },
};

window.ShoppyAPI = (() => {
  let sessionId = null;

  async function post(path, body) {
    const res = await fetch("/api" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, ...(body || {}) }),
    });
    const json = await res.json();
    if (!res.ok) {
      const err = new Error(json.error || ("API error " + res.status));
      err.code = json.code; err.hint = json.hint;
      throw err;
    }
    return json;
  }

  return {
    async init(onTrace) {
      const s = await post("/session");
      sessionId = s.session_id;
      // live protocol trace via SSE
      const es = new EventSource("/api/trace/" + sessionId);
      es.onmessage = (e) => {
        try { onTrace(JSON.parse(e.data)); } catch {}
      };
      return s;
    },
    intent: (text) => post("/intent", { text }),
    select: (product_id, merchant_id) => post("/select", { product_id, merchant_id }),
    accessory: () => post("/accessory"),
    checkout: () => post("/checkout"),
    qty: (item_id, delta) => post("/qty", { item_id, delta }),
    address: (address) => post("/address", { address }),
    shipping: (option_id) => post("/shipping", { option_id }),
    promo: (code) => post("/promo", { code }),
    paymentMethods: () => post("/payment-methods"),
    policy: () => post("/policy"),
    approvalRequest: () => post("/approval/request"),
    approvalStatus: () => post("/approval/status"),
    pay: (method_id) => post("/pay", { method_id }),
    payConfirm: (human_present, webauthn) => post("/pay/confirm", { human_present, webauthn }),
    // passkeys (WebAuthn / SPC)
    passkeyStatus: () => post("/passkey/status"),
    passkeyRegisterOptions: () => post("/passkey/register-options"),
    passkeyRegister: (response, challenge) => post("/passkey/register", { response, challenge }),
    passkeyRemove: () => post("/passkey/remove"),
    track: () => post("/track"),
    // post-purchase agency + immutable audit trail
    deliveryCheck: () => post("/delivery/check"),
    deliveryRemediate: () => post("/delivery/remediate"),
    auditVerify: () => post("/audit/verify"),
    auditBundle: () => post("/audit/bundle"),
    orders: (merchant_id) => post("/orders", { merchant_id }),
    refund: (amount) => post("/refund", { amount }),
    dispute: (reason) => post("/dispute", { reason }),
    // scenario runner + LLM agent
    scenarios: async () => (await fetch("/api/scenarios")).json(),
    runScenario: (id) => post("/scenario", { id }),
    agent: (goal) => post("/agent", { goal }),
    chat: (text) => post("/chat", { text }), // interactive LLM chat turn
    // fresh session (resets trace) for a new scenario
    async reset(onTrace) {
      const s = await post("/session");
      sessionId = s.session_id;
      const es = new EventSource("/api/trace/" + sessionId);
      es.onmessage = (e) => { try { onTrace(JSON.parse(e.data)); } catch {} };
      return s;
    },
  };
})();
