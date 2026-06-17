/**
 * Credentials Provider (CP) — the user's wallet (AP2 "Credentials Provider" role).
 *
 *  - Holds the user's payment methods (PCI data never leaves this service).
 *  - Holds the user's DEVICE KEY and signs AP2 mandates upon (simulated)
 *    biometric approval on a trusted surface — the "Trusted Platform Provider"
 *    model from the UCP AP2 extension.
 *  - Mints single-use network-tokenized payment instruments (com.google.pay
 *    handler execution happens against this service in the demo).
 *  - Releases payment credentials to the PSP against a valid PaymentMandate.
 *
 * Identity: PKI only. Profile is published in the UCP envelope format
 * ({ucp:{...}, signing_keys}) so peers can discover keys and the MCP endpoint.
 * Wallet operations use the same JSON-RPC 2.0 tools/call binding as UCP.
 * Amounts are minor units (cents).
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKey, randomId, jwsSignCompact } from "../../../packages/common/src/crypto.ts";
import { sdJwtIssue, sdJwtPresent } from "../../../packages/common/src/sdjwt.ts";
import { issueDelegateRoot } from "../../../packages/common/src/dsdjwt.ts";
import { checkoutUvChallenge, checkoutJwt, checkoutJwtHash, CHECKOUT_MANDATE_VCT, PAYMENT_MANDATE_VCT } from "../../../packages/common/src/ap2.ts";
import { mcpHandler, rawBodySaver, RpcError, UCP_ERR } from "../../../packages/common/src/jsonrpc.ts";
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { b64u } from "../../../packages/common/src/crypto.ts";
import { PORTS, URLS, defaultTrust, CREDENTIALS_PROFILE_URL } from "../../../packages/common/src/config.ts";
import { UCP_VERSION } from "../../../packages/common/src/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- keys ---------------- */

const serviceKey = generateSigningKey("walletly-cp-2026");
// The user's device-bound key. With passkeys ON and a passkey enrolled, signing
// is gated by a real WebAuthn assertion (Touch ID); otherwise it is simulated.
const userDeviceKey = generateSigningKey("alex-device-key");

/* ---------------- passkey (WebAuthn) — feature-flagged, on by default ---------------- */

// PASSKEYS=0 disables; anything else (incl. unset) enables. The flow still works
// for users who never enrol — it falls back to the simulated approval.
const PASSKEYS_ENABLED = process.env.PASSKEYS !== "0";
const RP_ID = process.env.RP_ID ?? (
  URLS.credentialsProvider.startsWith("http://localhost") || URLS.credentialsProvider.startsWith("http://127.0.0.1")
    ? "localhost"
    : new URL(URLS.credentialsProvider).hostname
);
const RP_NAME = "Walletly — Credentials Provider";
// The ceremony can run from any of the app origins on localhost.
const ORIGINS = [URLS.shoppingAgent, URLS.credentialsProvider, URLS.merchantPortal, URLS.paymentProvider];

/* ---- RP-ID resolution that works on BOTH localhost and public tunnels ----
 * A passkey is scoped to its RP ID — the effective domain of the page running
 * the ceremony. On localhost that is "localhost"; behind ngrok / localtunnel it
 * is the tunnel hostname (which ngrok regenerates every run). So we never hard-
 * pin one RP ID: the wallet sheet runs the ceremony against its own
 * location.hostname, and here we re-derive the expected RP ID + origin from the
 * signed clientDataJSON, trusting it only when the host is allow-listed. */
const TUNNEL_SUFFIXES = [".ngrok-free.app", ".ngrok.app", ".ngrok.io", ".ngrok.dev", ".ngrok-free.dev", ".loca.lt", ".trycloudflare.com", ".lhr.life", ".serveo.net"];
const CONFIG_HOSTS = ORIGINS.map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean);
const EXTRA_HOSTS = (process.env.RP_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function hostAllowed(host: string): boolean {
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return true;
  if (host === RP_ID || CONFIG_HOSTS.includes(host)) return true;
  if (EXTRA_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h))) return true;
  return TUNNEL_SUFFIXES.some((sfx) => host.endsWith(sfx));
}

/** Seed RP ID for option generation (the sheet overrides it to its own host). */
function defaultRpId(hint?: string): string {
  return hint && hostAllowed(hint) ? hint : RP_ID;
}

/** Re-derive the expected RP ID + origin + clientData type from a signed
 *  WebAuthn/SPC response (clientDataJSON is parsed exactly once here). */
function expectedFrom(resp: any): { rpId: string; origin: string; type?: string } | null {
  let cd: any;
  try { cd = JSON.parse(Buffer.from(resp.response.clientDataJSON, "base64url").toString("utf8")); }
  catch { return null; }
  let u: URL;
  try { u = new URL(cd.origin); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!hostAllowed(u.hostname)) {
    console.warn(`[credentials] passkey: rejected origin '${cd.origin}' — host not in allow-list (set RP_ALLOWED_HOSTS to permit it)`);
    return null;
  }
  return { rpId: u.hostname, origin: u.origin, type: cd.type };
}

/** Find the passkey for an RP ID, falling back to the only one enrolled (demo). */
function passkeyFor(rpId: string): Passkey | undefined {
  return passkeys.get(rpId) ?? (passkeys.size === 1 ? [...passkeys.values()][0] : undefined);
}

