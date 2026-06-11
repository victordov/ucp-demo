/**
 * UCP MCP transport — JSON-RPC 2.0 over streamable HTTP, per
 * https://ucp.dev/2026-04-08/specification/checkout-mcp/ and the
 * "Transport Layer / MCP" section of the core specification.
 *
 * Conformance points implemented here:
 *  - All operations are invoked via `tools/call` with the operation name in
 *    `params.name` and the UCP payload in `params.arguments`.
 *  - `params.arguments.meta["ucp-agent"].profile` is REQUIRED on all requests;
 *    `meta["idempotency-key"]` is required for state-changing operations.
 *  - Responses return the UCP payload in `result.structuredContent` and a
 *    serialized copy in `result.content[]` (dual-output pattern).
 *  - Business outcomes (incl. errors) are JSON-RPC `result`s with a UCP
 *    envelope + `messages`; protocol errors are JSON-RPC `error`s with
 *    -32001 (discovery) / -32000 (auth, rate, idempotency) / -32600 / -32601
 *    and the matching HTTP status code as primary signal.
 *  - `initialize` and `tools/list` are supported (MCP handshake).
 *  - PKI: every request carries RFC 9421 HTTP message signatures; the signer
 *    is resolved via the JWKs in its UCP profile (no DIDs). Identity binding:
 *    meta["ucp-agent"] MUST be consistent with the UCP-Agent header.
 *  - Replay protection: Idempotency-Key; reuse with a different payload → 409.
 */
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { signRequest, signResponse, verifyResponse, verifyRequest, type ProfileFetcher } from "./httpsig.ts";
import { sha256, type SigningKey, type Jwk } from "./crypto.ts";
import { UCP_VERSION } from "./types.ts";

/* ---------------- shared profile cache (min TTL floor per spec) ---------------- */

const profileCache = new Map<string, { profile: any; at: number }>();
const PROFILE_TTL_MS = 60_000; // spec: minimum TTL floor of 60 seconds

