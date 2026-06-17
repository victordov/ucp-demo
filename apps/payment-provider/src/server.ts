/**
 * Payment Provider (PSP) — AP2 "Merchant Payment Processor" role.
 *
 * authorize_payment:
 *   1. PKI-verifies the calling merchant (RFC 9421 HTTP message signature).
 *   2. Verifies the AP2 PaymentMandate (JWS by the user's device key,
 *      resolved from the Credentials Provider's published JWKs).
 *   3. Checks mandate scope: amount, payee, checkout binding, expiry.
 *   4. Requests payment credentials from the Credentials Provider against
 *      the single-use network token (AP2 steps 26–27), then authorizes.
 * capture_payment: captures an authorized transaction.
 *
 * Same JSON-RPC 2.0 tools/call binding as UCP MCP. Amounts in minor units.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKey, randomId, jwkToPublicKey, jwsVerifyCompact, jwsSignCompact } from "../../../packages/common/src/crypto.ts";
import { sdJwtVerify } from "../../../packages/common/src/sdjwt.ts";
import {
  hashClosedMandate,
  PAYMENT_MANDATE_VCT,
  verifyOpenPaymentMandate,
  evaluatePaymentConstraints,
  openMandateDigest,
} from "../../../packages/common/src/ap2.ts";
import { isChain, verifyDelegateChain } from "../../../packages/common/src/dsdjwt.ts";
import {
  mcpHandler,
  callTool,
  rawBodySaver,
  fetchUcpProfile,
  findJwk,
  RpcError,
  UCP_ERR,
} from "../../../packages/common/src/jsonrpc.ts";
import { PORTS, URLS, defaultTrust, AGENT_PROFILE_URL, CREDENTIALS_PROFILE_URL, PAYMENTS_PROFILE_URL } from "../../../packages/common/src/config.ts";
import { UCP_VERSION, type CompositeToken, type PaymentMandatePayload, type PaymentReceiptPayload, type OpenPaymentMandatePayload } from "../../../packages/common/src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serviceKey = generateSigningKey("paystream-psp-2026");

/* Recurrence/budget ledger for Open Payment Mandates (payment.agent_recurrence /
 * payment.budget) — tracks occurrence count + cumulative spend per open mandate
 * so the PSP can bound autonomous reuse across cycles. */
const openMandateLedger = new Map<string, { count: number; spent: number }>();

/* ---------------- Agent Registry — "Know Your Agent" + reputation ----------------
 * The network-level trust layer: agents register (KYA, like KYC for agents),
 * accumulate a behavior-based reputation score, and can be suspended.
 * Merchants call lookup_agent before accepting an agent's money movement.
 */
interface AgentRecord {
  profile_url: string;
  name: string;
  owner: string;
  kya_level: "verified" | "basic";
  status: "active" | "suspended";
  reputation: number; // 0–100
  events: { ts: number; kind: string; delta: number; note: string }[];
  registered_at: string;
}
const agentRegistry = new Map<string, AgentRecord>();
agentRegistry.set(AGENT_PROFILE_URL, {
  profile_url: AGENT_PROFILE_URL,
  name: "Shoppy (UCP shopping agent)",
  owner: "Alex Morgan <alex.morgan@example.com>",
  kya_level: "verified",
  status: "active",
  reputation: 92,
  events: [{ ts: Date.now(), kind: "registered", delta: 0, note: "KYA onboarding complete (verified)" }],
  registered_at: new Date().toISOString(),
});

function reputationEvent(agent: string | undefined, kind: string, delta: number, note: string) {
  const rec = agent ? agentRegistry.get(agent) : undefined;
  if (!rec) return;
  rec.reputation = Math.max(0, Math.min(100, rec.reputation + delta));
  rec.events.push({ ts: Date.now(), kind, delta, note });
  if (rec.events.length > 100) rec.events.shift();
}

