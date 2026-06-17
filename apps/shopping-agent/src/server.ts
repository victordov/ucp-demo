/**
 * Shopping Agent ("Shoppy") — the UCP Platform.
 * Serves the chat UI, exposes the orchestration API, publishes its platform
 * profile ({ucp: {...}, signing_keys}) and receives signed order webhooks at
 * the URL declared in the order capability config.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawBodySaver, profileFetcher, mcpHandler, callTool, BusinessError } from "../../../packages/common/src/jsonrpc.ts";
import { verifyRequest } from "../../../packages/common/src/httpsig.ts";
import { PORTS, URLS, AGENT_PROFILE_URL, merchantMcpUrl, defaultTrust } from "../../../packages/common/src/config.ts";
import { UCP_VERSION, SPEC, SCHEMA } from "../../../packages/common/src/types.ts";
import {
  agentKey,
  MERCHANT_IDS,
  createSession,
  getSession,
  runIntent,
  setModality,
  runAutonomous,
  prepareAutonomy,
  authorizeAndRun,
  select,
  addAccessory,
  createCheckout,
  updateCheckout,
  checkoutView,
  preparePayment,
  confirmAndPay,
  resolveThreeDs,
  track,
  onWebhook,
  DEFAULT_ADDRESS,
  selectShipping,
  applyPromo,
  listPaymentMethods,
  refundOrder,
  fileDispute,
  listOrders,
  runScenario,
  snapshot,
  passkeyStatus,
  passkeyRegisterOptions,
  passkeyRegister,
  verifyAuditChain,
  evidenceBundle,
  getAgentPolicy,
  requestApproval,
  approvalStatus,
  checkDelivery,
  remediateLateDelivery,
  SCENARIOS,
} from "./orchestrator.ts";
import { llmEnabled } from "./nlu.ts";
import { runAgentLoop, chatTurn, llmAgentEnabled } from "./agent-loop.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ verify: rawBodySaver }));

/* ---- Permissions-Policy: delegate payment + WebAuthn ONLY to the wallet ----
 * Google-Pay-style sandboxed-iframe pattern: the effective permission for the
 * embedded wallet sheet is the INTERSECTION of this header and the iframe's
 * `allow` attribute — a compromised third-party script on this page cannot
 * invoke PaymentRequest/WebAuthn, and no other origin can be delegated to. */
const WALLET_ORIGIN = new URL(URLS.credentialsProvider).origin;
app.use((_req, res, next) => {
  res.set(
    "Permissions-Policy",
    `payment=(self "${WALLET_ORIGIN}"), publickey-credentials-get=(self "${WALLET_ORIGIN}"), publickey-credentials-create=(self "${WALLET_ORIGIN}")`
  );
  next();
});

app.use(express.static(path.join(__dirname, "../public")));

/* ---------------- UCP platform profile ---------------- */

app.get("/.well-known/ucp", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300"); // spec: public, max-age >= 60
  res.json({
    name: "Shoppy — Shopping Agent",
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [
          {
            version: UCP_VERSION,
            spec: SPEC("overview"),
            transport: "mcp",
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
            endpoint: `${URLS.shoppingAgent}/mcp`,
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [
          { version: UCP_VERSION, spec: SPEC("checkout"), schema: SCHEMA("shopping/checkout.json") },
        ],
        "dev.ucp.shopping.catalog.search": [
          { version: UCP_VERSION, spec: SPEC("catalog/search"), schema: SCHEMA("shopping/catalog_search.json") },
        ],
        "dev.ucp.shopping.order": [
          {
            version: UCP_VERSION,
            spec: SPEC("order"),
            schema: SCHEMA("shopping/order.json"),
            // Platform order capability config: where businesses push webhooks
            config: { webhook_url: `${URLS.shoppingAgent}/webhooks/ucp` },
          },
        ],
        "dev.ucp.shopping.fulfillment": [
          { version: UCP_VERSION, spec: SPEC("fulfillment"), schema: SCHEMA("shopping/fulfillment.json"), extends: "dev.ucp.shopping.checkout" },
        ],
        "dev.ucp.shopping.ap2_mandate": [
          { version: UCP_VERSION, spec: SPEC("ap2-mandates"), schema: SCHEMA("shopping/ap2_mandate.json"), extends: "dev.ucp.shopping.checkout" },
        ],
      },
      payment_handlers: {
        "com.google.pay": [
          {
            id: "gpay_platform",
            version: UCP_VERSION,
            spec: "https://developers.google.com/merchant/ucp/guides/gpay-payment-handler",
            schema: "https://pay.google.com/gp/p/ucp/2026-01-11/schemas/gpay_config.json",
            available_instruments: [{ type: "card", constraints: { brands: ["visa", "mastercard"] } }],
          },
        ],
      },
    },
    signing_keys: [agentKey.publicJwk],
  });
});

