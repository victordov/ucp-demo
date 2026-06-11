/**
 * Merchant Portal — hosts four UCP businesses (multi-tenant) plus the
 * integrated Merchant Agent serving the UCP MCP binding over JSON-RPC 2.0.
 *
 * Per merchant tenant:
 *   GET  /m/:mid/.well-known/ucp  — business profile per the UCP spec:
 *                                   { ucp: {version, services, capabilities,
 *                                     payment_handlers}, signing_keys }
 *   POST /m/:mid/mcp              — MCP endpoint: tools/call with
 *                                   create/get/update/complete/cancel_checkout
 *                                   + search_catalog (catalog capability)
 *
 * AP2 (dev.ucp.shopping.ap2_mandate): every checkout response embeds
 * `ap2.merchant_authorization` (detached JWS over JCS(checkout − ap2));
 * `complete_checkout` requires and fully verifies `ap2.checkout_mandate`,
 * then charges via the Payment Provider and creates the order.
 * Amounts are minor units (cents) throughout, per the spec.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKey, randomId, jwkToPublicKey, jwsVerifyCompact, type SigningKey } from "../../../packages/common/src/crypto.ts";
import {
  mcpHandler,
  callTool,
  rawBodySaver,
  fetchUcpProfile,
  findJwk,
  RpcError,
  BusinessError,
  UCP_ERR,
} from "../../../packages/common/src/jsonrpc.ts";
import { signRequest, signResponse } from "../../../packages/common/src/httpsig.ts";
import {
  signMerchantAuthorization,
  verifyMerchantAuthorization,
  verifyCheckoutMandate,
} from "../../../packages/common/src/ap2.ts";
import {
  PORTS,
  URLS,
  defaultTrust,
  merchantProfileUrl,
  CREDENTIALS_PROFILE_URL,
  PAYMENTS_PROFILE_URL,
} from "../../../packages/common/src/config.ts";
import {
  UCP_VERSION,
  SPEC,
  SCHEMA,
  type Checkout,
  type LineItem,
  type CompositeToken,
  type Total,
  type PostalAddress,
  type OrderObject,
  type UcpEnvelope,
} from "../../../packages/common/src/types.ts";
import { MERCHANTS, type MerchantSeed } from "./data.ts";
import { restConformanceRouter } from "./rest-conformance.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- tenant state ---------------- */

interface OrderRecord {
  order: OrderObject;
  status: "confirmed" | "shipped" | "delivered" | "refunded" | "partially_refunded" | "disputed";
  buyer?: { email?: string; first_name?: string; last_name?: string };
  payment: { status: string; handler: string; rail?: string; last4?: string; psp_transaction_id?: string };
  estimated_delivery: string;
  evidence: {
    checkout_mandate: string;
    merchant_authorization: string;
    cart_mandate_id: string;
    payment_mandate_id?: string;
    verification: Record<string, string>;
  };
  platform_profile: string;
  created_at: string;
}

interface Cart {
  ucp: UcpEnvelope;
  id: string;
  status: "active" | "canceled";
  currency: string;
  line_items: LineItem[];
  buyer?: { email?: string };
  totals: Total[];
  links: { type: string; url: string }[];
  expires_at?: string;
}

interface Tenant {
  seed: MerchantSeed;
  key: SigningKey;
  checkouts: Map<string, Checkout>;
  carts: Map<string, Cart>;
  orders: Map<string, OrderRecord>;
  stats: { declines: number };
}

/* Identity Linking (OAuth 2.0) — authorization codes + access tokens. */
interface OAuthCode { code: string; client_id: string; scope: string; redirect_uri: string; user: string; created: number }
interface AccessToken { token: string; scope: string; user: string; client_id: string; expires: number }
const oauthCodes = new Map<string, OAuthCode>();
const accessTokens = new Map<string, AccessToken>();

const tenants = new Map<string, Tenant>();
for (const seed of MERCHANTS) {
  tenants.set(seed.id, {
    seed,
    key: generateSigningKey(`${seed.id}-2026`),
    checkouts: new Map(),
    carts: new Map(),
    orders: new Map(),
    stats: { declines: 0 },
  });
}

/* ---------------- activity log (portal UI) ---------------- */

interface LogEntry { ts: number; merchant_id: string; kind: string; summary: string; detail?: unknown }
const activity: LogEntry[] = [];
function log(merchant_id: string, kind: string, summary: string, detail?: unknown) {
  activity.push({ ts: Date.now(), merchant_id, kind, summary, detail });
  if (activity.length > 500) activity.shift();
  console.log(`[merchant:${merchant_id}] ${kind}: ${summary}`);
}

/* ---------------- compliant ucp envelopes ---------------- */

const GPAY_HANDLER = (mid: string) => ({
  id: `gpay_${mid}`,
  version: UCP_VERSION,
  spec: "https://developers.google.com/merchant/ucp/guides/gpay-payment-handler",
  schema: "https://pay.google.com/gp/p/ucp/2026-01-11/schemas/gpay_config.json",
  available_instruments: [{ type: "card", constraints: { brands: ["visa", "mastercard"] } }],
  config: { environment: "TEST", merchant_info: { merchant_name: "", merchant_id: mid } },
});

// Multi-rail settlement: RTP (instant bank transfer) handler, processed by PayStream.
const RTP_HANDLER = (mid: string) => ({
  id: `rtp_${mid}`,
  version: UCP_VERSION,
  spec: `${URLS.paymentProvider}/.well-known/ucp`,
  schema: "https://ap2-protocol.org/specification#payment-mandate",
  available_instruments: [{ type: "bank_account", constraints: { networks: ["rtp"] } }],
  config: { environment: "TEST", merchant_info: { merchant_name: "", merchant_id: mid }, settlement: "instant" },
});

/** ucp envelope for checkout responses: version + ACTIVE relevant capabilities + payment handlers. */
function checkoutUcpEnvelope(mid: string): UcpEnvelope {
  return {
    version: UCP_VERSION,
    capabilities: {
      "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
      "dev.ucp.shopping.fulfillment": [{ version: UCP_VERSION }],
      "dev.ucp.shopping.ap2_mandate": [{ version: UCP_VERSION }],
    },
    payment_handlers: {
      "com.google.pay": [GPAY_HANDLER(mid)],
      "com.paystream.rtp": [RTP_HANDLER(mid)],
    },
  };
}

/* ---------------- checkout math (minor units; demo pricing rules) ---------------- */

const AGENT_DISCOUNT = 500; // -$5.00
const TAX_RATE = 0.08625;

// Shipping options (dev.ucp.shopping.fulfillment). Express costs more → changes totals.
const SHIPPING_OPTIONS = [
  { id: "standard_2day", title: "Standard 2-day", description: "Arrives in 2 business days", amount: 0, days: 2 },
  { id: "express_next_day", title: "Express next-day", description: "Arrives next business day", amount: 1500, days: 1 },
];

