/**
 * UCP Negotiation Protocol helpers — implements the normative pieces of
 * https://ucp.dev/2026-04-08/specification/overview/#negotiation-protocol :
 *
 *  - Capability intersection algorithm (name match → highest mutual version →
 *    transitive orphan-extension pruning, single- and multi-parent).
 *  - Namespace-authority validation (the spec/schema URL origin MUST match the
 *    reverse-domain authority of the capability name).
 *  - Platform/business profile shape validation (→ profile_malformed).
 *  - The negotiation/signature error-code → {http, mcp} status table.
 *
 * Pure functions, no I/O, so they can be unit-tested directly.
 */

export interface CapDecl {
  version: string;
  spec?: string;
  schema?: string;
  extends?: string | string[];
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export type CapabilityMap = Record<string, CapDecl[]>;

/** Normalize a single-declaration map (e.g. a platform's static caps) to arrays. */
export function asCapabilityMap(caps: Record<string, CapDecl | CapDecl[]>): CapabilityMap {
  const out: CapabilityMap = {};
  for (const [name, v] of Object.entries(caps)) out[name] = Array.isArray(v) ? v : [v];
  return out;
}

/** Version strings are ISO dates (e.g. 2026-04-08); lexical sort == chronological. */
export function pickHighestVersion(versions: string[]): string | undefined {
  if (!versions.length) return undefined;
  return [...versions].sort().at(-1);
}

function extendsOf(decls?: CapDecl[]): string | string[] | undefined {
  return decls?.find((d) => d.extends !== undefined)?.extends;
}

export interface IntersectionResult {
  /** Active capability names (mutually supported, dependencies satisfied). */
  active: string[];
  /** Selected version per active capability (highest mutual). */
  versions: Record<string, string>;
}

/**
 * Capability intersection per the spec's Intersection Algorithm:
 *  1. include a business capability if the platform has the same name;
 *  2. select the highest version present in BOTH arrays (exclude if none mutual);
 *  3. prune orphaned extensions (single-parent: parent present; multi-parent: at
 *     least one parent present);
 *  4. repeat pruning until stable (transitive chains).
 */
export function intersectCapabilities(platform: CapabilityMap, business: CapabilityMap): IntersectionResult {
  const versions: Record<string, string> = {};
  for (const [name, bDecls] of Object.entries(business)) {
    const pDecls = platform[name];
    if (!pDecls) continue;
    const platformVersions = new Set(pDecls.map((d) => d.version));
    const mutual = bDecls.map((d) => d.version).filter((v) => platformVersions.has(v));
    const selected = pickHighestVersion(mutual);
    if (selected) versions[name] = selected;
  }
  let active = Object.keys(versions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...active]) {
      const ext = extendsOf(business[name]);
      if (ext === undefined) continue;
      const parents = Array.isArray(ext) ? ext : [ext];
      if (!parents.some((p) => active.includes(p))) {
        active = active.filter((n) => n !== name);
        delete versions[name];
        changed = true;
      }
    }
  }
  return { active, versions };
}

/**
 * Reverse-domain authority for a capability name: the first two labels reversed.
 * `dev.ucp.shopping.checkout` → `ucp.dev`; `com.example.foo` → `example.com`.
 */
export function namespaceAuthority(capabilityName: string): string {
  const labels = capabilityName.split(".");
  if (labels.length < 2) return "";
  return `${labels[1]}.${labels[0]}`;
}

/** The spec/schema URL origin MUST be https://<namespace-authority>. */
export function namespaceAuthorityOk(capabilityName: string, url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === namespaceAuthority(capabilityName);
  } catch {
    return false;
  }
}

export interface NamespaceViolation {
  name: string;
  field: "spec" | "schema";
  url?: string;
  reason: "missing" | "origin_mismatch";
}

/**
 * Validate that every capability's REQUIRED `spec` and `schema` URLs have an
 * origin matching the namespace authority. Returns the list of violations
 * (empty = all valid). Platforms MUST validate this and SHOULD reject offenders.
 */
export function validateCapabilityNamespaces(caps: CapabilityMap): NamespaceViolation[] {
  const bad: NamespaceViolation[] = [];
  for (const [name, decls] of Object.entries(caps)) {
    for (const d of decls) {
      for (const field of ["spec", "schema"] as const) {
        const url = d[field] as string | undefined;
        if (url === undefined) bad.push({ name, field, reason: "missing" });
        else if (!namespaceAuthorityOk(name, url)) bad.push({ name, field, url, reason: "origin_mismatch" });
      }
    }
  }
  return bad;
}

/** Strip capabilities that fail namespace validation; returns the clean map + violations. */
export function pruneInvalidNamespaces(caps: CapabilityMap): { clean: CapabilityMap; violations: NamespaceViolation[] } {
  const violations = validateCapabilityNamespaces(caps);
  const badNames = new Set(violations.map((v) => v.name));
  const clean: CapabilityMap = {};
  for (const [name, decls] of Object.entries(caps)) if (!badNames.has(name)) clean[name] = decls;
  return { clean, violations };
}

/** Throws Error("profile_malformed: …") if the profile doesn't match the expected shape. */
export function validateProfileShape(profile: any): void {
  if (!profile || typeof profile !== "object") throw new Error("profile_malformed: profile is not an object");
  if (!profile.ucp || typeof profile.ucp !== "object") throw new Error("profile_malformed: missing ucp envelope");
  if (typeof profile.ucp.version !== "string") throw new Error("profile_malformed: missing ucp.version");
  if (!profile.ucp.capabilities || typeof profile.ucp.capabilities !== "object")
    throw new Error("profile_malformed: missing ucp.capabilities");
  if (!Array.isArray(profile.signing_keys)) throw new Error("profile_malformed: missing signing_keys[]");
}

/**
 * Negotiation + signature error codes → REST HTTP status and MCP JSON-RPC code,
 * per the spec's Error Codes tables. `mcp: 0` means "report as a JSON-RPC result"
 * (business outcome), not an error.
 */
export const UCP_ERROR_STATUS: Record<string, { http: number; mcp: number }> = {
  // Negotiation
  invalid_profile_url: { http: 400, mcp: -32001 },
  profile_unreachable: { http: 424, mcp: -32001 },
  profile_malformed: { http: 422, mcp: -32001 },
  version_unsupported: { http: 422, mcp: -32001 },
  capabilities_incompatible: { http: 200, mcp: 0 },
  // Signatures
  signature_missing: { http: 401, mcp: -32000 },
  signature_invalid: { http: 401, mcp: -32000 },
  key_not_found: { http: 401, mcp: -32000 },
  digest_mismatch: { http: 400, mcp: -32600 },
  algorithm_unsupported: { http: 400, mcp: -32600 },
};

/** Map an error code → {http, mcp}; falls back to a generic signature failure. */
export function ucpErrorStatus(code: string | undefined): { http: number; mcp: number } {
  return (code && UCP_ERROR_STATUS[code]) || { http: 401, mcp: -32000 };
}