/* ---------------- platform MCP endpoint (dev.ucp.shopping) ----------------
 * The platform profile declares the dev.ucp.shopping service over MCP; this
 * endpoint serves it by routing tool calls to the business MCP endpoints
 * (businesses may override the platform endpoint in their own profiles).
 * Same JSON-RPC 2.0 + RFC 9421 PKI binding as the other first-party services.
 */

const platformIdentity = { key: agentKey, profileUrl: AGENT_PROFILE_URL };

async function routeToMerchant(merchantId: string, tool: string, toolArgs: Record<string, unknown>) {
  if (!MERCHANT_IDS.includes(merchantId)) {
    throw new BusinessError([
      { type: "error", code: "not_found", content: `Unknown business: ${merchantId}. Known: ${MERCHANT_IDS.join(", ")}`, severity: "unrecoverable" },
    ]);
  }
  return callTool(merchantMcpUrl(merchantId), tool, toolArgs, platformIdentity);
}

/** Strip MCP meta before re-issuing the call (callTool injects fresh platform meta). */
const cleanArgs = ({ meta: _meta, merchant_id: _mid, ...rest }: any = {}) => rest;

const platformTools = {
  search_catalog: {
    description:
      "Search product catalogs across all businesses on the platform. Pass merchant_id to search a single business; omit it to fan out and aggregate.",
    inputSchema: { $ref: SCHEMA("shopping/catalog_search.json") + "#/$defs/search_request" },
    outputSchema: { $ref: SCHEMA("shopping/catalog_search.json") + "#/$defs/search_response" },
    handler: async (args: any) => {
      if (args?.merchant_id) return routeToMerchant(args.merchant_id, "search_catalog", cleanArgs(args));
      const products: any[] = [];
      await Promise.all(
        MERCHANT_IDS.map(async (mid) => {
          try {
            const r: any = await routeToMerchant(mid, "search_catalog", cleanArgs(args));
            products.push(...(r?.products ?? []));
          } catch {
            /* business unreachable — skip it, aggregation is best-effort */
          }
        })
      );
      return {
        ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }] } },
        products,
      };
    },
  },
  get_product: {
    description: "Get a product from a business catalog (requires merchant_id and product id).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, merchant_id: { type: "string" } },
      required: ["id", "merchant_id"],
    },
    handler: async (args: any) => routeToMerchant(args?.merchant_id, "get_product", cleanArgs(args)),
  },
  get_checkout: {
    description: "Get a checkout session from the business that owns it (requires merchant_id and checkout id).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, merchant_id: { type: "string" } },
      required: ["id", "merchant_id"],
    },
    outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
    handler: async (args: any) => routeToMerchant(args?.merchant_id, "get_checkout", cleanArgs(args)),
  },
  get_order: {
    description: "Get an order from the business that owns it (requires merchant_id and order id).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, merchant_id: { type: "string" } },
      required: ["id", "merchant_id"],
    },
    outputSchema: { $ref: SCHEMA("shopping/order.json") },
    handler: async (args: any) => routeToMerchant(args?.merchant_id, "get_order", cleanArgs(args)),
  },
};

app.post(
  "/mcp",
  mcpHandler({ serverName: "shopping-agent", tools: platformTools as any, trustedProfiles: defaultTrust })
);

/* ---------------- signed webhook receiver (Order capability) ---------------- */

app.post("/webhooks/ucp", async (req, res) => {
  const ver = await verifyRequest(
    {
      method: req.method,
      host: (req.headers["x-original-host"] as string) ?? req.headers.host ?? "",
      path: (req.headers["x-original-path"] as string) ?? req.path,
      headers: req.headers as Record<string, string | undefined>,
      rawBody: (req as any).rawBody ?? JSON.stringify(req.body),
    },
    profileFetcher
  );
  if (!ver.ok) {
    console.log(`[agent] webhook REJECTED (${ver.error})`);
    return res.status(401).json({ error: ver.error });
  }
  console.log(`[agent] order webhook from ${ver.profileUrl} (signature OK)`);
  onWebhook(req.body);
  res.json({ ok: true });
});

/* ---------------- UI API ---------------- */

const api = express.Router();

api.post("/session", (_req, res) => {
  const s = createSession();
  res.json({ session_id: s.id, user: { name: "Alex Morgan" }, address: DEFAULT_ADDRESS, llm: llmEnabled(), urls: URLS });
});