/* ---------------- Velocity / agent-native fraud rules ----------------
 * Agent transactions can be thousands per second, not dozens per day —
 * the PSP rate-checks per agent over a rolling window.
 */
let velocityLimit = Number(process.env.PSP_VELOCITY_LIMIT ?? 60); // authorizations / 60s / agent
const VELOCITY_WINDOW_MS = 60_000;
const velocityLog = new Map<string, number[]>(); // agent → auth timestamps

function checkVelocity(agent: string): { ok: boolean; count: number } {
  const now = Date.now();
  const arr = (velocityLog.get(agent) ?? []).filter((t) => now - t < VELOCITY_WINDOW_MS);
  velocityLog.set(agent, arr);
  if (arr.length >= velocityLimit) return { ok: false, count: arr.length };
  arr.push(now);
  return { ok: true, count: arr.length };
}

interface Txn {
  transaction_id: string;
  status: "authorized" | "captured" | "declined" | "requires_challenge" | "refunded" | "partially_refunded";
  amount: number; // minor units
  currency: string;
  refunded: number;
  refunds: { id: string; amount: number; reason: string; at: string }[];
  merchant_id: string;
  merchant_profile: string;
  checkout_id: string;
  network: string;
  last4: string;
  token: string;
  rail: "card_network" | "rtp";
  agent?: string; // agent profile URL (from the payment mandate)
  mandate_jws?: string; // the verified PaymentMandate (drill-in decoding in the dashboard)
  payment_receipt?: string; // signed AP2 Payment Receipt (dispute evidence)
  payment_mandate_id: string;
  mandate_verification: Record<string, string>;
  agent_presence: { ai_agent_involved: boolean; modality: "human_present" | "human_not_present" };
  signals?: Record<string, unknown>;
  challenge_id?: string;
  created_at: string;
  captured_at?: string;
}
const txns = new Map<string, Txn>();

interface LogEntry { ts: number; kind: string; summary: string; detail?: unknown }
const activity: LogEntry[] = [];
function log(kind: string, summary: string, detail?: unknown) {
  activity.push({ ts: Date.now(), kind, summary, detail });
  if (activity.length > 500) activity.shift();
  console.log(`[payments] ${kind}: ${summary}`);
}