/** Verify a WebAuthn (or SPC "payment.get") assertion over a checkout's UV challenge. */
async function verifyCheckoutAssertion(
  webauthn: any,
  expectedChallenge: string
): Promise<{ ok: boolean; error?: string; spc?: boolean; origin?: string; transport?: string; credential_id?: string }> {
  // RP ID + origin are re-derived from the signed response, so verification works
  // identically whether the ceremony ran on localhost or a public tunnel.
  sweepChallenges();
  const exp = expectedFrom(webauthn);
  const rpId = exp?.rpId ?? RP_ID;
  // Verification uses an EXACT lookup: a credential is scoped to one RP ID, so a
  // host mismatch must fail clearly here rather than later on the RP-ID hash.
  const pk = passkeys.get(rpId);
  if (!pk) return { ok: false, error: `no passkey enrolled for this host (${rpId})` };
  if (!pendingAuthChallenges.has(expectedChallenge)) {
    // Allow direct binding (challenge is deterministic from the checkout), but record it.
    pendingAuthChallenges.set(expectedChallenge, { ts: Date.now() });
  }
  try {
    const verification = await verifyAuthenticationResponse({
      response: webauthn,
      expectedChallenge,
      expectedOrigin: exp?.origin ?? ORIGINS,
      expectedRPID: exp?.rpId ?? RP_ID,
      expectedType: ["webauthn.get", "payment.get"], // SPC uses payment.get
      requireUserVerification: true,
      credential: { id: pk.id, publicKey: pk.publicKey, counter: pk.counter, transports: pk.transports as any },
    });
    if (!verification.verified) return { ok: false, error: "assertion not verified" };
    pk.counter = verification.authenticationInfo.newCounter;
    pendingAuthChallenges.delete(expectedChallenge);
    return { ok: true, spc: exp?.type === "payment.get", origin: verification.authenticationInfo.origin, credential_id: pk.id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

interface Passkey {
  id: string; // credential id (base64url)
  publicKey: Uint8Array<ArrayBuffer>; // COSE public key
  counter: number;
  transports?: string[];
  rp_id: string; // the RP ID (effective domain) this credential is scoped to
  enrolled_at: string;
}
// Keyed by RP ID, so a localhost credential and a tunnel credential can coexist
// — switching between `npm run dev` and `npm run dev:ngrok` no longer collides.
const passkeys = new Map<string, Passkey>();
const pendingRegChallenges = new Map<string, number>(); // challenge → ts
const pendingAuthChallenges = new Map<string, { checkout_id?: string; ts: number }>();
// Cancelled ceremonies never reach the success path, so prune challenges by age
// instead of leaking an entry per abandoned prompt.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
function sweepChallenges(now = Date.now()) {
  for (const [k, ts] of pendingRegChallenges) if (now - ts > CHALLENGE_TTL_MS) pendingRegChallenges.delete(k);
  for (const [k, v] of pendingAuthChallenges) if (now - v.ts > CHALLENGE_TTL_MS) pendingAuthChallenges.delete(k);
}

/* ---------------- wallet state ---------------- */

const USER = { id: "user_alex", name: "Alex Morgan", email: "alex.morgan@example.com" };

interface PaymentMethod {
  id: string;
  type: "card" | "bank_account";
  network: string;
  last4: string;
  display: string;
  exp: string;
  default: boolean;
  agentic_ready: boolean;
  /** Multi-rail settlement: which rail this method settles on. */
  rail: "card_network" | "rtp";
  /** Demo outcome trigger the PSP acts on: normal auth, 3DS challenge, or hard decline. */
  behavior: "ok" | "challenge" | "decline";
  /** PCI-side secret — never leaves the CP except to the PSP after mandate verification. */
  pan_ref: string;
}

const methods: PaymentMethod[] = [
  { id: "pm_visa_4291", type: "card", network: "visa", last4: "4291", display: "Visa •••• 4291", exp: "08/28", default: true, agentic_ready: true, rail: "card_network", behavior: "ok", pan_ref: "vault:pan:4111-xxxx-4291" },
  { id: "pm_mc_8844", type: "card", network: "mastercard", last4: "8844", display: "Mastercard •••• 8844", exp: "11/27", default: false, agentic_ready: true, rail: "card_network", behavior: "ok", pan_ref: "vault:pan:5500-xxxx-8844" },
  { id: "pm_amex_0005", type: "card", network: "amex", last4: "0005", display: "Amex •••• 0005 (3DS test)", exp: "03/29", default: false, agentic_ready: true, rail: "card_network", behavior: "challenge", pan_ref: "vault:pan:3782-xxxx-0005" },
  { id: "pm_visa_0341", type: "card", network: "visa", last4: "0341", display: "Visa •••• 0341 (declines)", exp: "06/27", default: false, agentic_ready: true, rail: "card_network", behavior: "decline", pan_ref: "vault:pan:4000-xxxx-0341" },
  // Multi-rail settlement: an RTP-capable checking account (instant fiat settlement, no card network)
  { id: "pm_rtp_checking", type: "bank_account", network: "rtp", last4: "7702", display: "FirstBank Checking •••• 7702 (RTP)", exp: "—", default: false, agentic_ready: true, rail: "rtp", behavior: "ok", pan_ref: "vault:acct:0231-xxxx-7702" },
];

/* ---------------- agent spend-control policy (programmable payment) ----------------
 * The CP is the user's consent surface, so the policy lives here and is
 * enforced where the money powers are: mint_instrument + sign_mandate. The
 * policy snapshot also travels inside the minted token so the PSP can
 * re-check independently (defense in depth, like a network-enforced scope).
 */
import type { AgentPolicy } from "../../../packages/common/src/types.ts";
import { AGENT_PROFILE_URL } from "../../../packages/common/src/config.ts";

const agentPolicy: AgentPolicy = {
  agent: AGENT_PROFILE_URL,
  autonomy: "ask_above",
  ask_above_amount: 50_000, // autonomous below $500
  per_tx_cap: 100_000, // $1,000 per transaction
  budget: 2_500_000, // $25,000 for the window (generous demo default — the meter is the feature)
  spent: 0,
  merchants_allowed: null, // any merchant
  valid_from: new Date().toISOString(),
  valid_until: new Date(Date.now() + 30 * 864e5).toISOString(),
  preferred_rail: "auto",
  updated_at: new Date().toISOString(),
};

/* ---- approval workflow: human-in-the-loop for autonomy-blocked purchases ---- */
interface Approval {
  id: string;
  checkout_id: string;
  merchant_id?: string;
  merchant_name?: string;
  amount?: number;
  currency?: string;
  summary?: string;
  status: "pending" | "approved" | "denied";
  requested_at: string;
  decided_at?: string;
}
const approvals = new Map<string, Approval>(); // by id
const approvalByCheckout = (cid?: string) => [...approvals.values()].find((a) => a.checkout_id === cid);
const APPROVAL_TTL_MS = 15 * 60 * 1000;

function approvedFor(checkout_id?: string): boolean {
  const a = approvalByCheckout(checkout_id);
  return !!a && a.status === "approved" && Date.now() - Date.parse(a.decided_at ?? a.requested_at) < APPROVAL_TTL_MS;
}

/** Evaluate the policy for a prospective payment. Amounts in minor units. */
function checkPolicy(p: { amount?: number; merchant_id?: string; human_present?: boolean; checkout_id?: string }): { ok: true } | { ok: false; code: string; detail: string } {
  const now = Date.now();
  if (now < Date.parse(agentPolicy.valid_from) || now > Date.parse(agentPolicy.valid_until))
    return { ok: false, code: "policy_window_expired", detail: `authorization window ${agentPolicy.valid_from} → ${agentPolicy.valid_until}` };
  if (p.amount != null && p.amount > agentPolicy.per_tx_cap)
    return { ok: false, code: "policy_per_tx_cap_exceeded", detail: `amount ${p.amount} > per-transaction cap ${agentPolicy.per_tx_cap} (minor units)` };
  if (p.amount != null && agentPolicy.spent + p.amount > agentPolicy.budget)
    return { ok: false, code: "policy_budget_exceeded", detail: `spent ${agentPolicy.spent} + ${p.amount} > budget ${agentPolicy.budget} (minor units)` };
  if (p.merchant_id && agentPolicy.merchants_allowed && !agentPolicy.merchants_allowed.includes(p.merchant_id))
    return { ok: false, code: "policy_merchant_not_allowed", detail: `merchant '${p.merchant_id}' not in allowlist [${agentPolicy.merchants_allowed.join(", ")}]` };
  if (p.human_present === false && !approvedFor(p.checkout_id)) {
    // An explicit user approval (inbox) waives the AUTONOMY gate for this
    // checkout — caps / budget / allowlist above still apply.
    if (agentPolicy.autonomy === "always_ask")
      return { ok: false, code: "policy_autonomy_violation", detail: "policy requires the user in-session for every purchase (always_ask)" };
    if (agentPolicy.autonomy === "ask_above" && p.amount != null && p.amount > agentPolicy.ask_above_amount)
      return { ok: false, code: "policy_autonomy_violation", detail: `autonomous purchases limited to ${agentPolicy.ask_above_amount} minor units (amount ${p.amount})` };
  }
  return { ok: true };
}

/* ---- consent audit: every policy change is logged like a mandate ---- */
interface PolicyAuditEntry { ts: string; changes: Record<string, { from: unknown; to: unknown }> }
const policyAudit: PolicyAuditEntry[] = [];

function policySnapshot() {
  return {
    per_tx_cap: agentPolicy.per_tx_cap,
    budget_remaining: Math.max(0, agentPolicy.budget - agentPolicy.spent),
    merchants_allowed: agentPolicy.merchants_allowed,
    valid_until: agentPolicy.valid_until,
    autonomy: agentPolicy.autonomy,
  };
}

interface MintedToken {
  token: string;
  method_id: string;
  network: string;
  last4: string;
  cryptogram: string;
  single_use: boolean;
  used: boolean;
  releases: number; // allow a 3DS authorize→retry pair before the token settles
  context: { checkout_id?: string; merchant_id?: string; amount?: number; currency?: string };
  /** Spend-policy snapshot bound into the token at mint time (PSP re-checks it). */
  policy: ReturnType<typeof policySnapshot>;
  rail: "card_network" | "rtp";
  revoked?: boolean; // user revoked from the wallet dashboard
  minted_at: string;
}
const tokens = new Map<string, MintedToken>();

interface SignedMandateRecord {
  kind: string;
  id: string;
  jws: string;
  format?: string;
  signed_at: string;
  approved_via: string;
  passkey_evidence?: unknown;
  summary: Record<string, unknown>;
}
const mandateLog: SignedMandateRecord[] = [];

interface LogEntry { ts: number; kind: string; summary: string; detail?: unknown }
const activity: LogEntry[] = [];
function log(kind: string, summary: string, detail?: unknown) {
  activity.push({ ts: Date.now(), kind, summary, detail });
  if (activity.length > 500) activity.shift();
  console.log(`[credentials] ${kind}: ${summary}`);
}

/* ---------------- tools (JSON-RPC 2.0 tools/call binding) ---------------- */

const tools = {
  list_payment_methods: {
    description: "List the user's agentic-ready payment methods (display data only, no PANs).",
    inputSchema: { type: "object", properties: { user: { type: "string" } } },
    handler: async (_args: any, ctx: any) => {
      log("list_payment_methods", `for ${ctx.signerProfileUrl}`);
      return {
        user: { name: USER.name, email: USER.email },
        payment_methods: methods.map(({ pan_ref: _p, ...m }) => m),
      };
    },
  },

  mint_instrument: {
    description: "Mint a single-use network token for a payment method, bound to a checkout. The raw PAN never leaves the CP.",
    inputSchema: {
      type: "object",
      properties: { method_id: { type: "string" }, context: { type: "object" } },
    },
    handler: async (args: any, ctx: any) => {
      const m = methods.find((x) => x.id === args?.method_id) ?? methods.find((x) => x.default)!;
      if (!m.agentic_ready)
        throw new RpcError(-32000, "Method not agentic-ready", UCP_ERR("method_not_tokenizable", m.id), 400);

      // --- Spend-control policy enforcement (programmable payment) ---
      const c = args?.context ?? {};
      const pv = checkPolicy({ amount: c.amount, merchant_id: c.merchant_id, human_present: c.human_present, checkout_id: c.checkout_id });
      if (!pv.ok) {
        log("policy.block", `mint refused (${pv.code}): ${pv.detail}`);
        throw new RpcError(-32000, "Refused by agent spend policy", UCP_ERR(pv.code, pv.detail), 403);
      }

      const t: MintedToken = {
        token: randomId("tok", 24),
        method_id: m.id,
        network: m.network,
        last4: m.last4,
        cryptogram: randomId("", 28).slice(1).toUpperCase(),
        single_use: true,
        used: false,
        releases: 0,
        context: c,
        policy: policySnapshot(), // agentic-token scope travels with the credential
        rail: m.rail,
        minted_at: new Date().toISOString(),
      };
      tokens.set(t.token, t);
      log("mint_instrument", `${t.token} (${m.display}, rail=${m.rail}) for checkout ${t.context.checkout_id ?? "?"} — policy OK, requested by ${ctx.signerProfileUrl}`);
      return {
        instrument: {
          type: m.rail === "rtp" ? "rtp_token" : "network_token",
          token: t.token,
          network: t.network,
          last4: t.last4,
          single_use: true,
          cryptogram: t.cryptogram,
          rail: m.rail,
        },
        handler: m.rail === "rtp" ? "com.paystream.rtp" : "com.google.pay",
        policy: t.policy,
      };
    },
  },

  sign_mandate: {
    description: "Sign an AP2 mandate (Checkout / Payment, open or closed) with the user's device key after trusted-surface approval.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string" }, payload: { type: "object" } },
      required: ["kind", "payload"],
    },
    handler: async (args: any, ctx: any) => {
      const kind: string = args?.kind;
      const payload = args?.payload;
      if (!payload || !["OpenCheckoutMandate", "OpenPaymentMandate", "PaymentMandate", "CheckoutMandate"].includes(kind))
        throw new RpcError(-32600, "kind must be one of OpenCheckoutMandate|OpenPaymentMandate|PaymentMandate|CheckoutMandate", UCP_ERR("invalid_request", String(kind)), 400);

      let jws: string;
      let id: string;
      let format = "ap2-mandate+jwt";
      // Default approval channel; upgraded to a real passkey if one is verified.
      let approvedVia = "device_biometric (simulated trusted surface)";
      let passkeyEvidence: any = undefined;

      // --- Spend-control policy enforcement at the signing surface ---
      if (kind === "PaymentMandate") {
        const merchantId = payload.payee?.id ?? String(payload.payee?.website ?? "").split("/m/")[1]?.split("/")[0];
        const pv = checkPolicy({ amount: payload.payment_amount?.amount, merchant_id: merchantId, human_present: payload.human_present, checkout_id: payload.checkout_id });
        if (!pv.ok) {
          log("policy.block", `PaymentMandate refused (${pv.code}): ${pv.detail}`);
          throw new RpcError(-32000, "Refused by agent spend policy", UCP_ERR(pv.code, pv.detail), 403);
        }
      }

      // --- Open mandates: the ROOT hop of a dSD-JWT chain, issuer-signed by the
      //     user device key. Constraint-array elements (allowed / acceptable_items)
      //     are selective disclosures; `cnf.jwk` (in the payload) names the agent
      //     key authorized to sign the closed (terminal) hop. ---
      if (kind === "OpenCheckoutMandate" || kind === "OpenPaymentMandate") {
        const sdKeys = kind === "OpenCheckoutMandate" ? ["allowed", "acceptable_items"] : ["allowed"];
        const root = issueDelegateRoot(payload, sdKeys, userDeviceKey);
        const rid = payload.id ?? randomId(kind.toLowerCase());
        mandateLog.push({ kind, id: rid, jws: root.segment, format: "dc+sd-jwt (root)", signed_at: new Date().toISOString(), approved_via: approvedVia, passkey_evidence: undefined, summary: { type: kind, vct: payload.vct, constraints: Array.isArray(payload.constraints) ? payload.constraints.length : 0 } });
        log("sign_mandate", `${kind} ${rid} signed (dSD-JWT root) — user device key`);
        return { segment: root.segment, sdJwt: root.sdJwt, kid: userDeviceKey.kid, kind, id: rid, format: "dc+sd-jwt (root)", approved_via: approvedVia };
      }

      if (kind === "CheckoutMandate") {
        // Real SD-JWT+kb: ISSUED by the CP service key, KEY-BOUND to the user
        // device key, audience = merchant profile, nonce = checkout id.
        // `sub` (user id) and `buyer_email` are selectively disclosable.
        if (!payload.aud || !payload.nonce)
          throw new RpcError(-32600, "CheckoutMandate requires aud (merchant profile) + nonce (checkout id)", UCP_ERR("invalid_request", "aud/nonce"), 400);

        // --- User Verification: real passkey (Touch ID) when one is enrolled ---
        if (PASSKEYS_ENABLED && passkeys.size > 0) {
          if (!args.webauthn)
            throw new RpcError(-32000, "User verification required", UCP_ERR("user_verification_required", "a passkey is enrolled — a Touch ID assertion is required to authorize this checkout"), 401);
          const expectedChallenge = checkoutUvChallenge(payload.checkout);
          const v = await verifyCheckoutAssertion(args.webauthn, expectedChallenge);
          if (!v.ok)
            throw new RpcError(-32000, "Passkey verification failed", UCP_ERR("user_verification_failed", v.error ?? "assertion invalid"), 401);
          approvedVia = `passkey · ${v.transport ?? "platform"} · Touch ID (UV verified, challenge bound to checkout terms)`;
          passkeyEvidence = { type: v.spc ? "spc" : "webauthn", credential_id: v.credential_id, uv: true, challenge: expectedChallenge, origin: v.origin };
          log("passkey.verify", `checkout ${payload.checkout?.id} approved via passkey (UV=1, ${passkeyEvidence.type})`);
        }
        // AP2 checkout_mandate.json requires checkout_jwt (merchant-signed JWT of
        // the Checkout) + checkout_hash. Derived from the checkout's UCP
        // merchant_authorization so the same merchant signature verifies.
        const cpCheckoutJwt = checkoutJwt(payload.checkout);
        const { sdjwt } = sdJwtIssue({
          claims: {
            vct: CHECKOUT_MANDATE_VCT,
            iss: CREDENTIALS_PROFILE_URL,
            iat: Math.floor(Date.now() / 1000),
            // exp_override (seconds) lets demos issue an already-expired mandate.
            exp: Math.floor(Date.now() / 1000) + (payload.exp_override ?? 30 * 60),
            checkout_jwt: cpCheckoutJwt,
            checkout_hash: checkoutJwtHash(cpCheckoutJwt),
            // Human-not-present: digest of the user-signed open Checkout Mandate
            // this closed mandate satisfies (absent in the direct flow).
            open_checkout_mandate: payload.open_checkout_mandate,
            human_present: payload.human_present !== false,
            checkout: payload.checkout,
          },
          disclosable: { sub: USER.id, buyer_email: USER.email },
          issuerKey: serviceKey,
          holderJwk: userDeviceKey.publicJwk,
        });
        // Holder presents, revealing sub (but withholding buyer_email by default
        // — demonstrates selective disclosure), with key binding to the merchant.
        jws = sdJwtPresent({
          sdjwt,
          revealNames: payload.reveal ?? ["sub"],
          holderKey: userDeviceKey,
          aud: payload.aud,
          nonce: payload.nonce,
        });
        id = randomId("comandate");
        format = "dc+sd-jwt~kb";
      } else if (kind === "PaymentMandate") {
        // Real SD-JWT+kb closed Payment Mandate (AP2 mandate.payment.1): issued
        // by the CP service key, KEY-BOUND to the user device key, audience =
        // merchant profile (payee), nonce = checkout id. payment_instrument is
        // selectively disclosable.
        const aud = payload.payee?.website;
        const nonce = payload.checkout_id;
        if (!aud || !nonce)
          throw new RpcError(-32600, "PaymentMandate requires payee.website (aud) + checkout_id (nonce)", UCP_ERR("invalid_request", "payee.website/checkout_id"), 400);
        const now = Math.floor(Date.now() / 1000);
        const { sdjwt } = sdJwtIssue({
          claims: {
            vct: PAYMENT_MANDATE_VCT,
            iss: CREDENTIALS_PROFILE_URL,
            iat: payload.iat ?? now,
            // exp_override (seconds) lets demos issue an already-expired mandate.
            exp: payload.exp ?? now + (payload.exp_override ?? 15 * 60),
            type: "PaymentMandate",
            id: payload.id,
            transaction_id: payload.transaction_id,
            payee: payload.payee,
            payment_amount: payload.payment_amount,
            open_payment_mandate: payload.open_payment_mandate,
            checkout_id: payload.checkout_id,
            handler: payload.handler,
            agent: payload.agent,
            rail: payload.rail,
            authorized_by: payload.authorized_by,
            human_present: payload.human_present !== false,
            issued_at: payload.issued_at,
            expires_at: payload.expires_at,
          },
          disclosable: { payment_instrument: payload.payment_instrument },
          issuerKey: serviceKey,
          holderJwk: userDeviceKey.publicJwk,
        });
        jws = sdJwtPresent({ sdjwt, revealNames: ["payment_instrument"], holderKey: userDeviceKey, aud, nonce });
        id = payload.id ?? randomId("pay");
        format = "dc+sd-jwt~kb";
      } else {
        // Open Checkout / Open Payment Mandate: user-signed (device key) compact
        // JWS. The full payload (vct, constraints[], cnf=agent key, iat, exp) is
        // built by the Shopping Agent; the CP attests it with the user's key.
        jws = jwsSignCompact(payload, userDeviceKey, "ap2-open-mandate+jwt");
        id = payload.id ?? randomId(kind.toLowerCase());
      }
      const rec: SignedMandateRecord = {
        kind,
        id,
        jws,
        format,
        signed_at: new Date().toISOString(),
        approved_via: approvedVia,
        passkey_evidence: passkeyEvidence,
        summary:
          kind === "CheckoutMandate"
            ? { checkout_id: payload.checkout?.id, total: payload.checkout?.totals?.find((t: any) => t.type === "total")?.amount, format }
            : kind === "PaymentMandate"
              ? { type: kind, ...(payload.payment_amount ?? {}) }
              : { type: kind, vct: payload.vct, constraints: Array.isArray(payload.constraints) ? payload.constraints.length : 0 },
      };
      mandateLog.push(rec);
      log("sign_mandate", `${kind} ${id} signed (${format}) — ${approvedVia.split(" ")[0]}`);
      return { jws, kid: kind === "CheckoutMandate" || kind === "PaymentMandate" ? serviceKey.kid : userDeviceKey.kid, kind, id, format, approved_via: approvedVia, passkey_evidence: passkeyEvidence };
    },
  },

  /* ---------------- agent spend-control policy ---------------- */
  get_agent_policy: {
    description: "Read the user's spend-control policy for this agent (caps, budget, allowlist, autonomy, rail preference).",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: any, ctx: any) => {
      log("get_agent_policy", `read by ${ctx.signerProfileUrl}`);
      return { policy: agentPolicy };
    },
  },

  /* ---------------- approval workflow (human-in-the-loop) ---------------- */
  request_approval: {
    description: "Ask the user to approve an autonomy-blocked purchase (appears in the Walletly approval inbox).",
    inputSchema: { type: "object", properties: { checkout_id: { type: "string" }, amount: { type: "number" }, currency: { type: "string" }, merchant_id: { type: "string" }, merchant_name: { type: "string" }, summary: { type: "string" } }, required: ["checkout_id"] },
    handler: async (args: any, ctx: any) => {
      const existing = approvalByCheckout(args.checkout_id);
      if (existing) return { approval_id: existing.id, status: existing.status };
      const a: Approval = {
        id: randomId("appr", 12),
        checkout_id: args.checkout_id,
        merchant_id: args.merchant_id,
        merchant_name: args.merchant_name,
        amount: args.amount,
        currency: args.currency ?? "USD",
        summary: args.summary,
        status: "pending",
        requested_at: new Date().toISOString(),
      };
      approvals.set(a.id, a);
      log("approval.requested", `${a.id} — ${a.summary ?? a.checkout_id} (${((a.amount ?? 0) / 100).toFixed(2)} ${a.currency}) by ${ctx.signerProfileUrl}`);
      return { approval_id: a.id, status: a.status };
    },
  },
  check_approval: {
    description: "Check the status of a pending purchase approval.",
    inputSchema: { type: "object", properties: { approval_id: { type: "string" }, checkout_id: { type: "string" } } },
    handler: async (args: any) => {
      const a = (args?.approval_id && approvals.get(args.approval_id)) || approvalByCheckout(args?.checkout_id);
      if (!a) return { status: "none" };
      return { approval_id: a.id, status: a.status, decided_at: a.decided_at };
    },
  },

  /* ---------------- passkeys (WebAuthn / SPC) ---------------- */
  passkey_status: {
    description: "Whether passkey user-verification is enabled and whether the user has enrolled one for the RP ID / host in use.",
    inputSchema: { type: "object", properties: { rp_id: { type: "string" } } },
    handler: async (args: any) => {
      const rpId = defaultRpId(args?.rp_id);
      const pk = passkeyFor(rpId);
      return {
        enabled: PASSKEYS_ENABLED,
        enrolled: !!pk,
        rp_id: pk?.rp_id ?? rpId,
        credential_id: pk?.id ?? null,
        user: { id: USER.id, name: USER.name },
      };
    },
  },
  passkey_register_options: {
    description: "Get WebAuthn registration options to enrol a passkey (navigator.credentials.create), steered to the platform authenticator (macOS Touch ID).",
    inputSchema: { type: "object", properties: { rp_id: { type: "string" } } },
    handler: async (args: any) => {
      sweepChallenges();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: defaultRpId(args?.rp_id),
        userName: USER.email,
        userDisplayName: USER.name,
        attestationType: "none",
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        // "localDevice" emits hints:["client-device"] AND authenticatorAttachment:
        // "platform" — telling the browser to enrol the BUILT-IN platform
        // authenticator (Touch ID) and not hand the ceremony to a password-manager
        // extension (e.g. LastPass), which otherwise auto-grabs it on https origins.
        preferredAuthenticatorType: "localDevice",
        supportedAlgorithmIDs: [-7, -257],
      });
      pendingRegChallenges.set(options.challenge, Date.now());
      log("passkey.register_options", `issued registration challenge (rp=${options.rp.id})`);
      return { options };
    },
  },
  passkey_register: {
    description: "Verify a WebAuthn registration response and enrol the user's passkey (scoped to the host the ceremony ran on).",
    inputSchema: { type: "object", properties: { response: { type: "object" }, challenge: { type: "string" }, rp_id: { type: "string" } }, required: ["response"] },
    handler: async (args: any) => {
      sweepChallenges();
      // Require the EXACT challenge this response was issued for — no "use the last
      // one" fallback (that weakened the binding and broke concurrent enrolments).
      const challenge = args?.challenge ?? args?.response?.response?.challenge;
      if (!challenge || !pendingRegChallenges.has(challenge))
        throw new RpcError(-32000, "No matching registration challenge", UCP_ERR("invalid_request", "call passkey_register_options first — the challenge is unknown, expired, or already used"), 400);
      const expectedChallenge = challenge;
      // RP ID + origin come from the signed response → works on localhost & tunnels.
      const exp = expectedFrom(args.response);
      const rpId = exp?.rpId ?? defaultRpId(args?.rp_id);
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: args.response,
          expectedChallenge,
          expectedOrigin: exp?.origin ?? ORIGINS,
          expectedRPID: rpId,
          requireUserVerification: true,
        });
      } catch (e: any) {
        throw new RpcError(-32000, "Registration verification failed", UCP_ERR("registration_failed", e.message), 400);
      }
      pendingRegChallenges.delete(expectedChallenge);
      if (!verification.verified || !verification.registrationInfo) throw new RpcError(-32000, "Registration not verified", UCP_ERR("registration_failed", "unverified"), 400);
      const info = verification.registrationInfo;
      const pk: Passkey = {
        id: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: args.response?.response?.transports,
        rp_id: rpId,
        enrolled_at: new Date().toISOString(),
      };
      passkeys.set(rpId, pk);
      log("passkey.register", `enrolled passkey ${pk.id.slice(0, 14)}… for rp=${rpId} (UV=${verification.registrationInfo.userVerified})`);
      return { enrolled: true, credential_id: pk.id, rp_id: rpId };
    },
  },
  /** Provide the get() parameters for a checkout: challenge bound to its terms + allowed credential. */
  passkey_auth_options: {
    description: "Get WebAuthn/SPC parameters to authorize a checkout (challenge bound to the checkout terms + allowCredentials), steered to the platform authenticator (macOS Touch ID).",
    inputSchema: { type: "object", properties: { uv_challenge: { type: "string" }, checkout_id: { type: "string" }, rp_id: { type: "string" } }, required: ["uv_challenge"] },
    handler: async (args: any) => {
      sweepChallenges();
      const rpId = defaultRpId(args?.rp_id);
      // Exact lookup — allowCredentials must reference a credential scoped to THIS
      // host, otherwise the authenticator surfaces nothing for the user.
      const pk = passkeys.get(rpId);
      if (!pk) throw new RpcError(-32000, "No passkey enrolled for this host", UCP_ERR("not_enrolled", `enrol a passkey on ${rpId} first`), 400);
      pendingAuthChallenges.set(args.uv_challenge, { checkout_id: args.checkout_id, ts: Date.now() });
      // Build a standard PublicKeyCredentialRequestOptionsJSON whose challenge is
      // the checkout's UV challenge (raw hash bytes → base64url == uv_challenge).
      const optionsJSON = await generateAuthenticationOptions({
        rpID: pk.rp_id,
        challenge: new Uint8Array(b64u.decode(args.uv_challenge)),
        allowCredentials: [{ id: pk.id, transports: pk.transports as any }],
        userVerification: "required",
      });
      // hints:["client-device"] keeps the get() ceremony on the built-in platform
      // authenticator (Touch ID) rather than a password-manager extension (LastPass).
      optionsJSON.hints = ["client-device"];
      const m = methods.find((x) => x.default);
      return {
        rp_id: pk.rp_id,
        uv_challenge: args.uv_challenge,
        options: optionsJSON, // for @simplewebauthn/browser startAuthentication
        // SPC payment display (Chrome native sheet): amount + instrument
        payment: { credential_id: pk.id, last4: m?.last4, network: m?.network },
      };
    },
  },

  release_credentials: {
    description: "PSP → CP (AP2 steps 26–27): release payment credentials against a previously minted single-use token.",
    inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    handler: async (args: any, ctx: any) => {
      const t = tokens.get(args?.token);
      if (!t) throw new RpcError(-32000, "Unknown token", UCP_ERR("token_not_found", String(args?.token)), 401);
      if (t.revoked) throw new RpcError(-32000, "Token revoked by the user", UCP_ERR("token_revoked", t.token), 401);
      // Single-use, but a 3DS authorize→retry pair counts as one settlement (≤2 releases).
      if (t.used && t.releases >= 2)
        throw new RpcError(-32000, "Token already used", UCP_ERR("token_replayed", t.token), 401);
      t.used = true;
      t.releases += 1;
      // Budget accounting happens HERE — when credentials actually move toward
      // settlement (like an auth hold). Purchases blocked earlier (policy, KYA,
      // tamper, expired mandates) never consume budget; a 3DS retry re-release
      // of the same token is not double-counted.
      if (t.releases === 1) agentPolicy.spent += t.context.amount ?? 0;
      const m = methods.find((x) => x.id === t.method_id)!;
      log("release_credentials", `released for ${t.token} (${m.display}, rail=${t.rail}, behavior=${m.behavior}) to ${ctx.signerProfileUrl}`);
      return {
        credentials: { pan_ref: m.pan_ref, network: m.network, last4: m.last4, exp: m.exp },
        // Demo outcome trigger so the PSP can model 3DS / declines deterministically.
        behavior: m.behavior,
        context: t.context,
        // Token-bound scope + rail for the PSP's independent re-check (defense in depth).
        policy: t.policy,
        rail: t.rail,
      };
    },
  },

  resolve_challenge: {
    description: "User completes a step-up challenge (3DS) on the CP's trusted surface; returns an attestation the PSP trusts.",
    inputSchema: { type: "object", properties: { challenge_id: { type: "string" }, outcome: { type: "string" } }, required: ["challenge_id"] },
    handler: async (args: any, ctx: any) => {
      const outcome = args?.outcome ?? "success";
      log("resolve_challenge", `${args?.challenge_id} → ${outcome} for ${ctx.signerProfileUrl}`);
      return {
        challenge_id: args?.challenge_id,
        outcome,
        attestation: outcome === "success" ? randomId("3ds_att", 24) : null,
        attested_at: new Date().toISOString(),
      };
    },
  },
};

