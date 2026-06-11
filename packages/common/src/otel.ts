/**
 * Minimal OpenTelemetry OTLP/HTTP (JSON) trace exporter — zero dependencies.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://localhost:4318), every
 * protocol-trace event is exported as a span: one trace per shopping session,
 * with UCP-specific attributes (ucp.layer, ucp.kind, ucp.method, audit chain
 * hash). Works with any OTLP-compatible backend (Tempo, Jaeger ≥1.35, Datadog,
 * Grafana Cloud, otel-collector).
 */
import { createHash, randomBytes } from "node:crypto";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, "");
const serviceName = process.env.OTEL_SERVICE_NAME ?? "ucp-shopping-agent";

export const otelEnabled = () => !!endpoint;

/** Deterministic 32-hex trace id per session (so all events of a session correlate). */
const traceIdFor = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 32);

interface PendingSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: number } }[];
}
let buf: PendingSpan[] = [];
let timer: NodeJS.Timeout | null = null;

export function otelSpan(
  sessionId: string,
  ev: { ts: number; layer: string; kind: string; name: string; method: string; seq?: number; hash?: string; tag?: string }
) {
  if (!endpoint) return;
  const start = BigInt(ev.ts) * 1_000_000n;
  buf.push({
    traceId: traceIdFor(sessionId),
    spanId: randomBytes(8).toString("hex"),
    name: `${ev.layer.toLowerCase()}.${ev.kind}: ${ev.name}`,
    kind: 1, // INTERNAL
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: (start + 1_000_000n).toString(),
    attributes: [
      { key: "ucp.layer", value: { stringValue: ev.layer } },
      { key: "ucp.kind", value: { stringValue: ev.kind } },
      { key: "ucp.method", value: { stringValue: ev.method } },
      { key: "ucp.session", value: { stringValue: sessionId } },
      ...(ev.seq != null ? [{ key: "ucp.audit.seq", value: { intValue: ev.seq } }] : []),
      ...(ev.hash ? [{ key: "ucp.audit.hash", value: { stringValue: ev.hash } }] : []),
    ],
  });
  if (!timer) {
    timer = setInterval(flush, 2000);
    timer.unref?.();
  }
  if (buf.length >= 100) void flush();
}

async function flush() {
  if (!endpoint || buf.length === 0) return;
  const spans = buf;
  buf = [];
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [{ scope: { name: "ucp.protocol-trace", version: "1.0.0" }, spans }],
      },
    ],
  });
  try {
    await fetch(`${endpoint}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch {
    /* exporter must never break the flow; drop the batch */
  }
}