const tools = {
  authorize_payment: {
    description: "Authorize an AP2 composite-token payment after full mandate verification.",
    inputSchema: {
      type: "object",
      properties: { payment: { type: "object" }, signals: { type: "object" } },
      required: ["payment"],
    },
    requiresIdempotencyKey: true,
    handler: async (args: any, ctx: any) => {
      const p = args?.payment ?? {};
      const credential = p.credential as CompositeToken;
      const amount = p.amount;
      if (!credential?.network_token || !credential?.payment_mandate)
        throw new RpcError(-32600, "credential must be an AP2 composite token", UCP_ERR("invalid_credential", "missing network_token or payment_mandate"), 400);

      const verification: Record<string, string> = {};
      const humanPresent = p.human_present !== false;

      const cpProfile = await fetchUcpProfile(CREDENTIALS_PROFILE_URL);
      const resolveCpKey = (kid: string) => {
        const jwk = findJwk(cpProfile, kid);
        return jwk ? jwkToPublicKey(jwk) : undefined;
      };

      // 1. Verify the Payment Mandate. Human-not-present → a dSD-JWT chain: open
      //    (user-signed root, cnf=agent) ~~ closed (agent-signed terminal), the
      //    terminal sd_hash-bound to the root. Human-present → a single SD-JWT+kb
      //    signed by the CP, key-bound to the user device key.
      let mandate: PaymentMandatePayload;
      let openPay: OpenPaymentMandatePayload | undefined;
      try {
        if (isChain(credential.payment_mandate)) {
          const chain = verifyDelegateChain(credential.payment_mandate, resolveCpKey, { aud: p.merchant_profile, nonce: p.checkout_id });
          openPay = chain.open as OpenPaymentMandatePayload;
          mandate = chain.closed as unknown as PaymentMandatePayload;
          verification.signature = "valid dSD-JWT chain (user-signed open root → agent-signed closed; sd_hash-bound)";
        } else {
          const { claims, issuerKid } = sdJwtVerify(credential.payment_mandate, resolveCpKey, { aud: p.merchant_profile, nonce: p.checkout_id });
          mandate = claims as unknown as PaymentMandatePayload;
          verification.signature = `valid SD-JWT+kb (issuer kid=${issuerKid} via ${CREDENTIALS_PROFILE_URL}, key-bound to user device, aud=${p.merchant_profile})`;
        }
      } catch (e: any) {
        const code = /mandate_expired/.test(e.message)
          ? "mandate_expired"
          : /aud mismatch|nonce mismatch|sd_hash|key-binding/.test(e.message)
            ? "mandate_scope_mismatch"
            : "mandate_invalid_signature";
        log("authorize.declined", `${code}: ${e.message}`);
        throw new RpcError(-32000, "Payment mandate invalid", UCP_ERR(code, e.message), 401);
      }
      // Modality: an autonomous (human-not-present) payment MUST ride an open→closed chain.
      if (!humanPresent && !openPay)
        throw new RpcError(-32000, "Open mandate required", UCP_ERR("mandate_required", "human-not-present payment requires an open→closed mandate chain"), 401);
      // vct must match exactly (AP2 mandate versioning)
      if (mandate.vct !== PAYMENT_MANDATE_VCT)
        throw new RpcError(-32000, "Unexpected payment mandate type", UCP_ERR("mandate_invalid_signature", `vct ${mandate.vct}`), 401);

      // 1b. Know Your Agent: the agent named in the mandate must be registered
      //     and in good standing (suspension + reputation gate).
      const agent = mandate.agent ?? AGENT_PROFILE_URL;
      const reg = agentRegistry.get(agent);
      if (reg) {
        if (reg.status === "suspended") {
          log("authorize.declined", `agent_untrusted: ${agent} is suspended in the registry`);
          throw new RpcError(-32000, "Agent suspended in registry", UCP_ERR("agent_untrusted", `${agent} (KYA status: suspended)`), 403);
        }
        if (reg.reputation < 40) {
          log("authorize.declined", `agent_untrusted: ${agent} reputation ${reg.reputation} < 40`);
          throw new RpcError(-32000, "Agent reputation below threshold", UCP_ERR("agent_untrusted", `reputation ${reg.reputation} < 40`), 403);
        }
        verification.kya = `agent registered (${reg.kya_level}) · reputation ${reg.reputation}/100`;
      } else {
        verification.kya = "agent not registered (demo allows; production would decline)";
      }

      // 1c. Velocity / agent-native fraud rule: rolling rate limit per agent.
      const vel = checkVelocity(agent);
      if (!vel.ok) {
        reputationEvent(agent, "velocity_exceeded", -10, `> ${velocityLimit} authorizations / 60s`);
        log("authorize.declined", `velocity_exceeded for ${agent} (${vel.count}/${velocityLimit} per 60s)`);
        throw new RpcError(-32000, "Velocity limit exceeded", UCP_ERR("velocity_exceeded", `${vel.count} authorizations in 60s (limit ${velocityLimit})`), 429);
      }
      verification.velocity = `${vel.count}/${velocityLimit} authorizations in the last 60s`;

      // 2. Scope checks
      if (new Date(mandate.expires_at).getTime() < Date.now())
        throw new RpcError(-32000, "Payment mandate expired", UCP_ERR("mandate_expired", mandate.expires_at), 401);
      verification.expiry = `valid until ${mandate.expires_at}`;

      if (mandate.payment_amount.amount !== amount?.amount || mandate.payment_amount.currency !== amount?.currency)
        throw new RpcError(-32000, "Amount does not match mandate", UCP_ERR("mandate_scope_mismatch", `mandate=${mandate.payment_amount.amount} request=${amount?.amount}`), 401);
      verification.amount = `${amount.amount} ${amount.currency} (minor units) matches mandate`;

      // transaction_id MUST equal the hash of the merchant-signed checkout (the
      // merchant forwards that hash) — binds the payment to the exact signed terms.
      if (p.checkout_hash && mandate.transaction_id !== p.checkout_hash)
        throw new RpcError(-32000, "Payment mandate not bound to this checkout", UCP_ERR("mandate_scope_mismatch", `transaction_id ${mandate.transaction_id} ≠ checkout hash ${p.checkout_hash}`), 401);
      verification.checkout_binding = `transaction_id = checkout hash ${String(mandate.transaction_id).slice(0, 16)}…`;

      if (mandate.payee?.website !== p.merchant_profile)
        throw new RpcError(-32000, "Payee does not match mandate", UCP_ERR("mandate_scope_mismatch", `mandate payee ${mandate.payee?.website} ≠ ${p.merchant_profile}`), 401);
      verification.payee = `bound to ${mandate.payee?.website}`;

      if (mandate.checkout_id !== p.checkout_id)
        throw new RpcError(-32000, "Checkout does not match mandate", UCP_ERR("mandate_scope_mismatch", `mandate checkout ${mandate.checkout_id} ≠ ${p.checkout_id}`), 401);
      verification.checkout = `bound to ${mandate.checkout_id}`;
      // The open↔closed binding is enforced cryptographically by the chain's
      // sd_hash (checked in verifyDelegateChain) — no separate digest check needed.
      verification.open_payment_binding = openPay ? "closed mandate bound to open via sd_hash chain ✓" : "n/a (human-present)";

      // 3. Pull credentials from the CP against the single-use token
      const identity = { key: serviceKey, profileUrl: PAYMENTS_PROFILE_URL };
      let creds: any;
      try {
        creds = await callTool(`${URLS.credentialsProvider}/mcp`, "release_credentials", { token: credential.network_token.token }, identity);
        verification.credentials = `released by CP for token ${credential.network_token.token.slice(0, 14)}…`;
      } catch (e: any) {
        log("authorize.declined", `credential release failed: ${e.message}`);
        throw new RpcError(-32000, "Credential release failed", UCP_ERR("payment_declined", e.message), 402);
      }

      // 2b. Open Payment Mandate constraints (human-not-present): the PSP
      //     independently checks that this charge satisfies the user-signed open
      //     mandate — amount_range/budget, agent_recurrence (occurrence count),
      //     allowed_payees, and payment.reference (binding to the open checkout).
      if (openPay) {
        const ledger = openMandateLedger.get(openPay.id) ?? { count: 0, spent: 0 };
        const ev = evaluatePaymentConstraints(
          { amount, payee: mandate.payee, openCheckoutDigest: p.open_checkout_digest },
          openPay,
          { occurrence: ledger.count + 1, priorSpend: ledger.spent }
        );
        if (!ev.ok) {
          log("authorize.declined", `open_payment_mandate constraint failed: ${ev.error}`);
          throw new RpcError(-32000, "Open Payment Mandate constraint failed", UCP_ERR("mandate_scope_mismatch", ev.error ?? "constraint unmet"), 401);
        }
        openMandateLedger.set(openPay.id, { count: ledger.count + 1, spent: ledger.spent + amount.amount });
        verification.open_payment_mandate = `valid (id=${openPay.id}) · ${ev.checked.join(", ")}`;
      } else {
        verification.open_payment_mandate = "n/a (human-present — user signed the closed Payment Mandate directly)";
      }

      // 3b. Spend-policy re-check (defense in depth): the CP bound the user's
      //     consent-policy snapshot into the token — the network re-validates.
      const rail: Txn["rail"] = creds.rail === "rtp" ? "rtp" : "card_network";
      if (creds.policy) {
        if (amount.amount > creds.policy.per_tx_cap) {
          reputationEvent(agent, "policy_violation", -8, `amount ${amount.amount} > token per-tx cap ${creds.policy.per_tx_cap}`);
          log("authorize.declined", `policy_per_tx_cap_exceeded (token-bound scope)`);
          throw new RpcError(-32000, "Amount exceeds token-bound spend policy", UCP_ERR("policy_per_tx_cap_exceeded", `${amount.amount} > ${creds.policy.per_tx_cap}`), 403);
        }
        verification.spend_policy = `within token-bound scope (per-tx cap ${creds.policy.per_tx_cap}, budget remaining ${creds.policy.budget_remaining})`;
      }
      verification.rail = rail === "rtp" ? "RTP — instant fiat settlement (no card network)" : "card network — auth + capture";

      // 4. Issuer / network simulation: SCA challenge, hard decline, or approval.
      const behavior: "ok" | "challenge" | "decline" = creds.behavior ?? "ok";
      const attestation: string | undefined = p.challenge_attestation;

      if (behavior === "decline") {
        const txn: Txn = makeTxn(p, amount, creds, mandate, verification, "declined", args?.signals);
        txn.rail = rail; txn.agent = agent;
        txns.set(txn.transaction_id, txn);
        reputationEvent(agent, "declined", -8, `issuer hard decline (${m4(creds)})`);
        log("authorize.declined", `${txn.transaction_id} hard decline (issuer) for ${m4(creds)}`);
        throw new RpcError(-32000, "Issuer declined the transaction", UCP_ERR("payment_declined", "do_not_honor (insufficient funds)"), 402);
      }

      if (behavior === "challenge" && !attestation) {
        // Soft decline → Strong Customer Authentication (3DS) required.
        const challengeId = randomId("3ds", 16);
        const txn: Txn = makeTxn(p, amount, creds, mandate, verification, "requires_challenge", args?.signals);
        txn.rail = rail; txn.agent = agent;
        txn.challenge_id = challengeId;
        txns.set(txn.transaction_id, txn);
        log("authorize.challenge", `${txn.transaction_id} requires 3DS (${challengeId})`);
        return {
          transaction_id: txn.transaction_id,
          status: "requires_challenge",
          challenge: {
            type: "3ds",
            challenge_id: challengeId,
            continue_url: `${URLS.paymentProvider}/challenge/${challengeId}`,
          },
          verification,
        };
      }

      if (behavior === "challenge" && attestation) verification.sca = `3DS attestation accepted (${attestation.slice(0, 14)}…)`;

      const txn: Txn = makeTxn(p, amount, creds, mandate, verification, "authorized", args?.signals);
      txn.rail = rail; txn.agent = agent;

      // AP2 Payment Receipt: the MPP MUST return a signed receipt once it has
      // accepted the Payment Mandate. reference = hash of the closed mandate.
      const paymentReceipt: PaymentReceiptPayload = {
        status: "Success",
        iss: PAYMENTS_PROFILE_URL,
        iat: Math.floor(Date.now() / 1000),
        reference: hashClosedMandate(credential.payment_mandate),
        payment_id: txn.transaction_id,
        psp_confirmation_id: randomId("pspc", 12),
        network_confirmation_id: randomId("netc", 12),
      };
      const paymentReceiptJws = jwsSignCompact(paymentReceipt, serviceKey, "ap2-receipt+jwt");
      txn.payment_receipt = paymentReceiptJws;

      txns.set(txn.transaction_id, txn);
      log("authorize_payment", `${txn.transaction_id} ${txn.amount} ${txn.currency} authorized for ${p.merchant_id} via ${rail} — mandate ${mandate.id} OK`, verification);
      return {
        transaction_id: txn.transaction_id,
        status: txn.status,
        payment_mandate_id: mandate.id,
        rail,
        verification,
        agent_presence: txn.agent_presence,
        payment_receipt: paymentReceiptJws,
        payment_receipt_payload: paymentReceipt,
      };
    },
  },

  capture_payment: {
    description: "Capture an authorized transaction.",
    inputSchema: { type: "object", properties: { transaction_id: { type: "string" } }, required: ["transaction_id"] },
    requiresIdempotencyKey: true,
    handler: async (args: any) => {
      const txn = txns.get(args?.transaction_id);
      if (!txn) throw new RpcError(-32000, "Unknown transaction", UCP_ERR("not_found", String(args?.transaction_id)), 404);
      if (txn.status !== "authorized") throw new RpcError(-32000, `Cannot capture ${txn.status} transaction`, UCP_ERR("invalid_state", txn.status), 409);
      txn.status = "captured";
      txn.captured_at = new Date().toISOString();
      reputationEvent(txn.agent, "captured", +1, `clean settlement ${txn.transaction_id} (${txn.rail})`);
      log("capture_payment", `${txn.transaction_id} captured (${txn.amount} minor units, ${txn.rail})`);
      return { transaction_id: txn.transaction_id, status: txn.status, captured_at: txn.captured_at, rail: txn.rail };
    },
  },

  refund_payment: {
    description: "Refund a captured transaction (full or partial). Records an issuer credit.",
    inputSchema: { type: "object", properties: { transaction_id: { type: "string" }, amount: { type: "object" }, reason: { type: "string" } }, required: ["transaction_id"] },
    requiresIdempotencyKey: true,
    handler: async (args: any) => {
      const txn = txns.get(args?.transaction_id);
      if (!txn) throw new RpcError(-32000, "Unknown transaction", UCP_ERR("not_found", String(args?.transaction_id)), 404);
      if (txn.status !== "captured" && txn.status !== "partially_refunded")
        throw new RpcError(-32000, `Cannot refund a ${txn.status} transaction`, UCP_ERR("invalid_state", txn.status), 409);
      const refundAmount = args?.amount?.amount ?? txn.amount - txn.refunded;
      if (refundAmount <= 0 || txn.refunded + refundAmount > txn.amount)
        throw new RpcError(-32000, "Refund exceeds captured amount", UCP_ERR("invalid_amount", `${refundAmount}`), 400);
      txn.refunded += refundAmount;
      const refundId = randomId("rfnd", 14);
      txn.refunds.push({ id: refundId, amount: refundAmount, reason: args?.reason ?? "requested_by_customer", at: new Date().toISOString() });
      txn.status = txn.refunded >= txn.amount ? "refunded" : "partially_refunded";
      log("refund_payment", `${txn.transaction_id} refunded ${refundAmount} (${txn.status})`);
      return { transaction_id: txn.transaction_id, refund_id: refundId, amount: { amount: refundAmount, currency: txn.currency }, status: txn.status, total_refunded: txn.refunded };
    },
  },

  lookup_agent: {
    description: "Know Your Agent: look up an agent's registration, KYA level, status and reputation before accepting its transactions.",
    inputSchema: { type: "object", properties: { profile_url: { type: "string" } }, required: ["profile_url"] },
    handler: async (args: any, ctx: any) => {
      const rec = agentRegistry.get(args?.profile_url);
      log("lookup_agent", `${args?.profile_url} → ${rec ? `${rec.kya_level}/${rec.status}/rep ${rec.reputation}` : "unregistered"} (asked by ${ctx.signerProfileUrl})`);
      if (!rec) return { registered: false, profile_url: args?.profile_url };
      return {
        registered: true,
        profile_url: rec.profile_url,
        name: rec.name,
        kya_level: rec.kya_level,
        status: rec.status,
        reputation: rec.reputation,
        registered_at: rec.registered_at,
      };
    },
  },

  get_payment: {
    description: "Get a transaction.",
    inputSchema: { type: "object", properties: { transaction_id: { type: "string" } }, required: ["transaction_id"] },
    handler: async (args: any) => {
      const txn = txns.get(args?.transaction_id);
      if (!txn) throw new RpcError(-32000, "Unknown transaction", UCP_ERR("not_found", String(args?.transaction_id)), 404);
      return txn;
    },
  },
};