/* ---------------- express app ---------------- */

const app = express();
app.use(express.json({ verify: rawBodySaver }));

/* ---- Payment-sheet framing policy (Google-Pay-style sandboxed iframe) ----
 * Only the sheet (and its assets) may be framed, and ONLY by the shopping
 * agent origin; everything else (the Walletly dashboard) refuses framing.
 * The sheet document also grants itself payment + WebAuthn explicitly. */
const AGENT_ORIGIN = new URL(URLS.shoppingAgent).origin;
const SHEET_PATHS = new Set(["/sheet.html", "/sheet-config.js", "/passkey-client.js"]);
app.use((req, res, next) => {
  if (SHEET_PATHS.has(req.path)) {
    res.set("Content-Security-Policy", `frame-ancestors ${AGENT_ORIGIN}`);
    res.set("Permissions-Policy", "payment=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)");
  } else {
    res.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  next();
});

// Injects the exact agent origin the sheet must pin all postMessage traffic to.
app.get("/sheet-config.js", (_req, res) => {
  res.type("application/javascript").send(`window.AGENT_ORIGIN=${JSON.stringify(AGENT_ORIGIN)};`);
});

app.use(express.static(path.join(__dirname, "../public")));

// Profile in the UCP envelope format (PKI key discovery + endpoint resolution)
app.get("/.well-known/ucp", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    name: "Walletly — Credentials Provider",
    ucp: {
      version: UCP_VERSION,
      services: {
        "org.ap2.credentials": [
          {
            version: UCP_VERSION,
            spec: "https://ap2-protocol.org/specification",
            transport: "mcp",
            schema: "https://ap2-protocol.org/specification#mandates",
            endpoint: `${URLS.credentialsProvider}/mcp`,
          },
        ],
      },
      capabilities: {
        "org.ap2.mandates.signing": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#mandates" },
        ],
        "org.ap2.credentials.tokenization": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#payment-mandate" },
        ],
        // Spend controls & programmable payment: per-agent consent policy
        // (caps, budget, allowlist, autonomy) enforced at mint + sign.
        "org.ap2.credentials.spend_policy": [
          { version: UCP_VERSION, spec: "https://ap2-protocol.org/specification", schema: "https://ap2-protocol.org/specification#autonomous-human-not-present" },
        ],
      },
      payment_handlers: {
        "com.google.pay": [
          {
            id: "gpay_wallet",
            version: UCP_VERSION,
            spec: "https://developers.google.com/merchant/ucp/guides/gpay-payment-handler",
            schema: "https://pay.google.com/gp/p/ucp/2026-01-11/schemas/gpay_config.json",
            available_instruments: [{ type: "card", constraints: { brands: ["visa", "mastercard"] } }],
          },
        ],
        // Multi-rail settlement: RTP (instant bank transfer) instruments
        "com.paystream.rtp": [
          {
            id: "rtp_wallet",
            version: UCP_VERSION,
            spec: `${URLS.paymentProvider}/.well-known/ucp`,
            schema: "https://ap2-protocol.org/specification#payment-mandate",
            available_instruments: [{ type: "bank_account", constraints: { networks: ["rtp"] } }],
          },
        ],
      },
    },
    signing_keys: [serviceKey.publicJwk, userDeviceKey.publicJwk],
  });
});