export async function fetchUcpProfile(profileUrl: string): Promise<any> {
  const hit = profileCache.get(profileUrl);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const res = await fetch(profileUrl, { headers: { accept: "application/json" }, redirect: "error" });
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status} ${profileUrl}`);
  const profile = await res.json();
  profileCache.set(profileUrl, { profile, at: Date.now() });
  return profile;
}

export const profileFetcher: ProfileFetcher = (url) => fetchUcpProfile(url);

export function findJwk(profile: { signing_keys?: Jwk[] }, kid: string): Jwk | undefined {
  return (profile.signing_keys || []).find((k) => k.kid === kid);
}

/* ---------------- errors ---------------- */

/** Protocol error → JSON-RPC `error` + HTTP status. */
export class RpcError extends Error {
  constructor(
    public code: number, // JSON-RPC code: -32000, -32001, -32600, -32601, -32603
    message: string,
    public data?: { code?: string; content?: string; continue_url?: string; [k: string]: unknown },
    public httpStatus = 200
  ) {
    super(message);
  }
}

/** Business outcome error → JSON-RPC `result` with UCP error envelope + messages. */
export class BusinessError extends Error {
  constructor(
    public messages: { type: string; code?: string; content: string; severity?: string; path?: string }[],
    public continue_url?: string
  ) {
    super(messages[0]?.content ?? "business error");
  }
}

export const UCP_ERR = (code: string, content: string, continue_url?: string) => ({ code, content, ...(continue_url ? { continue_url } : {}) });

/* ---------------- server ---------------- */

export interface RpcContext {
  signerProfileUrl: string; // PKI-verified caller identity
  keyId: string;
  meta: Record<string, any>;
  req: Request;
}

export type ToolHandler = (args: any, ctx: RpcContext) => Promise<unknown> | unknown;

export interface ToolDef {
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>; // SHOULD reference UCP JSON Schemas
  handler: ToolHandler;
  /** meta["idempotency-key"] required (complete/cancel per spec). */
  requiresIdempotencyKey?: boolean;
}

export interface McpServerOptions {
  serverName: string;
  tools: Record<string, ToolDef>;
  /** AP2 short-term trust model: curated allowlist of peer profile URLs. */
  trustedProfiles?: (profileUrl: string) => boolean;
  onCall?: (tool: string, args: any, ctx: RpcContext, result: unknown, error?: unknown) => void;
  /** RECOMMENDED response signing (RFC 9421, @status): sign successful results of these tools. */
  responseKey?: SigningKey;
  signResponseFor?: (toolName: string) => boolean;
}

const idempotencyStore = new Map<string, { bodyHash: string; response: unknown; at: number }>();
const IDEM_TTL_MS = 48 * 3600 * 1000; // spec: min 24h, recommended 48h

/** Wrap a UCP payload in the MCP dual-output result. */
export function mcpResult(id: unknown, payload: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  };
}

export function mcpHandler(opts: McpServerOptions) {
  return async (req: Request, res: Response) => {
    const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);
    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const rpcId = parsed?.id ?? null;
    const reply = (status: number, body: unknown) => res.status(status).json(body);
    const rpcError = (status: number, code: number, message: string, data?: unknown) =>
      reply(status, { jsonrpc: "2.0", id: rpcId, error: { code, message, ...(data ? { data } : {}) } });

    if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      return rpcError(400, -32600, "Invalid Request");
    }

    // ---- MCP lifecycle methods (no UCP payload — signature still verified below for tools/call) ----
    if (parsed.method === "initialize") {
      return reply(200, {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: opts.serverName, version: UCP_VERSION },
        },
      });
    }
    if (parsed.method === "notifications/initialized") return res.status(202).end();
    if (parsed.method === "tools/list") {
      return reply(200, {
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          tools: Object.entries(opts.tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object" },
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          })),
        },
      });
    }
    if (parsed.method !== "tools/call") {
      return rpcError(200, -32601, `Method not found: ${parsed.method}`);
    }

    const toolName: string | undefined = parsed.params?.name;
    const args: any = parsed.params?.arguments ?? {};
    const meta: Record<string, any> = args.meta ?? {};

    // ---- 1. UCP-Agent / meta.ucp-agent (required for negotiation) ----
    const headerAgent = (req.headers["ucp-agent"] as string | undefined) ?? "";
    const headerProfile = headerAgent.match(/profile="([^"]+)"/)?.[1];
    const metaProfile: string | undefined = meta["ucp-agent"]?.profile;
    if (!metaProfile) {
      return rpcError(401, -32001, "UCP discovery failed", UCP_ERR("invalid_profile_url", 'meta["ucp-agent"].profile is required'));
    }
    // Identity binding: authenticated identity must be consistent with the claimed profile
    if (headerProfile && headerProfile !== metaProfile) {
      return rpcError(403, -32000, "Identity binding violation", UCP_ERR("profile_not_trusted", `meta["ucp-agent"] (${metaProfile}) conflicts with UCP-Agent header (${headerProfile})`));
    }

    // ---- 2. Trust registry pre-check (AP2 short-term model) ----
    if (opts.trustedProfiles && !opts.trustedProfiles(metaProfile)) {
      return rpcError(403, -32000, "Profile not trusted", UCP_ERR("profile_not_trusted", `${metaProfile} is not in this service's trust registry`));
    }

    // ---- 3. PKI: verify RFC 9421 HTTP message signature ----
    const ver = await verifyRequest(
      {
        method: req.method,
        host: (req.headers["x-original-host"] as string) ?? req.headers.host ?? "",
        path: (req.headers["x-original-path"] as string) ?? (req.baseUrl ?? "") + req.path,
        headers: req.headers as Record<string, string | undefined>,
        rawBody,
      },
      profileFetcher
    );
    if (!ver.ok) {
      const status = ver.error === "profile_unreachable" ? 424 : ver.error === "digest_mismatch" ? 400 : 401;
      const code = ver.error === "profile_unreachable" ? -32001 : ver.error === "digest_mismatch" ? -32600 : -32000;
      return rpcError(status, code, "Signature verification failed", UCP_ERR(ver.error ?? "signature_invalid", `PKI verification failed (${ver.error})`));
    }

    // ---- 4. Tool resolution ----
    const tool = toolName ? opts.tools[toolName] : undefined;
    if (!tool) return rpcError(200, -32601, `Unknown tool: ${toolName}`);

    // ---- 5. Idempotency / replay protection (business layer) ----
    const idem: string | undefined = meta["idempotency-key"] ?? (req.headers["idempotency-key"] as string | undefined);
    if (tool.requiresIdempotencyKey && !idem) {
      return rpcError(400, -32600, "Invalid Request", UCP_ERR("invalid_request", `meta["idempotency-key"] is required for ${toolName}`));
    }
    const bodyHash = sha256(rawBody).toString("hex");
    if (idem) {
      const cached = idempotencyStore.get(`${opts.serverName}:${idem}`);
      if (cached && Date.now() - cached.at < IDEM_TTL_MS) {
        if (cached.bodyHash !== bodyHash) {
          return rpcError(409, -32000, "Idempotency key reused with different payload", UCP_ERR("idempotency_conflict", idem));
        }
        return reply(200, cached.response);
      }
    }

    // ---- 6. Dispatch ----
    const ctx: RpcContext = { signerProfileUrl: ver.profileUrl!, keyId: ver.keyId!, meta, req };
    let response: unknown;
    let httpStatus = 200;
    try {
      const result = await tool.handler(args, ctx);
      response = mcpResult(rpcId, result);
      opts.onCall?.(toolName!, args, ctx, result);
    } catch (e: any) {
      if (e instanceof BusinessError) {
        // Business outcome: JSON-RPC result with UCP error envelope
        response = mcpResult(rpcId, {
          ucp: { version: UCP_VERSION, status: "error" },
          messages: e.messages,
          ...(e.continue_url ? { continue_url: e.continue_url } : {}),
        });
        opts.onCall?.(toolName!, args, ctx, undefined, e.messages);
      } else if (e instanceof RpcError) {
        httpStatus = e.httpStatus;
        response = { jsonrpc: "2.0", id: rpcId, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
        opts.onCall?.(toolName!, args, ctx, undefined, e.message);
      } else {
        httpStatus = 500;
        response = { jsonrpc: "2.0", id: rpcId, error: { code: -32603, message: e?.message ?? "Internal error" } };
        opts.onCall?.(toolName!, args, ctx, undefined, e?.message);
      }
    }
    if (idem && httpStatus === 200) idempotencyStore.set(`${opts.serverName}:${idem}`, { bodyHash, response, at: Date.now() });

    // RECOMMENDED: sign successful responses for selected tools (RFC 9421, @status).
    const isErrorResp = !!(response as any)?.error || (response as any)?.result?.structuredContent?.ucp?.status === "error";
    if (opts.responseKey && opts.signResponseFor?.(toolName!) && httpStatus === 200 && !isErrorResp) {
      const bodyStr = JSON.stringify(response);
      const sigHeaders = signResponse({ status: 200, body: bodyStr, key: opts.responseKey });
      res.set(sigHeaders);
      return res.status(200).send(bodyStr);
    }
    return reply(httpStatus, response);
  };
}

