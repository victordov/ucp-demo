/* ============ Shoppy runtime — backend API client (replaces simulated data.js) ============ */

window.SHOPPY = {
  money(n) { return "$" + Number(n).toFixed(2); },
};

window.ShoppyAPI = (() => {
  let sessionId = null;
  // The wallet (Credentials Provider) host the browser actually loads the
  // payment sheet from — i.e. the passkey RP ID. "localhost" locally, the tunnel
  // host behind ngrok/localtunnel. Threaded to the CP so passkey status/options
  // and allowCredentials are scoped to the host the user is really on.
  let walletHost = null;
  function hostFromSession(s) {
    try { return new URL((s && s.urls && s.urls.credentialsProvider) || "").hostname || location.hostname; }
    catch { return location.hostname; }
  }

  async function post(path, body) {
    const res = await fetch("/api" + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, ...(walletHost ? { wallet_host: walletHost } : {}), ...(body || {}) }),
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
      walletHost = hostFromSession(s);
      // live protocol trace via SSE
      const es = new EventSource("/api/trace/" + sessionId);
      es.onmessage = (e) => {
        try { onTrace(JSON.parse(e.data)); } catch {}
      };
      return s;
    },
    intent: (text, human_present) => post("/intent", { text, human_present }),
    mode: (human_present) => post("/mode", { human_present }),
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
    threedsResolve: (outcome) => post("/pay/3ds", { outcome }), // resume after the bank step-up
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
    agent: (goal, human_present) => post("/agent", { goal, human_present }),
    autonomous: (text) => post("/autonomous", { text }), // deterministic end-to-end human-not-present
    autonomyPrepare: (text) => post("/autonomy/prepare", { text }), // interactive HNP: discover merchants + methods
    autonomyAuthorize: (merchant_ids, method_id) => post("/autonomy/authorize", { merchant_ids, method_id }), // authorize + run
    chat: (text) => post("/chat", { text }), // interactive LLM chat turn
    // fresh session (resets trace) for a new scenario
    async reset(onTrace) {
      const s = await post("/session");
      sessionId = s.session_id;
      walletHost = hostFromSession(s);
      const es = new EventSource("/api/trace/" + sessionId);
      es.onmessage = (e) => { try { onTrace(JSON.parse(e.data)); } catch {} };
      return s;
    },
  };
})();