/** Demo discount codes (dev.ucp.shopping.discount). */
const PROMO_CODES: Record<string, { display: string; type: "percent" | "amount"; value: number }> = {
  SHOPPY10: { display: "SHOPPY10 — 10% off", type: "percent", value: 10 },
  SAVE20: { display: "SAVE20 — $20 off", type: "amount", value: 2000 },
};

function selectedShipping(co: Checkout) {
  const optId = co.fulfillment?.methods?.[0]?.groups?.[0]?.selected_option_id ?? "standard_2day";
  return SHIPPING_OPTIONS.find((o) => o.id === optId) ?? SHIPPING_OPTIONS[0];
}

function computeTotals(items: LineItem[], shippingAmount = 0, shipLabel = "2-day", promo?: { display: string; type: "percent" | "amount"; value: number }): Total[] {
  const subtotal = items.reduce((a, i) => a + i.item.price * i.quantity, 0);
  const agentDiscount = items.length ? AGENT_DISCOUNT : 0;
  const promoDiscount = promo ? (promo.type === "percent" ? Math.round((subtotal * promo.value) / 100) : Math.min(promo.value, subtotal)) : 0;
  const discount = agentDiscount + promoDiscount;
  const tax = Math.round((subtotal - discount + shippingAmount) * TAX_RATE);
  const total = subtotal - discount + shippingAmount + tax;
  return [
    { type: "subtotal", amount: subtotal },
    ...(agentDiscount > 0 ? [{ type: "discount", display_text: "Agent discount", amount: -agentDiscount } as Total] : []),
    ...(promoDiscount > 0 ? [{ type: "discount", display_text: promo!.display, amount: -promoDiscount } as Total] : []),
    { type: "fulfillment", display_text: `Shipping · ${shipLabel}`, amount: shippingAmount },
    { type: "tax", display_text: "Tax", amount: tax },
    { type: "total", amount: total },
  ];
}

function lineItemTotals(li: LineItem): Total[] {
  const sub = li.item.price * li.quantity;
  return [
    { type: "subtotal", amount: sub },
    { type: "total", amount: sub },
  ];
}

const totalOf = (co: Checkout) => co.totals.find((t) => t.type === "total")?.amount ?? 0;
const destinationOf = (co: Checkout): PostalAddress | undefined =>
  co.fulfillment?.methods?.[0]?.destinations?.find(
    (d) => d.id === co.fulfillment!.methods[0].selected_destination_id
  ) ?? co.fulfillment?.methods?.[0]?.destinations?.[0];

/** Recompute totals/status/messages and re-sign (AP2 merchant authorization).
 *  `extraMessages` are merged BEFORE signing so the merchant_authorization
 *  covers them (appending after signing would break the signature). */
function refreshCheckout(t: Tenant, co: Checkout, extraMessages: any[] = []): Checkout {
  co.line_items.forEach((li) => (li.totals = lineItemTotals(li)));
  const ship = selectedShipping(co);
  const promo = (co as any)._promo as { display: string; type: "percent" | "amount"; value: number } | undefined;
  co.totals = computeTotals(co.line_items, ship.amount, ship.title.toLowerCase().includes("express") ? "next-day" : "2-day", promo);
  const ready = !!(co.buyer?.email && destinationOf(co));
  if (co.status !== "completed" && co.status !== "canceled") co.status = ready ? "ready_for_complete" : "incomplete";
  co.messages = [
    ...(ready
      ? []
      : [
          ...(!co.buyer?.email
            ? [{ type: "error" as const, code: "missing", content: "buyer.email is required", severity: "recoverable" as const, path: "$.buyer.email" }]
            : []),
          ...(!destinationOf(co)
            ? [{ type: "error" as const, code: "missing", content: "fulfillment destination is required", severity: "recoverable" as const, path: "$.fulfillment.methods[0].destinations" }]
            : []),
        ]),
    ...extraMessages,
  ];
  const signed = signMerchantAuthorization({ ...co, ap2: undefined } as Checkout, t.key);
  t.checkouts.set(co.id, signed);
  return signed;
}

function buildLineItems(seed: MerchantSeed, rows: any[]): LineItem[] {
  return rows.map((r: any, i: number) => {
    const itemId = r.item?.id ?? r.item_id;
    const p = seed.catalog.find((c) => c.id === itemId);
    if (!p)
      throw new BusinessError(
        [{ type: "error", code: "item_unavailable", content: `No item ${itemId} in catalog`, severity: "unrecoverable", path: `$.line_items[${i}]` }],
        `https://${seed.domain}/`
      );
    return {
      id: r.id ?? `li_${i + 1}`,
      item: { id: p.id, title: p.name, brand: p.brand, price: p.price },
      quantity: Math.max(1, Number(r.quantity ?? 1)),
      totals: [],
    };
  });
}

function applyFulfillment(co: Checkout, incoming: any) {
  if (!incoming?.methods?.length) return;
  const m = incoming.methods[0];
  const lineItemIds = co.line_items.map((l) => l.id);
  const dest = m.destinations?.[0];
  const destination: PostalAddress | undefined = dest
    ? { id: dest.id ?? "dest_1", ...dest }
    : destinationOf(co);
  co.fulfillment = {
    methods: [
      {
        id: m.id ?? "shipping_1",
        type: "shipping",
        line_item_ids: lineItemIds,
        destinations: destination ? [destination] : [],
        selected_destination_id: destination?.id,
        groups: [
          {
            id: "package_1",
            line_item_ids: lineItemIds,
            selected_option_id: m.groups?.[0]?.selected_option_id ?? "standard_2day",
            options: SHIPPING_OPTIONS.map((o) => ({
              id: o.id,
              title: o.title,
              description: o.description,
              totals: [{ type: "total", amount: o.amount }],
            })),
          },
        ],
      },
    ],
  };
}

/* ---------------- per-tenant tools (UCP MCP binding) ---------------- */