const m4 = (creds: any) => `${creds.credentials.network} •••• ${creds.credentials.last4}`;

function makeTxn(
  p: any,
  amount: any,
  creds: any,
  mandate: PaymentMandatePayload,
  verification: Record<string, string>,
  status: Txn["status"],
  signals: any
): Txn {
  return {
    transaction_id: randomId("txn", 16),
    status,
    amount: amount.amount,
    currency: amount.currency,
    refunded: 0,
    refunds: [],
    merchant_id: p.merchant_id,
    merchant_profile: p.merchant_profile,
    checkout_id: p.checkout_id,
    network: creds.credentials.network,
    last4: creds.credentials.last4,
    token: p.credential.network_token.token,
    rail: creds.rail === "rtp" ? "rtp" : "card_network",
    agent: mandate.agent,
    mandate_jws: p.credential?.payment_mandate,
    payment_mandate_id: mandate.id,
    mandate_verification: verification,
    agent_presence: { ai_agent_involved: true, modality: mandate.human_present ? "human_present" : "human_not_present" },
    signals,
    created_at: new Date().toISOString(),
  };
}

const app = express();
app.use(express.json({ verify: rawBodySaver }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/.well-known/ucp", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: "PayStream — Payment Provider",
    ucp: {
      version: UCP_VERSION,
      services: {
        "org.ap2.payments": [
          {
            version: UCP_VERSION,
            spec: "https://ap2-protocol.org/specification",
            transport: "mcp",
            schema: "https://ap2-protocol.org/specification#payment-mandate",
            endpoint: `${URLS.paymentProvider}/mcp`,
          },
        ],
      },
      capabilities: {
        "org.ap2.payments.processing": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#payment-mandate" },
        ],
        // Know Your Agent: registration / KYA / reputation lookups
        "org.ap2.payments.agent_registry": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#payment-mandate" },
        ],
        // Multi-rail settlement: card network + RTP instant fiat
        "org.ap2.payments.multi_rail": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#payment-mandate" },
        ],
      },
      payment_handlers: {
        "com.paystream.rtp": [
          {
            id: "rtp_paystream",
            version: UCP_VERSION,
            spec: `${URLS.paymentProvider}/.well-known/ucp`,
            schema: "https://ap2-protocol.org/specification#payment-mandate",
            available_instruments: [{ type: "bank_account", constraints: { networks: ["rtp"] } }],
          },
        ],
      },
    },
    signing_keys: [serviceKey.publicJwk],
  });
});