app.post("/mcp", mcpHandler({ serverName: "credentials-provider", tools: tools as any, trustedProfiles: defaultTrust }));

// Known merchants (for the allowlist autocomplete) — fetched server-side from
// the merchant portal so the dashboard needs no cross-origin call.
app.get("/api/wallet/merchants", async (_req, res) => {
  try {
    const r = await fetch(`${URLS.merchantPortal}/api/portal/state`);
    const j: any = await r.json();
    res.json({ merchants: (j.merchants ?? []).map((m: any) => ({ id: m.id, name: m.name, color: m.color })) });
  } catch {
    res.json({ merchants: [] });
  }
});

// Agent-permissions panel (same-origin dashboard) — the user edits the policy here.
app.post("/api/wallet/policy", (req, res) => {
  const b = req.body ?? {};
  const before = JSON.parse(JSON.stringify(agentPolicy));
  const num = (v: any, cur: number) => (Number.isFinite(Number(v)) ? Number(v) : cur);
  if (b.autonomy && ["always_ask", "ask_above", "autonomous"].includes(b.autonomy)) agentPolicy.autonomy = b.autonomy;
  agentPolicy.ask_above_amount = num(b.ask_above_amount, agentPolicy.ask_above_amount);
  agentPolicy.per_tx_cap = num(b.per_tx_cap, agentPolicy.per_tx_cap);
  agentPolicy.budget = num(b.budget, agentPolicy.budget);
  if (b.reset_spent) agentPolicy.spent = 0;
  if (b.merchants_allowed !== undefined) agentPolicy.merchants_allowed = Array.isArray(b.merchants_allowed) && b.merchants_allowed.length ? b.merchants_allowed : null;
  if (b.valid_until) agentPolicy.valid_until = b.valid_until;
  if (b.preferred_rail && ["card_network", "rtp", "auto"].includes(b.preferred_rail)) agentPolicy.preferred_rail = b.preferred_rail;
  agentPolicy.updated_at = new Date().toISOString();
  // Consent audit: record exactly what changed (the user's consent history).
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["autonomy", "ask_above_amount", "per_tx_cap", "budget", "spent", "merchants_allowed", "valid_until", "preferred_rail"] as const) {
    if (JSON.stringify((before as any)[k]) !== JSON.stringify((agentPolicy as any)[k]))
      changes[k] = { from: (before as any)[k], to: (agentPolicy as any)[k] };
  }
  if (Object.keys(changes).length) policyAudit.push({ ts: agentPolicy.updated_at, changes });
  if (policyAudit.length > 100) policyAudit.shift();
  log("policy.update", `autonomy=${agentPolicy.autonomy} per_tx=${agentPolicy.per_tx_cap} budget=${agentPolicy.budget} merchants=${agentPolicy.merchants_allowed ?? "any"} rail=${agentPolicy.preferred_rail}`);
  res.json({ policy: agentPolicy });
});