function tenantTools(t: Tenant) {
  const seed = t.seed;
  const continueUrl = (coId?: string) => `https://${seed.domain}/checkout-sessions/${coId ?? ""}`;

  const getCheckout = (id: string): Checkout => {
    const co = t.checkouts.get(id);
    if (!co)
      throw new BusinessError([{ type: "error", code: "not_found", content: `No checkout ${id}`, severity: "unrecoverable" }], `https://${seed.domain}/`);
    return co;
  };

  return {
    /* ---- catalog capability (dev.ucp.shopping.catalog.search) ---- */
    search_catalog: {
      description: `Search ${seed.name}'s product catalog with constraint filters.`,
      inputSchema: { $ref: SCHEMA("shopping/catalog_search.json") + "#/$defs/search_request" },
      outputSchema: { $ref: SCHEMA("shopping/catalog_search.json") + "#/$defs/search_response" },
      handler: async (args: any, ctx: any) => {
        const q: string = (args?.query ?? "").toLowerCase();
        const f = args?.filters ?? {};
        // Official filter: filters.price.max (minor units). Extension filters
        // (reverse-domain semantics allowed via additionalProperties:true).
        const priceMax = f.price?.max ?? f.price_max;
        const terms = q.split(/[^a-z0-9-]+/).filter(Boolean);
        const matches = seed.catalog.filter((p) => {
          if (priceMax != null && p.price > priceMax) return false;
          if (f.ship_within_days != null && p.ship_days > f.ship_within_days) return false;
          if (f.in_stock !== false && !p.in_stock) return false;
          if (Array.isArray(f.attributes) && f.attributes.length) {
            if (!f.attributes.every((a: string) => p.attributes?.includes(a))) return false;
          }
          if (terms.length) {
            const hay = `${p.name} ${p.brand} ${(p.attributes ?? []).join(" ")} ${p.note ?? ""}`.toLowerCase();
            if (!terms.some((term) => hay.includes(term))) return false;
          }
          return true;
        });
        // product.json shape (id, title, description, price_range, variants + tags, metadata)
        const products = matches.map((p) => productWire(seed, p));
        log(seed.id, "search_catalog", `"${args?.query}" → ${products.length} result(s)`, { filters: f });
        return {
          ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }] } },
          products,
          // additional property (multi-tenant demo metadata for the platform UI)
          merchant: { id: seed.id, name: seed.name, domain: seed.domain, rating: seed.rating, color: seed.color, short: seed.short },
        };
      },
    },

    /* ---- checkout capability ---- */
    create_checkout: {
      description: "Create a checkout session.",
      inputSchema: { type: "object", properties: { checkout: { $ref: SCHEMA("shopping/checkout.json") } }, required: ["checkout"] },
      outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
      handler: async (args: any, ctx: any) => {
        const input = args?.checkout ?? {};
        const items = buildLineItems(seed, input.line_items ?? []);
        const co: Checkout = {
          ucp: checkoutUcpEnvelope(seed.id),
          id: randomId("checkout"),
          status: "incomplete",
          currency: "USD",
          merchant_id: seed.id,
          line_items: items,
          buyer: input.buyer,
          totals: [],
          links: [
            { type: "privacy_policy", url: `https://${seed.domain}/privacy` },
            { type: "terms_of_service", url: `https://${seed.domain}/tos` },
          ],
          expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        };
        co.continue_url = continueUrl(co.id);
        applyFulfillment(co, input.fulfillment);
        const signed = refreshCheckout(t, co);
        log(seed.id, "create_checkout", `${co.id} (${items.length} line items) for ${ctx.signerProfileUrl}`, { status: signed.status });
        return { checkout: signed };
      },
    },

    get_checkout: {
      description: "Get a checkout session.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
      handler: async (args: any) => ({ checkout: getCheckout(args?.id) }),
    },

    update_checkout: {
      description: "Update a checkout session (line items, buyer, fulfillment).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, checkout: { $ref: SCHEMA("shopping/checkout.json") } },
        required: ["id", "checkout"],
      },
      outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
      handler: async (args: any) => {
        const co = getCheckout(args?.id);
        if (co.status === "completed")
          throw new BusinessError([{ type: "error", code: "invalid_state", content: "Checkout already completed", severity: "unrecoverable" }], continueUrl(co.id));
        const input = args?.checkout ?? {};
        if (input.buyer) co.buyer = { ...co.buyer, ...input.buyer };
        if (Array.isArray(input.line_items)) {
          for (const upd of input.line_items) {
            const li = co.line_items.find((l) => l.id === upd.id || l.item.id === upd.item?.id);
            if (li && upd.quantity != null) li.quantity = Math.max(1, Number(upd.quantity));
          }
        }
        applyFulfillment(co, input.fulfillment);
        // Discount extension: apply/clear a promo code.
        let invalidCode: string | null = null;
        if (input.discounts?.code !== undefined) {
          const code = String(input.discounts.code).toUpperCase();
          if (code === "") delete (co as any)._promo;
          else if (PROMO_CODES[code]) (co as any)._promo = PROMO_CODES[code];
          else invalidCode = code;
        }
        const extra = invalidCode
          ? [{ type: "warning", code: "invalid_discount_code", content: `Unknown code ${invalidCode}`, severity: "recoverable", path: "$.discounts.code" }]
          : [];
        const signed = refreshCheckout(t, co, extra);
        log(seed.id, "update_checkout", `${co.id} → ${signed.status}`);
        return { checkout: signed };
      },
    },

    cancel_checkout: {
      description: "Cancel a checkout session.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
      requiresIdempotencyKey: true,
      handler: async (args: any) => {
        const co = getCheckout(args?.id);
        co.status = "canceled";
        const signed = refreshCheckout(t, co);
        signed.status = "canceled";
        log(seed.id, "cancel_checkout", co.id);
        return { checkout: signed };
      },
    },

    complete_checkout: {
      description: "Place the order. Requires AP2 checkout mandate (security-locked session).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, checkout: { $ref: SCHEMA("shopping/checkout.json") } },
        required: ["id", "checkout"],
      },
      outputSchema: { $ref: SCHEMA("shopping/checkout.json") },
      requiresIdempotencyKey: true,
      handler: async (args: any, ctx: any) => {
        const co = getCheckout(args?.id);
        const input = args?.checkout ?? {};
        // Allow completion from ready_for_complete OR from a 3DS escalation retry.
        if (co.status !== "ready_for_complete" && co.status !== "requires_escalation")
          throw new BusinessError([{ type: "error", code: "invalid_state", content: `Checkout is ${co.status}`, severity: "unrecoverable" }], continueUrl(co.id));

        const verification: Record<string, string> = {};

        // --- Know Your Agent: check the calling agent's registration /
        //     reputation in the network registry before taking its money. ---
        try {
          const kya: any = await callTool(
            `${URLS.paymentProvider}/mcp`,
            "lookup_agent",
            { profile_url: ctx.signerProfileUrl },
            { key: t.key, profileUrl: merchantProfileUrl(seed.id) }
          );
          if (kya.registered && kya.status === "suspended")
            throw new RpcError(-32000, "Agent suspended in registry", UCP_ERR("agent_untrusted", `${ctx.signerProfileUrl} is suspended (KYA registry)`), 403);
          if (kya.registered && kya.reputation < 40)
            throw new RpcError(-32000, "Agent reputation too low", UCP_ERR("agent_untrusted", `reputation ${kya.reputation} < 40`), 403);
          verification.kya = kya.registered
            ? `registered (${kya.kya_level}) · status ${kya.status} · reputation ${kya.reputation}/100`
            : "unregistered (demo allows; production would decline)";
        } catch (e: any) {
          if (e instanceof RpcError) throw e;
          verification.kya = `registry unreachable (${e.message}) — continued`;
        }

        // --- AP2 enforcement: session is security-locked ---
        const mandateJws: string | undefined = input?.ap2?.checkout_mandate ?? args?.ap2?.checkout_mandate;
        if (!mandateJws)
          throw new RpcError(-32000, "AP2 mandate required", UCP_ERR("mandate_required", "ap2.checkout_mandate missing"), 401);

        // 1. Verify the SD-JWT+kb checkout mandate: issuer = CP service key, key-bound
        //    to the user device key, audience = THIS merchant, nonce = checkout id.
        const cpProfile = await fetchUcpProfile(CREDENTIALS_PROFILE_URL);
        let claims;
        try {
          claims = verifyCheckoutMandate(
            mandateJws,
            (kid) => {
              const jwk = findJwk(cpProfile, kid);
              return jwk ? jwkToPublicKey(jwk) : undefined;
            },
            { aud: merchantProfileUrl(seed.id), nonce: co.id }
          );
        } catch (e: any) {
          const code = /mandate_expired/.test(e.message)
            ? "mandate_expired"
            : /unknown issuer kid|unknown kid/.test(e.message)
              ? "agent_missing_key"
              : /aud mismatch|nonce mismatch|sd_hash/.test(e.message)
                ? "mandate_scope_mismatch"
                : "mandate_invalid_signature";
          throw new RpcError(-32000, "Mandate verification failed", UCP_ERR(code, e.message), 401);
        }
        verification.checkout_mandate = `valid SD-JWT+kb (issuer ${claims.iss}, key-bound to user device, aud=this merchant)`;

        // 2. Verify our own merchant_authorization inside the embedded checkout (nested binding)
        const embedded = claims.checkout;
        const own = verifyMerchantAuthorization(embedded, [t.key.publicJwk]);
        if (!own.ok)
          throw new RpcError(-32000, "Merchant authorization invalid", UCP_ERR("merchant_authorization_invalid", own.error ?? ""), 401);
        verification.merchant_authorization = `valid (kid=${own.kid})`;

        // 3. Terms must match the live session (id + total)
        const liveTotal = totalOf(co);
        const mandateTotal = embedded.totals?.find((x: any) => x.type === "total")?.amount;
        if (embedded.id !== co.id || liveTotal !== mandateTotal)
          throw new RpcError(-32000, "Mandate scope mismatch", UCP_ERR("mandate_scope_mismatch", `mandate bound to ${embedded.id}/${mandateTotal}, session is ${co.id}/${liveTotal}`), 401);
        verification.terms_match = `checkout ${co.id} · total ${liveTotal} (minor units)`;

        // --- Verified intent across parties: validate the purchase against the
        //     user's ORIGINAL signed IntentMandate (budget + validity), then
        //     forward it so the PSP can re-validate independently. ---
        const intentJws: string | undefined = input?.ap2?.intent_mandate ?? args?.ap2?.intent_mandate;
        if (intentJws) {
          try {
            const { payload: im } = jwsVerifyCompact(intentJws, (kid: string) => {
              const jwk = findJwk(cpProfile, kid);
              return jwk ? jwkToPublicKey(jwk) : undefined;
            });
            const intent = im as any;
            if (new Date(intent.expires_at).getTime() < Date.now()) throw new Error(`expired ${intent.expires_at}`);
            const maxTotal = intent.constraints?.max_total?.amount;
            if (maxTotal != null && liveTotal > maxTotal) throw new Error(`total ${liveTotal} exceeds the user's signed budget ${maxTotal}`);
            verification.intent_mandate = `valid (id=${intent.id}) · total within signed budget${maxTotal != null ? ` (≤ ${maxTotal})` : ""}`;
          } catch (e: any) {
            throw new RpcError(-32000, "Intent mandate validation failed", UCP_ERR("intent_mandate_invalid", e.message), 401);
          }
        } else {
          verification.intent_mandate = "not presented (optional)";
        }
        log(seed.id, "ap2.verify", `checkout_mandate verified for ${co.id}`, verification);

        // --- Payment: forward the composite token (network token + payment mandate) to the PSP ---
        const instrument = input?.payment?.instruments?.find((i: any) => i.selected) ?? input?.payment?.instruments?.[0];
        if (!instrument)
          throw new BusinessError([{ type: "error", code: "payment_required", content: "payment.instruments is empty", severity: "unrecoverable" }], continueUrl(co.id));
        // Security best practice: validate handler_id against the advertised set
        const advertisedHandlerIds = Object.values(co.ucp.payment_handlers ?? {}).flat().map((h) => h.id);
        if (!advertisedHandlerIds.includes(instrument.handler_id))
          throw new BusinessError([{ type: "error", code: "invalid_handler", content: `handler_id ${instrument.handler_id} was not advertised for this checkout`, severity: "unrecoverable" }], continueUrl(co.id));
        const composite = instrument.credential?.token as CompositeToken;

        co.status = "complete_in_progress";
        const identity = { key: t.key, profileUrl: merchantProfileUrl(seed.id) };
        const psp = `${URLS.paymentProvider}/mcp`;
        let auth: any;
        try {
          auth = await callTool(psp, "authorize_payment", {
            payment: {
              merchant_id: seed.id,
              merchant_profile: merchantProfileUrl(seed.id),
              checkout_id: co.id,
              amount: { amount: liveTotal, currency: co.currency },
              credential: composite,
              // Verified intent across parties: the PSP re-validates the user's
              // original signed intent independently of this merchant.
              intent_mandate: intentJws,
              challenge_attestation: input?.ap2?.challenge_attestation ?? args?.challenge_attestation,
            },
            signals: input.signals,
          }, identity);
        } catch (e: any) {
          co.status = "ready_for_complete";
          refreshCheckout(t, co);
          t.stats.declines += 1;
          // Hard decline → business outcome with the buyer able to retry on the web.
          throw new BusinessError(
            [{ type: "error", code: "payment_declined", content: `Issuer declined: ${e.data?.content ?? e.message}`, severity: "unrecoverable" }],
            continueUrl(co.id)
          );
        }

        // --- 3DS / Strong Customer Authentication: pause and escalate to the user ---
        if (auth.status === "requires_challenge") {
          co.status = "requires_escalation";
          co.continue_url = auth.challenge.continue_url;
          co.messages = [{ type: "error", code: "requires_3ds", content: "Your bank requires verification (3-D Secure).", severity: "requires_buyer_input", path: "$.payment" }];
          t.checkouts.set(co.id, co);
          log(seed.id, "checkout.escalate", `${co.id} requires 3DS (${auth.challenge.challenge_id})`);
          return { checkout: { ...co, payment: undefined } };
        }
        verification.psp_authorization = `${auth.transaction_id} (${auth.status})`;
        if (auth.verification?.sca) verification.sca = auth.verification.sca;
        const capture = await callTool(psp, "capture_payment", { transaction_id: auth.transaction_id }, identity);
        verification.psp_capture = capture.status;
        log(seed.id, "payments", `authorized+captured ${auth.transaction_id} (${liveTotal} minor units)`);

        // --- Order creation (Order capability object, kept for webhooks/portal) ---
        const orderId = randomId("ord", 12);
        const eta = new Date(Date.now() + 2 * 864e5).toISOString();
        const dest = destinationOf(co)!;
        const orderObj: OrderObject = {
          ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.order": [{ version: UCP_VERSION }] } },
          id: orderId,
          label: `${seed.name} order ${orderId.slice(-6).toUpperCase()}`,
          checkout_id: co.id,
          permalink_url: `https://${seed.domain}/orders/${orderId}`,
          // order_line_item.json: quantity is an object, totals + status required
          line_items: co.line_items.map((l) => ({
            id: l.id,
            item: { id: l.item.id, title: l.item.title, price: l.item.price },
            quantity: { original: l.quantity, total: l.quantity, fulfilled: 0 },
            totals: l.totals,
            status: "processing" as const,
          })),
          fulfillment: {
            // expectation.json: line_items[{id,quantity}], method_type, destination (postal_address)
            expectations: [
              {
                id: "exp_1",
                line_items: co.line_items.map((l) => ({ id: l.id, quantity: l.quantity })),
                method_type: "shipping" as const,
                destination: {
                  first_name: dest.first_name,
                  last_name: dest.last_name,
                  street_address: dest.street_address,
                  extended_address: dest.extended_address,
                  address_locality: dest.address_locality,
                  address_region: dest.address_region,
                  postal_code: dest.postal_code,
                  address_country: dest.address_country,
                },
                description: "Standard 2-day shipping",
                fulfillable_on: eta,
              },
            ],
            events: [],
          },
          currency: co.currency,
          totals: co.totals,
        };
        const rec: OrderRecord = {
          order: orderObj,
          status: "confirmed",
          buyer: co.buyer,
          payment: {
            status: "captured",
            handler: String(instrument.handler_id).startsWith("rtp_") ? "com.paystream.rtp" : "com.google.pay",
            rail: auth.rail ?? "card_network",
            last4: composite?.network_token?.last4,
            psp_transaction_id: auth.transaction_id,
          },
          estimated_delivery: eta,
          evidence: {
            checkout_mandate: mandateJws,
            merchant_authorization: embedded.ap2!.merchant_authorization!,
            cart_mandate_id: claims.cart_mandate_id,
            payment_mandate_id: auth.payment_mandate_id,
            verification,
          },
          platform_profile: ctx.signerProfileUrl,
          created_at: new Date().toISOString(),
        };
        t.orders.set(orderId, rec);
        co.status = "completed";
        co.payment = { instruments: [{ ...instrument, credential: { type: instrument.credential.type, token: "redacted" } }] };
        co.order = { id: orderId, permalink_url: orderObj.permalink_url, label: orderObj.label, estimated_delivery: eta };
        const signed = refreshCheckout(t, co);
        signed.status = "completed";
        log(seed.id, "complete_checkout", `order ${orderId} created (${liveTotal} minor units)`);

        // Auto-ship after a few seconds (fulfillment center simulation) → signed Order webhook
        setTimeout(() => shipOrder(t, orderId).catch((e) => log(seed.id, "webhook.error", e.message)), 8000);
        return { checkout: signed };
      },
    },

    /* ---- catalog lookup capability (dev.ucp.shopping.catalog.lookup) ---- */
    lookup_catalog: {
      description: "Look up multiple products by id (catalog lookup).",
      inputSchema: { $ref: SCHEMA("shopping/catalog_lookup.json") + "#/$defs/lookup_request" },
      outputSchema: { $ref: SCHEMA("shopping/catalog_lookup.json") + "#/$defs/lookup_response" },
      handler: async (args: any) => {
        const ids: string[] = args?.ids ?? [];
        const products = ids
          .map((id) => seed.catalog.find((p) => p.id === id))
          .filter(Boolean)
          .map((p) => productWire(seed, p!));
        return { ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.catalog.lookup": [{ version: UCP_VERSION }] } }, products };
      },
    },

    get_product: {
      description: "Retrieve a single product's full detail.",
      inputSchema: { $ref: SCHEMA("shopping/catalog_lookup.json") + "#/$defs/get_product_request" },
      outputSchema: { $ref: SCHEMA("shopping/catalog_lookup.json") + "#/$defs/get_product_response" },
      handler: async (args: any) => {
        const p = seed.catalog.find((x) => x.id === args?.id);
        if (!p) throw new BusinessError([{ type: "error", code: "not_found", content: `No product ${args?.id}`, severity: "unrecoverable" }], `https://${seed.domain}/`);
        return { ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.catalog.lookup": [{ version: UCP_VERSION }] } }, product: productWire(seed, p) };
      },
    },

    /* ---- cart capability (dev.ucp.shopping.cart) ---- */
    create_cart: {
      description: "Create a cart (basket before checkout intent).",
      inputSchema: { type: "object", properties: { cart: { $ref: SCHEMA("shopping/cart.json") } } },
      outputSchema: { $ref: SCHEMA("shopping/cart.json") },
      handler: async (args: any) => {
        const items = buildLineItems(seed, args?.cart?.line_items ?? []);
        items.forEach((li) => (li.totals = lineItemTotals(li)));
        const cart: Cart = {
          ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.shopping.cart": [{ version: UCP_VERSION }] } },
          id: randomId("cart_s"),
          status: "active",
          currency: "USD",
          line_items: items,
          buyer: args?.cart?.buyer,
          totals: cartTotals(items),
          links: [{ type: "terms_of_service", url: `https://${seed.domain}/tos` }],
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        };
        t.carts.set(cart.id, cart);
        log(seed.id, "create_cart", `${cart.id} (${items.length} items)`);
        return { cart };
      },
    },
    get_cart: {
      description: "Get a cart.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { $ref: SCHEMA("shopping/cart.json") },
      handler: async (args: any) => {
        const cart = t.carts.get(args?.id);
        if (!cart) throw new BusinessError([{ type: "error", code: "not_found", content: `No cart ${args?.id}`, severity: "unrecoverable" }]);
        return { cart };
      },
    },
    update_cart: {
      description: "Update a cart's line items.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, cart: { $ref: SCHEMA("shopping/cart.json") } }, required: ["id", "cart"] },
      outputSchema: { $ref: SCHEMA("shopping/cart.json") },
      handler: async (args: any) => {
        const cart = t.carts.get(args?.id);
        if (!cart) throw new BusinessError([{ type: "error", code: "not_found", content: `No cart ${args?.id}`, severity: "unrecoverable" }]);
        for (const upd of args?.cart?.line_items ?? []) {
          const li = cart.line_items.find((l) => l.id === upd.id || l.item.id === upd.item?.id);
          if (li && upd.quantity != null) li.quantity = Math.max(0, Number(upd.quantity));
          else if (!li && upd.item?.id) {
            const [ni] = buildLineItems(seed, [upd]);
            cart.line_items.push(ni);
          }
        }
        cart.line_items = cart.line_items.filter((l) => l.quantity > 0);
        cart.line_items.forEach((li) => (li.totals = lineItemTotals(li)));
        cart.totals = cartTotals(cart.line_items);
        log(seed.id, "update_cart", `${cart.id} → ${cart.line_items.length} items`);
        return { cart };
      },
    },
    cancel_cart: {
      description: "Cancel a cart.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { $ref: SCHEMA("shopping/cart.json") },
      requiresIdempotencyKey: true,
      handler: async (args: any) => {
        const cart = t.carts.get(args?.id);
        if (!cart) throw new BusinessError([{ type: "error", code: "not_found", content: `No cart ${args?.id}`, severity: "unrecoverable" }]);
        cart.status = "canceled";
        return { cart };
      },
    },

    /* ---- order capability ---- */
    get_order: {
      description: "Get an order.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { $ref: SCHEMA("shopping/order.json") },
      handler: async (args: any) => {
        const rec = t.orders.get(args?.id);
        if (!rec) throw new BusinessError([{ type: "error", code: "not_found", content: `No order ${args?.id}`, severity: "unrecoverable" }]);
        return { order: rec.order };
      },
    },

    /* ---- identity linking: user-scoped order history (dev.ucp.shopping.order:read) ---- */
    list_orders: {
      description: "List the linked user's orders. Requires an OAuth access token with scope dev.ucp.shopping.order:read.",
      inputSchema: { type: "object", properties: { access_token: { type: "string" } }, required: ["access_token"] },
      handler: async (args: any) => {
        const tok = accessTokens.get(args?.access_token);
        if (!tok || tok.expires < Date.now())
          throw new RpcError(-32000, "Invalid or expired access token", UCP_ERR("invalid_token", "OAuth access token required"), 401);
        if (!tok.scope.split(" ").includes("dev.ucp.shopping.order:read"))
          throw new RpcError(-32000, "Insufficient scope", UCP_ERR("insufficient_scope", "requires dev.ucp.shopping.order:read"), 403);
        const orders = [...t.orders.values()]
          .filter((r) => (r.buyer?.email ?? "") === tok.user || tok.user === "user_alex")
          .map((r) => ({ id: r.order.id, status: r.status, total: r.order.totals.find((x) => x.type === "total")?.amount, currency: r.order.currency, permalink_url: r.order.permalink_url, created_at: r.created_at }));
        log(seed.id, "list_orders", `${orders.length} orders for ${tok.user} (scope ok)`);
        return { ucp: { version: UCP_VERSION, capabilities: { "dev.ucp.common.identity_linking": [{ version: UCP_VERSION }] } }, orders };
      },
    },

    /* ---- refunds & disputes (post-order adjustments) ---- */
    refund_order: {
      description: "Refund an order (full or partial). Records an adjustment and refunds via the PSP.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, amount: { type: "object" }, reason: { type: "string" } }, required: ["id"] },
      requiresIdempotencyKey: true,
      handler: async (args: any) => {
        const rec = t.orders.get(args?.id);
        if (!rec) throw new BusinessError([{ type: "error", code: "not_found", content: `No order ${args?.id}`, severity: "unrecoverable" }]);
        const identity = { key: t.key, profileUrl: merchantProfileUrl(seed.id) };
        const refund = await callTool(`${URLS.paymentProvider}/mcp`, "refund_payment", {
          transaction_id: rec.payment.psp_transaction_id,
          amount: args?.amount,
          reason: args?.reason,
        }, identity);
        const adj = {
          id: randomId("adj", 12),
          type: "refund" as const,
          amount: { type: "total", amount: -refund.amount.amount, display_text: "Refund" },
          reason: args?.reason ?? "requested_by_customer",
          occurred_at: new Date().toISOString(),
          psp_refund_id: refund.refund_id,
        };
        rec.order.adjustments = [...(rec.order.adjustments ?? []), adj];
        rec.status = refund.status === "refunded" ? "refunded" : "partially_refunded";
        rec.payment.status = refund.status;
        await pushOrderWebhook(t, rec, "order.refunded");
        log(seed.id, "refund_order", `${rec.order.id} refunded ${refund.amount.amount} → ${rec.status}`);
        return { order: rec.order };
      },
    },
    file_dispute: {
      description: "Buyer files a dispute. The merchant attaches the AP2 mandate chain as evidence for the adjudicator.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] },
      handler: async (args: any) => {
        const rec = t.orders.get(args?.id);
        if (!rec) throw new BusinessError([{ type: "error", code: "not_found", content: `No order ${args?.id}`, severity: "unrecoverable" }]);
        rec.status = "disputed";
        const adj = {
          id: randomId("adj", 12),
          type: "dispute" as const,
          reason: args?.reason ?? "item_not_as_described",
          occurred_at: new Date().toISOString(),
          evidence: {
            cart_mandate_id: rec.evidence.cart_mandate_id,
            checkout_mandate_present: true,
            merchant_authorization_present: true,
            verification: rec.evidence.verification,
            note: "User-signed mandate proves authorization of these exact terms (AP2 dispute evidence).",
          },
        };
        rec.order.adjustments = [...(rec.order.adjustments ?? []), adj];
        log(seed.id, "file_dispute", `${rec.order.id} disputed (${adj.reason}) — evidence attached`);
        return { order: rec.order, evidence: adj.evidence };
      },
    },
  };
}

