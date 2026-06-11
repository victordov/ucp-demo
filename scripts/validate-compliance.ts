/**
 * Deep UCP compliance validator.
 *
 * 1. URL audit — every https URL referenced in our source that points at
 *    ucp.dev schemas/specs/services is resolved against the OFFICIAL schema
 *    tree vendored in ./schemas (cloned from Universal-Commerce-Protocol/ucp,
 *    which is the source of truth for what ucp.dev serves).
 * 2. $ref crawl — all vendored schemas are loaded into Ajv (draft 2020-12)
 *    and every $ref is resolved recursively; a missing/broken ref fails.
 * 3. Live payload validation — runs the real flow through the Shopping Agent,
 *    captures the raw wire artifacts, and validates them against the official
 *    schemas COMPOSED per the spec's Resolution Flow (base checkout + active
 *    extension $defs via allOf):
 *      - business profiles  → profile.json#/$defs/business_schema
 *      - platform profile   → profile.json#/$defs/platform_schema
 *      - checkout responses → checkout.json + fulfillment + ap2_mandate $defs
 *      - catalog responses  → catalog_search.json#/$defs/search_response
 *      - order webhook      → order.json
 *
 * Usage: services running → `npm run validate`
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URLS, merchantProfileUrl } from "../packages/common/src/config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(__dirname, "../schemas");
const SRC_DIRS = [path.join(__dirname, "../packages"), path.join(__dirname, "../apps"), __dirname];

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ---------------- 1. load vendored official schemas ---------------- */

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".json")) yield p;
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv as any);
// UCP schemas use custom annotation keywords:
for (const kw of ["ucp_request", "name", "version"]) ajv.addKeyword({ keyword: kw });

const schemaFiles: { file: string; id: string }[] = [];
for (const file of walk(SCHEMA_DIR)) {
  if (file.includes(`${path.sep}services${path.sep}`)) continue; // OpenRPC/OpenAPI docs, not JSON Schemas
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!doc.$id) continue;
  ajv.addSchema(doc);
  schemaFiles.push({ file: path.relative(SCHEMA_DIR, file), id: doc.$id });
}

console.log(`\n— 1. Official schema tree ($ref crawl over ${schemaFiles.length} vendored schemas)`);
let refsOk = true;
let refErr = "";
for (const { id } of schemaFiles) {
  try {
    ajv.getSchema(id); // compiles + resolves every $ref recursively
  } catch (e: any) {
    refsOk = false;
    refErr = `${id}: ${e.message}`;
    break;
  }
}
check("every $ref in the official schema tree resolves recursively", refsOk, refErr);

/* ---------------- 2. URL audit across our source ---------------- */