app.post("/mcp", mcpHandler({ serverName: "payment-provider", tools: tools as any, trustedProfiles: defaultTrust }));

// 3DS challenge page — the platform frames this continue_url so the user can
// complete Strong Customer Authentication. The page posts its result
// (success / cancelled) back to the agent origin, which then resolves the
// challenge with the Credentials Provider and retries the authorization.
const AGENT_ORIGIN = new URL(URLS.shoppingAgent).origin;
app.get("/challenge/:id", (req, res) => {
  const id = String(req.params.id);
  const t = [...txns.values()].find((x) => x.challenge_id === id);
  const amount = t ? (t.amount / 100).toLocaleString("en-US", { style: "currency", currency: t.currency || "USD" }) : null;
  const card = t ? `${String(t.network || "card").toUpperCase()} ••${t.last4 || ""}` : "your card";
  // Only the agent may frame this bank page.
  res.set("Content-Security-Policy", `frame-ancestors ${AGENT_ORIGIN}`);
  res.set("Content-Type", "text/html");
  res.send(`<!doctype html><html lang=en><meta charset=utf8><title>3-D Secure</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0">
  <main role="main" style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:30px 28px;max-width:340px;text-align:center">
    <div style="font-size:12px;letter-spacing:.12em;color:#94a3b8">YOUR BANK · 3-D SECURE</div>
    <h1 style="margin:10px 0 4px;font-size:20px">Verify it's you</h1>
    <p style="color:#94a3b8;font-size:14px;line-height:1.5">A purchase by your AI shopping agent needs Strong Customer Authentication.${amount ? ` Approve <b style="color:#e2e8f0">${amount}</b> on ${card}.` : ""}</p>
    <div style="font-size:30px;margin:8px 0">🔐</div>
    <button id="ok" type="button" style="width:100%;height:46px;border:none;border-radius:12px;background:#22c55e;color:#06250f;font:600 15px system-ui;cursor:pointer">Approve</button>
    <button id="no" type="button" style="width:100%;height:40px;margin-top:8px;border:none;background:none;color:#94a3b8;font:500 13px system-ui;cursor:pointer">Cancel</button>
    <div style="color:#64748b;font-size:11px;margin-top:12px">Simulated bank step-up · challenge ${id.slice(0, 14)}…</div>
  </main>
  <script>
    var AGENT = ${JSON.stringify(AGENT_ORIGIN)}, ID = ${JSON.stringify(id)};
    function send(outcome){ try { parent.postMessage({ type: "threeds.result", challenge_id: ID, outcome: outcome }, AGENT); } catch (e) {} }
    document.getElementById("ok").onclick = function(){ this.disabled = true; this.textContent = "Approved ✓"; this.style.opacity = ".8"; send("success"); };
    document.getElementById("no").onclick = function(){ send("cancelled"); };
  </script></body></html>`);
});