// Friendlier failures: map protocol error codes to user-facing hints.
const HINTS: Record<string, string> = {
  policy_per_tx_cap_exceeded: `Raise the per-transaction cap in Walletly → Agent permissions (${URLS.credentialsProvider}).`,
  policy_budget_exceeded: `Raise the budget or reset spent in Walletly → Agent permissions (${URLS.credentialsProvider}).`,
  policy_merchant_not_allowed: `Add this merchant to the allowlist in Walletly → Agent permissions (${URLS.credentialsProvider}).`,
  policy_autonomy_violation: `Change the autonomy level in Walletly → Agent permissions (${URLS.credentialsProvider}).`,
  policy_window_expired: `Extend the validity window in Walletly → Agent permissions (${URLS.credentialsProvider}).`,
  approval_pending: `Open Walletly → Approval inbox (${URLS.credentialsProvider}) and approve the purchase, then retry.`,
  agent_untrusted: `The agent is suspended or low-reputation in the PayStream registry (${URLS.paymentProvider}).`,
  velocity_exceeded: `The PSP rate-limited this agent — wait a minute or raise the limit (${URLS.paymentProvider}).`,
  token_revoked: "The user revoked this payment token in Walletly — start the payment again.",
  payment_declined: "The issuer declined. Try a different payment method.",
  user_verification_required: `A passkey (Touch ID) is enrolled, so every payment needs your fingerprint — automated demos can't provide it. Remove the passkey in Walletly (${URLS.credentialsProvider}) to use the simulated approval, or pay interactively in the chat.`,
  user_verification_failed: `Your Touch ID assertion could not be verified — try again, or remove and re-enrol the passkey in Walletly (${URLS.credentialsProvider}).`,
};

function handle(fn: (req: express.Request) => Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    try {
      res.json(await fn(req));
    } catch (e: any) {
      const code = (typeof e.code === "string" ? e.code : undefined) ?? e.data?.code;
      console.error(`[agent] API error:`, e.message);
      res.status(500).json({ error: e.message, code, hint: code ? HINTS[code] : undefined, data: e.data });
    }
  };
}

api.post("/intent", handle(async (req) => runIntent(getSession(req.body.session_id), String(req.body.text ?? ""), { humanPresent: req.body.human_present })));
// Toggle the session modality (human-present ↔ human-not-present). For autonomous
// purchases call this (or pass human_present:false to /intent) BEFORE shopping so
// the user-signed open mandates are minted up front.
api.post("/mode", handle(async (req) => setModality(getSession(req.body.session_id), req.body.human_present !== false)));
// End-to-end human-not-present purchase (deterministic, no LLM): the user
// authorizes once, then the agent completes the whole task autonomously.
api.post("/autonomous", handle(async (req) => {
  const s = getSession(req.body.session_id);
  const r = await runAutonomous(s, String(req.body.text ?? ""));
  return { ...r, snapshot: snapshot(s) };
}));
// Interactive human-not-present, step 1: parse the request + return the
// merchants and payment methods the user must choose to authorize autonomy.
api.post("/autonomy/prepare", handle(async (req) => prepareAutonomy(getSession(req.body.session_id), String(req.body.text ?? ""))));
// Interactive human-not-present, step 2: authorize with the chosen merchant
// allowlist + payment method, then run the purchase autonomously.
api.post("/autonomy/authorize", handle(async (req) => {
  const s = getSession(req.body.session_id);
  const r = await authorizeAndRun(s, { merchantIds: req.body.merchant_ids, methodId: req.body.method_id });
  return { ...r, snapshot: snapshot(s) };
}));
api.post("/select", handle(async (req) => select(getSession(req.body.session_id), req.body.product_id, req.body.merchant_id)));
api.post("/accessory", handle(async (req) => addAccessory(getSession(req.body.session_id))));
api.post("/checkout", handle(async (req) => createCheckout(getSession(req.body.session_id))));
api.post("/qty", handle(async (req) => updateCheckout(getSession(req.body.session_id), { qty: { item_id: req.body.item_id, delta: Number(req.body.delta) } })));
api.post("/address", handle(async (req) => updateCheckout(getSession(req.body.session_id), { address: req.body.address })));
api.post("/shipping", handle(async (req) => selectShipping(getSession(req.body.session_id), req.body.option_id)));
api.post("/promo", handle(async (req) => applyPromo(getSession(req.body.session_id), String(req.body.code ?? ""))));
api.post("/payment-methods", handle(async (req) => ({ payment_methods: await listPaymentMethods(getSession(req.body.session_id)) })));
api.post("/checkout/view", handle(async (req) => checkoutView(getSession(req.body.session_id))));
api.post("/pay", handle(async (req) => preparePayment(getSession(req.body.session_id), req.body.method_id, req.body.wallet_host)));
api.post("/pay/confirm", handle(async (req) => confirmAndPay(getSession(req.body.session_id), { humanPresent: req.body.human_present, webauthn: req.body.webauthn, interactive3ds: true })));
// Resume an interactive 3-D Secure step-up after the user approves/cancels the bank page.
api.post("/pay/3ds", handle(async (req) => resolveThreeDs(getSession(req.body.session_id), { outcome: req.body.outcome })));