console.log("\n— 2. URL audit (every ucp.dev reference in our code must exist in the official tree)");
const urlRe = /https:\/\/[^\s"'`<>)\]]+/g;
const found = new Set<string>();
for (const dir of SRC_DIRS) {
  for (const file of walk2(dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.match(urlRe) ?? []) {
      const u = m.replace(/[.,;]$/, "");
      if (!u.includes("${")) found.add(u); // skip template literals (audited via live profiles below)
    }
  }
}
function* walk2(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !["node_modules", "public", "base"].includes(e.name)) yield* walk2(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}
const ucpUrls = [...found].filter((u) => u.startsWith("https://ucp.dev/"));
const badUrls: string[] = [];
for (const u of ucpUrls) {
  const m = u.match(/^https:\/\/ucp\.dev\/(?:\d{4}-\d{2}-\d{2}\/)?(schemas|services|specification)\/([^#?]*)/);
  if (!m) continue;
  const [, kind, rest] = m;
  if (kind === "specification") continue; // human-readable docs pages — checked separately below
  const local = path.join(SCHEMA_DIR, kind === "schemas" ? rest : path.join("services", rest));
  if (!fs.existsSync(local)) badUrls.push(u);
}
check(`all ${ucpUrls.length} ucp.dev schema/service URLs map to real files in the official tree`, badUrls.length === 0, badUrls.join(", ") || "");

const specPages = [...found].filter((u) => /ucp\.dev\/(?:\d{4}-\d{2}-\d{2}\/)?specification\//.test(u));
// specification pages: verify against the docs tree of the official repo if present, else skip
const docsDir = "/tmp/ucp/docs/specification";
if (fs.existsSync(docsDir)) {
  const badSpecs = specPages.filter((u) => {
    const page = u.match(/specification\/([^#?]*)/)?.[1]?.replace(/\/$/, "");
    if (!page) return false;
    return !(
      fs.existsSync(path.join(docsDir, `${page}.md`)) ||
      fs.existsSync(path.join(docsDir, page, "index.md")) ||
      fs.existsSync(path.join(docsDir, `${page}/index.md`)) ||
      fs.existsSync(path.join(docsDir, page + ".md"))
    );
  });
  check(`all ${specPages.length} ucp.dev specification page URLs exist in the official docs tree`, badSpecs.length === 0, badSpecs.join(", "));
} else {
  console.log("  (skipped specification-page check: /tmp/ucp/docs not present)");
}

const externalUrls = [...found].filter(
  (u) => !u.startsWith("https://ucp.dev/") && !u.includes("localhost") && !u.includes(".example")
);
console.log(`  ℹ external (non-ucp.dev) URLs referenced: ${externalUrls.length}`);
for (const u of externalUrls.sort()) console.log(`    - ${u}`);

/* ---------------- 3. live payload validation ---------------- */

const ID = (p: string) => `https://ucp.dev/schemas/${p}`;

// Composed checkout schema per the spec Resolution Flow:
// base checkout + $defs["dev.ucp.shopping.checkout"] of each active extension.
ajv.addSchema({
  $id: "local://composed-checkout",
  allOf: [
    { $ref: ID("shopping/checkout.json") },
    { $ref: ID("shopping/fulfillment.json") + "#/$defs/dev.ucp.shopping.checkout" },
    { $ref: ID("shopping/ap2_mandate.json") + "#/$defs/dev.ucp.shopping.checkout" },
  ],
});

function validate(name: string, schemaRef: string, data: unknown) {
  const v = ajv.getSchema(schemaRef);
  if (!v) {
    check(name, false, `schema not found: ${schemaRef}`);
    return;
  }
  const ok = v(data) as boolean;
  const errs = (v.errors ?? [])
    .map((e: any) => `${e.instancePath || "/"} ${e.message}`)
    .filter((msg: string, i: number, a: string[]) => a.indexOf(msg) === i)
    .slice(0, 6);
  check(name, ok, ok ? "" : errs.join(" · "));
}

async function api(p: string, body: Record<string, unknown>) {
  const res = await fetch(`${URLS.shoppingAgent}/api${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${p}: ${json.error}`);
  return json;
}

/** Walk a live JSON document and verify every embedded ucp.dev URL exists in the official tree. */
function auditDocUrls(name: string, doc: unknown) {
  const bad: string[] = [];
  const seen = new Set<string>();
  (function walkJson(v: unknown) {
    if (typeof v === "string") {
      const m = v.match(/^https:\/\/ucp\.dev\/(?:\d{4}-\d{2}-\d{2}\/)?(schemas|services|specification)\/([^#?]*)/);
      if (!m || seen.has(v)) return;
      seen.add(v);
      const [, kind, rest] = m;
      if (kind === "specification") {
        const page = rest.replace(/\/$/, "");
        if (fs.existsSync(docsDir) && !(fs.existsSync(path.join(docsDir, `${page}.md`)) || fs.existsSync(path.join(docsDir, page, "index.md")))) bad.push(v);
      } else {
        const local = path.join(SCHEMA_DIR, kind === "schemas" ? rest : path.join("services", rest));
        if (!fs.existsSync(local)) bad.push(v);
      }
    } else if (Array.isArray(v)) v.forEach(walkJson);
    else if (v && typeof v === "object") Object.values(v).forEach(walkJson);
  })(doc);
  check(`${name}: all embedded ucp.dev URLs resolve in the official tree (${seen.size} checked)`, bad.length === 0, bad.join(", "));
}

async function main() {
  console.log("\n— 3. Profiles vs profile.json (official) + live URL audit");
  for (const mid of ["wavelength", "soundhub", "electromart", "audionest"]) {
    const prof = await (await fetch(merchantProfileUrl(mid))).json();
    validate(`business profile (${mid}) valid per profile.json#business_schema`, ID("profile.json") + "#/$defs/business_schema", prof);
    auditDocUrls(`business profile (${mid})`, prof);
  }
  const platform = await (await fetch(`${URLS.shoppingAgent}/.well-known/ucp`)).json();
  validate("platform profile valid per profile.json#platform_schema", ID("profile.json") + "#/$defs/platform_schema", platform);
  auditDocUrls("platform profile", platform);

  console.log("\n— 4. Live flow → raw wire artifacts vs official schemas");
  const { session_id: sid } = await api("/session", {});
  await api("/intent", { session_id: sid, text: "I'm looking for over-ear noise-cancelling headphones. Budget is under $300, and I need them delivered within 2 days." });
  await api("/select", { session_id: sid, product_id: "cadence-anc-pro", merchant_id: "wavelength" });
  await api("/accessory", { session_id: sid });
  await api("/checkout", { session_id: sid });
  let dbg: any = await (await fetch(`${URLS.shoppingAgent}/api/debug/${sid}`)).json();
  validate("checkout response (ready_for_complete) vs composed checkout+fulfillment+ap2", "local://composed-checkout", dbg.checkout);
  for (const [mid, cat] of Object.entries<any>(dbg.catalog ?? {})) {
    validate(`catalog response (${mid}) vs catalog_search.json#search_response`, ID("shopping/catalog_search.json") + "#/$defs/search_response", cat);
  }
  await api("/pay", { session_id: sid });
  await api("/pay/confirm", { session_id: sid });
  dbg = await (await fetch(`${URLS.shoppingAgent}/api/debug/${sid}`)).json();
  validate("completed checkout vs composed checkout+fulfillment+ap2", "local://composed-checkout", dbg.checkout);
  await api("/track", { session_id: sid });
  dbg = await (await fetch(`${URLS.shoppingAgent}/api/debug/${sid}`)).json();
  validate("order webhook object vs order.json", ID("shopping/order.json"), dbg.order);

  console.log(`\n${"=".repeat(60)}\n${failed === 0 ? "FULLY SCHEMA-COMPLIANT" : "VIOLATIONS FOUND"}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("validator crashed:", e);
  process.exit(1);
});
