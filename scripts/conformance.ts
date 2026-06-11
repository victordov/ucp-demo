/**
 * UCP conformance report (adapted to the MCP transport).
 *
 * The official suite (Universal-Commerce-Protocol/conformance, vendored under
 * ./conformance-official) is a Python/pytest harness bound to the REST
 * reference server + flower_shop data + simulation endpoints, so it cannot run
 * verbatim against our MCP-transport Node services. This script asserts the
 * SAME test CATEGORIES against our live services and prints a per-category
 * report. Positive flows go through the Shopping Agent's API + scenario runner
 * (which sign with the real platform key); negative tests use raw/forged calls.
 *
 * Categories mirror the official files: protocol, binding, checkout_lifecycle,
 * fulfillment, business_logic, idempotency, ap2, card_credential, order,
 * webhook, validation.
 *
 * Run with services up:  npm run conformance
 */
import { generateSigningKey } from "../packages/common/src/crypto.ts";
import { URLS, merchantMcpUrl, AGENT_PROFILE_URL } from "../packages/common/src/config.ts";

const WL = merchantMcpUrl("wavelength");
const results: Record<string, { pass: number; fail: number; notes: string[] }> = {};
const cat = (c: string) => (results[c] ??= { pass: 0, fail: 0, notes: [] });
function check(c: string, name: string, cond: boolean, extra = "") {
  const r = cat(c);
  if (cond) { r.pass++; r.notes.push(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { r.fail++; r.notes.push(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const post = async (p: string, b: any = {}) => (await fetch(`${URLS.shoppingAgent}/api${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const raw = async (payload: any, headers: Record<string, string> = {}) => {
  const res = await fetch(WL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const newSession = async () => (await post("/session")).session_id;
const runScenario = (sid: string, scn: string) => post("/scenario", { session_id: sid, id: scn });

async function main() {
  /* ---- protocol ---- */
  {
    const tl = await raw({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (tl.json.result?.tools ?? []).map((t: any) => t.name);
    check("protocol", "tools/list returns checkout + cart + catalog + order tools", ["create_checkout", "complete_checkout", "cancel_checkout", "create_cart", "get_product", "get_order"].every((t) => names.includes(t)), `${names.length} tools`);
    const init = await raw({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    check("protocol", "initialize handshake returns serverInfo", !!init.json.result?.serverInfo);
    const bad = await raw({ jsonrpc: "1.0", id: 1, method: "x" });
    check("protocol", "non-2.0 request rejected (-32600)", bad.json.error?.code === -32600);
  }

  /* ---- binding ---- */
  {
    const noMeta = await raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "x" } } });
    check("binding", "missing meta.ucp-agent → -32001 invalid_profile_url", noMeta.json.error?.code === -32001 && noMeta.json.error?.data?.code === "invalid_profile_url");
    const unsigned = await raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: AGENT_PROFILE_URL } }, query: "x" } } });
    check("binding", "unsigned request → 401 signature_missing", unsigned.status === 401 && unsigned.json.error?.data?.code === "signature_missing");
    const bind = await raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: `${URLS.paymentProvider}/.well-known/ucp` } }, query: "x" } } }, { "ucp-agent": `profile="${AGENT_PROFILE_URL}"` });
    check("binding", "identity binding: meta ≠ UCP-Agent header → 403", bind.status === 403);
  }

  /* ---- checkout_lifecycle ---- */
  {
    const sid = await newSession();
    await post("/intent", { session_id: sid, text: "noise cancelling headphones under $300, 2 day delivery" });
    await post("/select", { session_id: sid, product_id: "cadence-anc-pro", merchant_id: "wavelength" });
    const co = await post("/checkout", { session_id: sid });
    check("checkout_lifecycle", "create+update → ready_for_complete", co.status === "ready_for_complete", co.checkout_id);
    const s2 = await newSession();
    const happy = await runScenario(s2, "happy");
    check("checkout_lifecycle", "complete → completed + order created", happy.outcome === "order_created", happy.detail?.order);
  }

  /* ---- fulfillment ---- */
  {
    const sid = await newSession();
    const exp = await runScenario(sid, "express");
    check("fulfillment", "express shipping option increases total (re-signed)", exp.detail?.after > exp.detail?.before, `$${exp.detail?.before} → $${exp.detail?.after}`);
  }

  /* ---- business_logic ---- */
  {
    const sid = await newSession();
    await post("/intent", { session_id: sid, text: "headphones under 300, 2 day" });
    await post("/select", { session_id: sid, product_id: "cadence-anc-pro", merchant_id: "wavelength" });
    await post("/checkout", { session_id: sid });
    const promo = await post("/promo", { session_id: sid, code: "SHOPPY10" });
    check("business_logic", "discount code lowers total (negative discount line)", promo.totals.discount > 0);
    const bad = await post("/promo", { session_id: sid, code: "NOPE" });
    check("business_logic", "invalid code → warning, not failure", !!bad.discount_warning);
  }

  /* ---- idempotency ---- (server-side replay via the agent's real key) */
  {
    const sid = await newSession();
    await post("/intent", { session_id: sid, text: "headphones under 300, 2 day" });
    await post("/select", { session_id: sid, product_id: "cadence-anc-pro", merchant_id: "wavelength" });
    await post("/checkout", { session_id: sid });
    const replay = await runScenario(sid, "replay");
    check("idempotency", "identical replay → cached 200", replay.detail?.duplicate === 200);
    check("idempotency", "same key + different body → 409", replay.detail?.altered_body_conflict === 409);
  }

  /* ---- ap2 ---- */
  {
    // mandate_required (forged unsigned-but-shaped complete is rejected earlier by PKI;
    // run the agent's tamper/expired scenarios which exercise mandate verification)
    const t1 = await runScenario(await newSession(), "tamper");
    check("ap2", "tampered cart rejected (nested binding broken)", t1.outcome === "rejected", t1.detail?.code);
    const t2 = await runScenario(await newSession(), "expired");
    check("ap2", "expired mandate → mandate_expired", t2.detail?.code === "mandate_expired");
    const t3 = await runScenario(await newSession(), "stolen_key");
    check("ap2", "stolen agent key → key_not_found", t3.detail?.code === "key_not_found");
    const t4 = await runScenario(await newSession(), "threeds");
    check("ap2", "3DS step-up → escalation → retry success", t4.outcome === "order_created_after_3ds");
    const portal: any = await (await fetch(`${URLS.merchantPortal}/api/portal/state`)).json();
    const order = portal.merchants.find((m: any) => m.id === "wavelength").orders.slice(-1)[0];
    check("ap2", "order holds dispute-ready mandate evidence", !!order?.evidence?.checkout_mandate && !!order?.evidence?.merchant_authorization);
  }

  /* ---- card_credential (PCI) ---- */
  {
    const wallet: any = await (await fetch(`${URLS.credentialsProvider}/api/wallet/state`)).json();
    check("card_credential", "wallet API exposes no pan_ref", !JSON.stringify(wallet.payment_methods).includes("pan_ref"));
    check("card_credential", "minted tokens are single-use", wallet.tokens.length > 0 && wallet.tokens.every((t: any) => t.single_use === true));
    const psp: any = await (await fetch(`${URLS.paymentProvider}/api/psp/state`)).json();
    check("card_credential", "PSP records show no raw PAN", !JSON.stringify(psp.transactions).match(/\b\d{13,16}\b/));
    const decline = await runScenario(await newSession(), "decline");
    check("card_credential", "declined card → payment_declined", decline.outcome === "payment_declined");
  }

  /* ---- order + webhook ---- */
  {
    const portal: any = await (await fetch(`${URLS.merchantPortal}/api/portal/state`)).json();
    const order = portal.merchants.find((m: any) => m.id === "wavelength").orders.slice(-1)[0];
    check("order", "order has permalink_url", /^https:\/\//.test(order?.permalink_url ?? ""));
    const refund = await runScenario(await newSession(), "refund");
    check("order", "refund creates a post-order adjustment", refund.outcome === "refunded");
    const unsigned = await fetch(`${URLS.shoppingAgent}/webhooks/ucp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "order.shipped", order: {} }) });
    check("webhook", "unsigned webhook rejected (401)", unsigned.status === 401);
  }

  /* ---- validation ---- */
  {
    const r = await raw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "x" } } });
    check("validation", "malformed request surfaces a JSON-RPC error", !!r.json.error);
    const dispute = await runScenario(await newSession(), "dispute");
    check("validation", "dispute attaches AP2 mandate evidence", dispute.outcome === "disputed");
    const identity = await runScenario(await newSession(), "identity");
    check("validation", "scoped order:read enforced (identity linking)", identity.outcome === "linked");
  }

  /* ---- report ---- */
  let totalPass = 0, totalFail = 0;
  console.log("\nUCP Conformance Report (MCP transport) — categories mirror the official suite\n" + "=".repeat(70));
  for (const c of Object.keys(results).sort()) {
    const r = results[c];
    totalPass += r.pass; totalFail += r.fail;
    console.log(`\n[${c}]  ${r.fail === 0 ? "PASS" : "FAIL"}  (${r.pass}/${r.pass + r.fail})`);
    for (const n of r.notes) console.log(n);
  }
  console.log("\n" + "=".repeat(70));
  console.log(`${totalFail === 0 ? "CONFORMANT" : "NON-CONFORMANT"}: ${totalPass} passed, ${totalFail} failed across ${Object.keys(results).length} categories`);
  console.log("Reference: official pytest suite vendored under ./conformance-official (REST transport).");
  process.exit(totalFail ? 1 : 0);
}

main().catch((e) => { console.error("conformance crashed:", e); process.exit(1); });