app.get("/api/psp/state", (_req, res) => {
  res.json({
    key: serviceKey.publicJwk,
    transactions: [...txns.values()].reverse(),
    registry: [...agentRegistry.values()].map((r) => ({ ...r, events: r.events.slice(-12).reverse() })),
    velocity: { limit: velocityLimit, window_seconds: VELOCITY_WINDOW_MS / 1000 },
    activity: activity.slice(-200).reverse(),
  });
});

/* ---- demo admin (drives the failure scenarios; not part of the protocol) ---- */
app.post("/api/psp/registry", (req, res) => {
  const rec = agentRegistry.get(req.body?.profile_url);
  if (!rec) return res.status(404).json({ error: "not registered" });
  if (req.body?.status && ["active", "suspended"].includes(req.body.status)) {
    rec.status = req.body.status;
    rec.events.push({ ts: Date.now(), kind: "status_change", delta: 0, note: `set to ${rec.status} (registry admin)` });
    log("registry.admin", `${rec.profile_url} → ${rec.status}`);
  }
  if (Number.isFinite(Number(req.body?.reputation))) rec.reputation = Math.max(0, Math.min(100, Number(req.body.reputation)));
  res.json({ ok: true, record: { ...rec, events: undefined } });
});
// Dashboard-initiated refund (issuer credit) — same logic as the refund_payment tool.
app.post("/api/psp/refund", async (req, res) => {
  try {
    const r = await (tools.refund_payment as any).handler({ transaction_id: req.body?.transaction_id, amount: req.body?.amount, reason: "psp_dashboard" });
    res.json(r);
  } catch (e: any) {
    res.status(400).json({ error: e.message, code: e.data?.code });
  }
});

app.post("/api/psp/velocity", (req, res) => {
  if (Number.isFinite(Number(req.body?.limit))) {
    velocityLimit = Number(req.body.limit);
    velocityLog.clear();
    log("velocity.admin", `limit set to ${velocityLimit}/60s`);
  }
  res.json({ ok: true, limit: velocityLimit });
});

app.listen(PORTS.paymentProvider, () => {
  console.log(`[payment-provider] ${URLS.paymentProvider}`);
});