// Approval inbox: the user decides on autonomy-blocked purchases here.
app.post("/api/wallet/approval", (req, res) => {
  const a = approvals.get(req.body?.id);
  if (!a) return res.status(404).json({ error: "unknown approval" });
  if (a.status === "pending" && ["approved", "denied"].includes(req.body?.decision)) {
    a.status = req.body.decision;
    a.decided_at = new Date().toISOString();
    log("approval." + a.status, `${a.id} — ${a.summary ?? a.checkout_id} ($${((a.amount ?? 0) / 100).toFixed(2)})`);
  }
  res.json({ approval: a });
});

// Passkey management: the user can remove an enrolled passkey (one host, or all).
app.post("/api/wallet/passkey/remove", (req, res) => {
  const rpId = req.body?.rp_id;
  if (rpId && passkeys.has(rpId)) {
    log("passkey.removed", `credential for rp=${rpId} removed by the user`);
    passkeys.delete(rpId);
  } else {
    if (passkeys.size) log("passkey.removed", `${passkeys.size} passkey(s) removed by the user`);
    passkeys.clear();
  }
  res.json({ ok: true });
});

// Token control: revoke an active single-use token (release will be refused).
app.post("/api/wallet/token/revoke", (req, res) => {
  const t = tokens.get(req.body?.token);
  if (!t) return res.status(404).json({ error: "unknown token" });
  t.revoked = true;
  log("token.revoked", `${t.token} revoked by the user (checkout ${t.context.checkout_id ?? "?"})`);
  res.json({ ok: true });
});

app.get("/api/wallet/state", (_req, res) => {
  res.json({
    user: USER,
    keys: { service: serviceKey.publicJwk, user_device: userDeviceKey.publicJwk },
    passkey: { enabled: PASSKEYS_ENABLED, enrolled: passkeys.size > 0, rp_id: RP_ID, enrolled_rp_ids: [...passkeys.keys()], credential_id: [...passkeys.values()][0]?.id ?? null, enrolled_at: [...passkeys.values()][0]?.enrolled_at },
    policy: agentPolicy,
    policy_audit: policyAudit.slice().reverse(),
    approvals: [...approvals.values()].reverse(),
    payment_methods: methods.map(({ pan_ref: _p, ...m }) => m),
    tokens: [...tokens.values()],
    mandates: mandateLog.slice().reverse(),
    activity: activity.slice(-200).reverse(),
  });
});

app.listen(PORTS.credentialsProvider, () => {
  console.log(`[credentials-provider] ${URLS.credentialsProvider} — user device key: ${userDeviceKey.kid}`);
});
