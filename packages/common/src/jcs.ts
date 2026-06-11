/**
 * JSON Canonicalization Scheme (JCS) — RFC 8785.
 * Produces a deterministic serialization so that semantically identical JSON
 * yields byte-identical output (required for durable mandate signatures).
 */
export function jcsCanonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite numbers are not permitted");
    return JSON.stringify(value); // ECMAScript number-to-string == RFC 8785 serialization
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => jcsCanonicalize(v === undefined ? null : v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // RFC 8785: sort property names by UTF-16 code units (default JS sort for strings)
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcsCanonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`JCS: cannot canonicalize value of type ${typeof value}`);
}

export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcsCanonicalize(value), "utf8");
}