/* ---------------- catalog product shape (product.json) ---------------- */

function productWire(seed: MerchantSeed, p: MerchantSeed["catalog"][number]) {
  return {
    id: p.id,
    title: p.name,
    description: { plain: p.note ?? p.name },
    url: `https://${seed.domain}/products/${p.id}`,
    price_range: { min: { amount: p.price, currency: "USD" }, max: { amount: p.price, currency: "USD" } },
    variants: [
      {
        id: p.id,
        title: "Default",
        description: { plain: p.note ?? p.name },
        price: { amount: p.price, currency: "USD" },
        ...(p.was != null ? { list_price: { amount: p.was, currency: "USD" } } : {}),
      },
    ],
    tags: p.attributes ?? [],
    metadata: { brand: p.brand, ship: p.ship, ship_days: p.ship_days, in_stock: p.in_stock, specs: p.specs, ...(p.image ? { image: `${URLS.merchantPortal}${p.image}` } : {}), ...(p.accessory_for ? { accessory_for: p.accessory_for } : {}) },
  };
}

function cartTotals(items: LineItem[]): Total[] {
  const subtotal = items.reduce((a, i) => a + i.item.price * i.quantity, 0);
  return [
    { type: "subtotal", amount: subtotal },
    { type: "total", amount: subtotal },
  ];
}