// Passkeys (WebAuthn / SPC) — enrollment + status, relayed to the CP. wallet_host
// is the host the browser loaded the sheet from (the passkey RP ID); it scopes
// status/options so localhost and a tunnel host each resolve correctly.
api.post("/passkey/status", handle(async (req) => passkeyStatus(getSession(req.body.session_id), req.body.wallet_host)));
api.post("/passkey/register-options", handle(async (req) => passkeyRegisterOptions(getSession(req.body.session_id), req.body.wallet_host)));
api.post("/passkey/register", handle(async (req) => passkeyRegister(getSession(req.body.session_id), req.body.response, req.body.challenge, req.body.wallet_host)));
// Relay so the UI can remove the enrolled passkey (e.g. to unblock automated demos).
api.post("/passkey/remove", handle(async () => {
  const r = await fetch(`${URLS.credentialsProvider}/api/wallet/passkey/remove`, { method: "POST" });
  if (!r.ok) throw new Error(`Credentials Provider refused passkey removal (HTTP ${r.status})`);
  return { removed: true };
}));

// Spend-control policy (read-only; edited in Walletly) — lets the UI preview the rail.
api.post("/policy", handle(async () => ({ policy: await getAgentPolicy() })));

// Approval workflow (human-in-the-loop).
api.post("/approval/request", handle(async (req) => requestApproval(getSession(req.body.session_id))));
api.post("/approval/status", handle(async (req) => approvalStatus(getSession(req.body.session_id))));

// Immutable audit trail — verify the hash chain / export the evidence bundle.
api.post("/audit/verify", handle(async (req) => verifyAuditChain(getSession(req.body.session_id))));
api.post("/audit/bundle", handle(async (req) => evidenceBundle(getSession(req.body.session_id))));

// Post-purchase agency — delivery monitoring + proactive remediation.
api.post("/delivery/check", handle(async (req) => checkDelivery(getSession(req.body.session_id))));
api.post("/delivery/remediate", handle(async (req) => remediateLateDelivery(getSession(req.body.session_id))));
api.post("/track", handle(async (req) => track(getSession(req.body.session_id))));
api.post("/refund", handle(async (req) => refundOrder(getSession(req.body.session_id), { amount: req.body.amount })));
api.post("/dispute", handle(async (req) => fileDispute(getSession(req.body.session_id), req.body.reason)));
api.post("/orders", handle(async (req) => listOrders(getSession(req.body.session_id), req.body.merchant_id ?? getSession(req.body.session_id).checkout?.merchant_id ?? "wavelength")));

// Scenario runner — success & failure flows for the demo.
api.get("/scenarios", (_req, res) => res.json({ scenarios: SCENARIOS, llm_agent: llmAgentEnabled() }));
api.post("/scenario", handle(async (req) => runScenario(getSession(req.body.session_id), String(req.body.id))));

// Full LLM agentic loop (#17): the LLM drives the tool calls end to end. When
// human_present:false (or the goal implies autonomy) it runs the human-not-present
// flow — the LLM signs the closed mandates under user-signed open mandates.
api.post("/agent", handle(async (req) => {
  const s = getSession(req.body.session_id);
  const r = await runAgentLoop(s, String(req.body.goal ?? ""), { humanPresent: req.body.human_present });
  return { ...r, snapshot: snapshot(s) };
}));

// Interactive LLM chat: one conversational turn, human stays in the loop.
api.post("/chat", handle(async (req) => {
  const s = getSession(req.body.session_id);
  const r = await chatTurn(s, String(req.body.text ?? ""));
  return { ...r, snapshot: snapshot(s) };
}));

// Raw protocol artifacts for the compliance validator (scripts/validate-compliance.ts)
api.get("/debug/:sessionId", (req, res) => {
  try {
    const s = getSession(req.params.sessionId);
    res.json({ checkout: s.checkout ?? null, catalog: s.rawCatalog ?? null, order: s.shipped ?? null });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

app.use("/api", api);

// OAuth redirect target for Identity Linking (the agent reads the code server-side).
app.get("/oauth/callback", (_req, res) => res.send("Identity linked. You can close this window."));

/* ---------------- SSE protocol trace ---------------- */

app.get("/api/trace/:sessionId", (req, res) => {
  let s;
  try {
    s = getSession(req.params.sessionId);
  } catch {
    return res.status(404).end();
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const ev of s.trace) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const listener = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  s.listeners.add(listener);
  req.on("close", () => s.listeners.delete(listener));
});

app.listen(PORTS.shoppingAgent, () => {
  console.log(`[shopping-agent] ${URLS.shoppingAgent} — UI at ${URLS.shoppingAgent}/  (LLM mode: ${process.env.OPENAI_API_KEY ? "on, OpenAI" : process.env.ANTHROPIC_API_KEY ? "on, Anthropic" : "off, deterministic"})`);
});