/* ---------------- client ---------------- */

export interface RpcClientIdentity {
  key: SigningKey;
  profileUrl: string;
}

let rpcCounter = 1;

export interface RpcCallRecord {
  url: string;
  request: any;
  response: any;
  headers: Record<string, string>;
  /** Response signature headers (present when the server signed the response). */
  responseHeaders: Record<string, string>;
  rawResponseBody: string;
  ms: number;
  httpStatus: number;
}

/**
 * Invoke a UCP operation over the MCP binding (`tools/call`), signed with the
 * caller's key (RFC 9421). Unwraps `result.structuredContent` and surfaces
 * business-outcome errors and protocol errors as exceptions.
 */
export async function callTool<T = any>(
  endpoint: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  identity: RpcClientIdentity,
  onRecord?: (rec: RpcCallRecord) => void
): Promise<T> {
  const idempotencyKey = randomUUID();
  const request = {
    jsonrpc: "2.0",
    id: rpcCounter++,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: {
        meta: { "ucp-agent": { profile: identity.profileUrl }, "idempotency-key": idempotencyKey },
        ...toolArgs,
      },
    },
  };
  const body = JSON.stringify(request);
  const headers = signRequest({
    method: "POST",
    url: endpoint,
    body,
    key: identity.key,
    profileUrl: identity.profileUrl,
    idempotencyKey,
  });
  const started = Date.now();
  const res = await fetch(endpoint, { method: "POST", headers: headers as unknown as Record<string, string>, body });
  const rawResponseBody = await res.text();
  let json: any = {};
  try { json = JSON.parse(rawResponseBody); } catch { /* non-JSON */ }
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (responseHeaders[k] = v));
  onRecord?.({ url: endpoint, request, response: json, headers: headers as unknown as Record<string, string>, responseHeaders, rawResponseBody, ms: Date.now() - started, httpStatus: res.status });
  if (!res.ok) {
    throw new RpcError(
      json.error?.code ?? -32603,
      json.error?.message ?? `HTTP Error ${res.status}: ${rawResponseBody.slice(0, 150)}`,
      json.error?.data,
      res.status
    );
  }
  if (json.error) {
    throw new RpcError(json.error.code ?? -32603, json.error.message ?? "RPC error", json.error.data, res.status);
  }
  const payload = json.result?.structuredContent;
  if (payload?.ucp?.status === "error") {
    throw new BusinessError(payload.messages ?? [{ type: "error", content: "unknown business error" }], payload.continue_url);
  }
  return payload as T;
}

/** Express helper: capture raw body for digest verification. */
export function rawBodySaver(req: any, _res: any, buf: Buffer) {
  req.rawBody = buf.toString("utf8");
}