/* ---------------- order webhook push (Order capability) ---------------- */

async function shipOrder(t: Tenant, orderId: string, opts: { late?: boolean } = {}) {
  const rec = t.orders.get(orderId);
  if (!rec || rec.status !== "confirmed") return;
  rec.status = "shipped";
  const tracking = "1Z" + randomId("", 16).slice(1).toUpperCase();
  // Late-delivery simulation: the carrier reports a revised ETA 3 days past
  // the promise — the agent's post-purchase monitor detects this.
  if (opts.late) {
    const revised = new Date(Date.parse(rec.estimated_delivery) + 3 * 864e5).toISOString();
    rec.order.fulfillment.expectations![0]!.fulfillable_on = revised;
  }
  // fulfillment_event.json: id, occurred_at, type, line_items[{id,quantity}], tracking (required when type != processing)
  rec.order.fulfillment.events!.push({
    id: `evt_${rec.order.fulfillment.events!.length + 1}`,
    occurred_at: new Date().toISOString(),
    type: "shipped",
    line_items: rec.order.line_items.map((l) => ({ id: l.id, quantity: l.quantity.total })),
    carrier: "UPS",
    tracking_number: tracking,
    tracking_url: `https://www.ups.com/track?tracknum=${tracking}`,
    description: opts.late
      ? "Package handed to carrier — carrier reports a delay; revised delivery estimate issued"
      : "Package handed to carrier",
  });
  for (const l of rec.order.line_items) {
    l.quantity.fulfilled = l.quantity.total;
    l.status = "fulfilled";
  }
  await pushOrderWebhook(t, rec, "order.shipped");
}

