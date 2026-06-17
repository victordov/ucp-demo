/**
 * Runtime schema resolution for the Shopping Agent (platform), implementing the
 * UCP spec "Resolution Flow":
 *   fetch base schema + active extension schemas → compose via `allOf`
 *   (each extension's `$defs[dev.ucp.shopping.checkout]`) → validate payloads.
 *
 * Schemas are loaded from the vendored official tree in ./schemas (the same
 * source `npm run validate` uses), so composition works fully offline. All
 * setup is lazy + cached and wrapped so a missing schema never breaks a flow.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schemas");
const ID = (p: string) => `https://ucp.dev/schemas/${p}`;

/** capability name → its extension schema file (relative to schemas/). */
const EXT_SCHEMA: Record<string, string> = {
  "dev.ucp.shopping.fulfillment": "shopping/fulfillment.json",
  "dev.ucp.shopping.ap2_mandate": "shopping/ap2_mandate.json",
  "dev.ucp.shopping.discount": "shopping/discount.json",
};

let _ajv: any = null;
let _loaded = 0;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".json")) yield p;
  }
}

function getAjv() {
  if (_ajv) return _ajv;
  const a = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(a);
  for (const kw of ["ucp_request", "name", "version"]) a.addKeyword({ keyword: kw });
  let n = 0;
  for (const file of walk(SCHEMA_DIR)) {
    if (file.includes(`${path.sep}services${path.sep}`)) continue; // OpenRPC/OpenAPI docs, not JSON Schemas
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc.$id) continue;
      a.addSchema(doc);
      n++;
    } catch {
      /* skip unparseable */
    }
  }
  _loaded = n;
  _ajv = a;
  return a;
}

export interface SchemaResolution {
  /** Composed allOf members (for display in the trace). */
  chain: string[];
  /** Number of vendored schemas registered. */
  loaded: number;
  /** Validate a payload against the composed checkout schema. */
  validate: (data: unknown) => { ok: boolean; errors: string[] };
}

/**
 * Resolve + compose the Checkout schema for the negotiated capabilities:
 * base `shopping/checkout.json` + each active extension's
 * `$defs[dev.ucp.shopping.checkout]`, merged via `allOf`.
 */
export function resolveComposedCheckoutSchema(activeCapabilities: string[]): SchemaResolution {
  const a = getAjv();
  const exts = activeCapabilities.filter((c) => EXT_SCHEMA[c]).sort();
  const allOf: any[] = [{ $ref: ID("shopping/checkout.json") }];
  const chain = ["shopping/checkout.json"];
  for (const c of exts) {
    allOf.push({ $ref: ID(EXT_SCHEMA[c]) + "#/$defs/dev.ucp.shopping.checkout" });
    chain.push(`${EXT_SCHEMA[c]}#/$defs/dev.ucp.shopping.checkout`);
  }
  const composedId = `local://composed-checkout-${exts.join("+") || "base"}`;
  if (!a.getSchema(composedId)) a.addSchema({ $id: composedId, allOf });
  const v = a.getSchema(composedId);
  return {
    chain,
    loaded: _loaded,
    validate: (data: unknown) => {
      try {
        const ok = v(data) as boolean;
        const errors = (v.errors ?? [])
          .map((e: any) => `${e.instancePath || "/"} ${e.message}`)
          .filter((m: string, i: number, arr: string[]) => arr.indexOf(m) === i)
          .slice(0, 8);
        return { ok, errors };
      } catch (e: any) {
        return { ok: false, errors: [`validator error: ${e.message}`] };
      }
    },
  };
}