/** Push a signed Order object to the platform's order-capability webhook. */
async function pushOrderWebhook(t: Tenant, rec: OrderRecord, event: string) {
  const platformProfile = await fetchUcpProfile(rec.platform_profile);
  const webhookUrl: string | undefined =
    platformProfile?.ucp?.capabilities?.["dev.ucp.shopping.order"]?.[0]?.config?.webhook_url;
  if (!webhookUrl) return;
  const body = JSON.stringify({ event, order: rec.order });
  const headers = signRequest({
    method: "POST",
    url: webhookUrl,
    body,
    key: t.key,
    profileUrl: merchantProfileUrl(t.seed.id),
    idempotencyKey: `${rec.order.id}-${event}-${rec.order.fulfillment.events?.length ?? 0}-${rec.order.adjustments?.length ?? 0}`,
  });
  await fetch(webhookUrl, { method: "POST", headers: headers as unknown as Record<string, string>, body });
  log(t.seed.id, "webhook", `${event} pushed for ${rec.order.id} → ${webhookUrl}`);
}

/* ---------------- express app ---------------- */

const app = express();
app.use(express.json({ verify: rawBodySaver }));
app.use(express.static(path.join(__dirname, "../public")));

// Business profiles — spec-compliant {ucp: {...}, signing_keys} with caching headers
app.get("/m/:mid/.well-known/ucp", (req, res) => {
  const t = tenants.get(req.params.mid);
  if (!t) return res.status(404).json({ error: "unknown merchant" });
  res.set("Cache-Control", "public, max-age=300"); // spec: MUST be public with max-age >= 60
  const shoppingServices = [
    {
      version: UCP_VERSION,
      spec: SPEC("overview"),
      transport: "mcp" as const,
      schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
      endpoint: `${URLS.merchantPortal}/m/${t.seed.id}/mcp`,
    },
    // REST binding for the official conformance suite (UCP_REST=1 only).
    ...(process.env.UCP_REST
      ? [{
          version: UCP_VERSION,
          spec: SPEC("overview"),
          transport: "rest" as const,
          schema: SCHEMA("shopping/checkout.json"),
          endpoint: `${URLS.merchantPortal}/m/${t.seed.id}/rest`,
        }]
      : []),
  ];
  res.json({
    name: t.seed.name,
    // The 2026-01-23 conformance suite reads `services` at the TOP LEVEL of the
    // profile (pre-envelope shape); the current 2026-04-08 spec nests it under
    // `ucp`. When UCP_REST is on we mirror it at top level for the older suite.
    ...(process.env.UCP_REST
      ? { version: UCP_VERSION, services: { "dev.ucp.shopping": [...shoppingServices].sort((a, b) => (a.transport === "rest" ? -1 : 1)) } }
      : {}),
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": shoppingServices,
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [
          { version: UCP_VERSION, spec: SPEC("checkout"), schema: SCHEMA("shopping/checkout.json") },
        ],
        "dev.ucp.shopping.cart": [
          { version: UCP_VERSION, spec: SPEC("cart"), schema: SCHEMA("shopping/cart.json") },
        ],
        "dev.ucp.shopping.catalog.search": [
          { version: UCP_VERSION, spec: SPEC("catalog/search"), schema: SCHEMA("shopping/catalog_search.json") },
        ],
        "dev.ucp.shopping.catalog.lookup": [
          { version: UCP_VERSION, spec: SPEC("catalog/lookup"), schema: SCHEMA("shopping/catalog_lookup.json") },
        ],
        "dev.ucp.shopping.order": [
          { version: UCP_VERSION, spec: SPEC("order"), schema: SCHEMA("shopping/order.json") },
        ],
        "dev.ucp.shopping.fulfillment": [
          { version: UCP_VERSION, spec: SPEC("fulfillment"), schema: SCHEMA("shopping/fulfillment.json"), extends: "dev.ucp.shopping.checkout" },
        ],
        "dev.ucp.shopping.discount": [
          { version: UCP_VERSION, spec: SPEC("discount"), schema: SCHEMA("shopping/discount.json"), extends: "dev.ucp.shopping.checkout" },
        ],
        "dev.ucp.shopping.ap2_mandate": [
          {
            version: UCP_VERSION,
            spec: SPEC("ap2-mandates"),
            schema: SCHEMA("shopping/ap2_mandate.json"),
            extends: "dev.ucp.shopping.checkout",
            config: { vp_formats_supported: { "dc+sd-jwt": {} } },
          },
        ],
        "dev.ucp.common.identity_linking": [
          {
            version: UCP_VERSION,
            spec: SPEC("identity-linking"),
            schema: SCHEMA("common/identity_linking.json"),
            config: { scopes: { "dev.ucp.shopping.order:read": {} } },
          },
        ],
      },
      payment_handlers: {
        "com.google.pay": [GPAY_HANDLER(t.seed.id)],
        "com.paystream.rtp": [RTP_HANDLER(t.seed.id)],
      },
    },
    signing_keys: [t.key.publicJwk],
  });
});

/* ---------------- Identity Linking — OAuth 2.0 (per tenant) ---------------- */

// RFC 8414 authorization server metadata discovery.
app.get("/m/:mid/.well-known/oauth-authorization-server", (req, res) => {
  const mid = req.params.mid;
  if (!tenants.has(mid)) return res.status(404).json({ error: "unknown merchant" });
  const base = `${URLS.merchantPortal}/m/${mid}`;
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    scopes_supported: ["dev.ucp.shopping.order:read"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Authorize — a real deployment shows a consent screen; the demo auto-approves.
app.get("/m/:mid/oauth/authorize", (req, res) => {
  const mid = req.params.mid;
  if (!tenants.has(mid)) return res.status(404).json({ error: "unknown merchant" });
  const { client_id, redirect_uri, scope, state } = req.query as Record<string, string>;
  const code = randomId("oauthcode", 24);
  oauthCodes.set(code, { code, client_id: client_id ?? "", scope: scope ?? "", redirect_uri: redirect_uri ?? "", user: "user_alex", created: Date.now() });
  log(mid, "oauth.authorize", `issued code for ${client_id} scope="${scope}"`);
  if (redirect_uri) {
    const u = new URL(redirect_uri);
    u.searchParams.set("code", code);
    if (state) u.searchParams.set("state", state);
    return res.redirect(u.toString());
  }
  res.json({ code, state });
});

// Token — exchange the authorization code for an access token.
app.post("/m/:mid/oauth/token", express.urlencoded({ extended: true }), express.json(), (req, res) => {
  const mid = req.params.mid;
  if (!tenants.has(mid)) return res.status(404).json({ error: "unknown merchant" });
  const body = { ...req.body, ...req.query } as Record<string, string>;
  const rec = oauthCodes.get(body.code);
  if (body.grant_type !== "authorization_code" || !rec)
    return res.status(400).json({ error: "invalid_grant" });
  oauthCodes.delete(body.code);
  const token = randomId("at", 32);
  accessTokens.set(token, { token, scope: rec.scope, user: rec.user, client_id: rec.client_id, expires: Date.now() + 3600 * 1000 });
  log(mid, "oauth.token", `access token issued (scope="${rec.scope}")`);
  res.json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: rec.scope });
});

// Tenant MCP endpoints (PKI-verified JSON-RPC 2.0, tools/call binding).
// complete_checkout responses are signed (RFC 9421, @status) — RECOMMENDED.
for (const [mid, t] of tenants) {
  app.post(
    `/m/${mid}/mcp`,
    mcpHandler({
      serverName: `merchant-${mid}`,
      tools: tenantTools(t) as any,
      trustedProfiles: defaultTrust,
      responseKey: t.key,
      signResponseFor: (name) => name === "complete_checkout",
    })
  );
}

/* ---------------- portal UI API (local browser, unsigned) ---------------- */

app.get("/api/portal/state", async (_req, res) => {
  res.json({
    merchants: [...tenants.values()].map((t) => ({
      id: t.seed.id,
      name: t.seed.name,
      color: t.seed.color,
      short: t.seed.short,
      domain: t.seed.domain,
      rating: t.seed.rating,
      profile_url: merchantProfileUrl(t.seed.id),
      kid: t.key.kid,
      catalog: t.seed.catalog,
      checkouts: [...t.checkouts.values()].map((c) => ({
        id: c.id,
        status: c.status,
        total: totalOf(c),
        items: c.line_items.map((l) => `${l.quantity}× ${l.item.title}`),
        buyer: c.buyer?.email,
        signed: !!c.ap2?.merchant_authorization,
      })),
      orders: [...t.orders.values()].map((r) => ({
        id: r.order.id,
        merchant_id: t.seed.id,
        checkout_id: r.order.checkout_id,
        status: r.status,
        total: r.order.totals.find((x) => x.type === "total")?.amount ?? 0,
        currency: r.order.currency,
        buyer: r.buyer,
        items: r.order.line_items.map((l) => ({ title: l.item.title, quantity: l.quantity.total, price: l.item.price })),
        payment: r.payment,
        permalink_url: r.order.permalink_url,
        estimated_delivery: r.estimated_delivery,
        tracking: r.order.fulfillment.events?.[0]
          ? { carrier: r.order.fulfillment.events[0].carrier, number: r.order.fulfillment.events[0].tracking_number }
          : undefined,
        kya: r.evidence?.verification?.kya,
        evidence: r.evidence,
        created_at: r.created_at,
      })),
      analytics: (() => {
        const orders = [...t.orders.values()];
        const revenue = orders.reduce((a, r) => a + (r.order.totals.find((x) => x.type === "total")?.amount ?? 0), 0);
        const rails = { card_network: 0, rtp: 0 };
        for (const r of orders) rails[(r.payment.rail as "card_network" | "rtp") ?? "card_network"]++;
        return {
          orders: orders.length,
          revenue,
          aov: orders.length ? Math.round(revenue / orders.length) : 0,
          rails,
          declines: t.stats.declines,
          refunds: orders.filter((r) => ["refunded", "partially_refunded"].includes(r.status)).length,
        };
      })(),
    })),
    activity: activity.slice(-200).reverse(),
    peers: { credentials: CREDENTIALS_PROFILE_URL, payments: PAYMENTS_PROFILE_URL },
  });
});

// Catalog operability: edit price / stock from the portal (demo of dynamic re-pricing).
app.post("/api/portal/catalog", express.json(), (req, res) => {
  const t = tenants.get(req.body?.merchant_id);
  if (!t) return res.status(404).json({ error: "unknown merchant" });
  const p = t.seed.catalog.find((x) => x.id === req.body?.product_id);
  if (!p) return res.status(404).json({ error: "unknown product" });
  if (Number.isFinite(Number(req.body?.price))) (p as any).price = Math.max(0, Math.round(Number(req.body.price)));
  if (typeof req.body?.in_stock === "boolean") (p as any).in_stock = req.body.in_stock;
  log(t.seed.id, "catalog.update", `${p.id} price=${(p as any).price} in_stock=${(p as any).in_stock}`);
  res.json({ ok: true, product: p });
});

// Mark an order delivered (fulfillment event + signed order.delivered webhook).
app.post("/api/portal/deliver", express.json(), async (req, res) => {
  const t = tenants.get(req.body?.merchant_id);
  if (!t) return res.status(404).json({ error: "unknown merchant" });
  const rec = t.orders.get(req.body?.order_id);
  if (!rec || rec.status !== "shipped") return res.status(409).json({ error: "order is not in shipped state" });
  rec.status = "delivered";
  rec.order.fulfillment.events!.push({
    id: `evt_${rec.order.fulfillment.events!.length + 1}`,
    occurred_at: new Date().toISOString(),
    type: "delivered",
    line_items: rec.order.line_items.map((l) => ({ id: l.id, quantity: l.quantity.total })),
    carrier: rec.order.fulfillment.events![0]?.carrier ?? "UPS",
    tracking_number: rec.order.fulfillment.events![0]?.tracking_number,
    tracking_url: rec.order.fulfillment.events![0]?.tracking_url,
    description: "Package delivered to the buyer",
  });
  log(t.seed.id, "order.delivered", `${rec.order.id} delivered`);
  await pushOrderWebhook(t, rec, "order.delivered").catch(() => {});
  res.json({ ok: true });
});

app.post("/api/portal/ship", express.json(), async (req, res) => {
  const t = tenants.get(req.body?.merchant_id);
  if (!t) return res.status(404).json({ error: "unknown merchant" });
  try {
    await shipOrder(t, req.body?.order_id, { late: !!req.body?.late });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// REST conformance binding (fenced; mounted only when UCP_REST=1).
if (process.env.UCP_REST) {
  for (const seed of MERCHANTS) {
    const r = restConformanceRouter({ baseUrl: `${URLS.merchantPortal}/m/${seed.id}/rest`, domain: seed.domain });
    // The suite reads the shopping endpoint (/rest) for checkout/order routes,
    // but posts /testing/simulate-shipping to the server_url BASE — mount the
    // same router (shared state) at both so both reach the same order store.
    app.use(`/m/${seed.id}/rest`, r);
    app.use(`/m/${seed.id}`, r);
  }
  console.log(`[merchant] REST conformance binding mounted at /m/{id}/rest (UCP_REST=1)`);
}

app.listen(PORTS.merchantPortal, () => {
  console.log(`[merchant-portal] ${URLS.merchantPortal} — tenants: ${[...tenants.keys()].join(", ")} (UCP ${UCP_VERSION}, MCP binding)`);
});
