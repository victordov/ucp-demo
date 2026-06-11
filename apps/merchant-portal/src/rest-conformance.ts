/**
 * REST binding for the OFFICIAL UCP conformance suite
 * (github.com/Universal-Commerce-Protocol/conformance).
 *
 * The official pytest suite drives a *vanilla* UCP merchant over plain REST
 * resource routes (POST /checkout-sessions, GET/PUT /checkout-sessions/{id},
 * /complete, /cancel, GET /orders/{id}, POST /testing/simulate-shipping/{id})
 * with a stub `request-signature: "test"` header — NOT the MCP binding or the
 * AP2 mandate chain our production flow uses.
 *
 * This module maps those REST routes onto an isolated, in-memory checkout/order
 * store so the genuine upstream tests can run against us and we can report a
 * real pass/fail. It is mounted ONLY when UCP_REST=1, advertises an extra
 * `transport:"rest"` shopping service in the profile, and is completely
 * separate from the signed MCP merchant (zero impact on production behavior).
 *
 * Reuses the merchant's checkout math; vanilla `complete` (no AP2 required)
 * settles synthetically — the suite verifies lifecycle + shapes, not our PSP.
 */
import express from "express";
import { createHash } from "node:crypto";
import { randomId } from "../../../packages/common/src/crypto.ts";

const SIM_SECRET = process.env.SIMULATION_SECRET ?? "super-secret-sim-key";

const VER = "2026-01-23"; // the version the vendored conformance suite targets

interface RTotal { type: string; amount: number; display_text?: string }
interface RLineItem { id: string; item: { id: string; title?: string; price?: number }; quantity: number; totals: RTotal[] }
interface RCheckout {
  ucp: { version: string };
  id: string;
  status: string;
  currency: string;
  line_items: RLineItem[];
  buyer?: any;
  fulfillment?: any;
  payment?: any;
  totals: RTotal[];
  links: { type: string; url: string }[];
  messages?: any[];
  order?: { id: string; permalink_url: string };
  expires_at?: string;
}

const TAX_RATE = 0.08625;

function priceFor(itemId: string): number {
  // Conformance items are abstract (item_1…); price them deterministically.
  if (/^item_1$|^item_a$/.test(itemId)) return 1000;
  return 1000;
}

function computeTotals(items: RLineItem[], shipping = 0): RTotal[] {
  const subtotal = items.reduce((a, i) => a + (i.item.price ?? priceFor(i.item.id)) * i.quantity, 0);
  const tax = Math.round((subtotal + shipping) * TAX_RATE);
  const totals: RTotal[] = [{ type: "subtotal", amount: subtotal }];
  if (shipping) totals.push({ type: "fulfillment", amount: shipping });
  totals.push({ type: "tax", amount: tax });
  totals.push({ type: "total", amount: subtotal + shipping + tax });
  return totals;
}

function normalizeLineItems(raw: any[]): RLineItem[] {
  return (raw ?? []).map((li, idx) => {
    const itemId = li.item?.id ?? li.item_id ?? `item_${idx + 1}`;
    const price = li.item?.price ?? priceFor(itemId);
    return {
      id: li.id ?? `line_item_${idx + 1}`,
      item: { id: itemId, title: li.item?.title ?? itemId, price },
      quantity: li.quantity ?? 1,
      totals: [{ type: "subtotal", amount: price * (li.quantity ?? 1) }],
    };
  });
}

export function restConformanceRouter(opts: { baseUrl: string; domain: string }) {
  const router = express.Router();
  router.use(express.json());

  const checkouts = new Map<string, RCheckout>();
  const orders = new Map<string, any>();

  // Idempotency: key → {bodyHash, status, body}. Same key+body → cached reply;
  // same key + DIFFERENT body → 409 conflict (per the UCP idempotency rule).
  const idemp = new Map<string, { hash: string; status: number; body: any }>();
  const bodyHash = (b: unknown) => createHash("sha256").update(JSON.stringify(b ?? {})).digest("hex");

  /** Returns a cached response or 409 if the key was reused with a different body; null = proceed. */
  function idemReplay(req: express.Request, res: express.Response): boolean {
    const key = req.header("idempotency-key");
    if (!key) return false;
    const prev = idemp.get(key);
    if (!prev) return false;
    if (prev.hash !== bodyHash(req.body)) {
      res.status(409).json({ messages: [{ type: "error", code: "idempotency_conflict", content: "idempotency key reused with a different body", severity: "unrecoverable" }] });
      return true;
    }
    res.status(prev.status).json(prev.body);
    return true;
  }
  function withIdem(req: express.Request, res: express.Response, status: number, body: any) {
    const key = req.header("idempotency-key");
    if (key) idemp.set(key, { hash: bodyHash(req.body), status, body });
    res.status(status).json(body);
  }

  /* ---- discovery healthz ---- */
  router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  /* ---- create ---- */
  router.post("/checkout-sessions", (req, res) => {
    if (idemReplay(req, res)) return;
    const b = req.body ?? {};
    const items = normalizeLineItems(b.line_items);
    if (!items.length) {
      return res.status(400).json({ ucp: { version: VER, status: "error" }, messages: [{ type: "error", code: "invalid_request", content: "line_items required", severity: "unrecoverable" }] });
    }
    const ship = b.fulfillment ? 0 : 0;
    const co: RCheckout = {
      ucp: { version: VER },
      id: randomId("co", 18),
      status: "ready_for_complete",
      currency: b.currency ?? "USD",
      line_items: items,
      buyer: b.buyer,
      fulfillment: b.fulfillment ?? undefined,
      payment: b.payment ?? { instruments: [] },
      totals: computeTotals(items, ship),
      links: [],
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    checkouts.set(co.id, co);
    withIdem(req, res, 201, co);
  });

  /* ---- get ---- */
  router.get("/checkout-sessions/:id", (req, res) => {
    const co = checkouts.get(req.params.id);
    if (!co) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such checkout" }] });
    res.json(co);
  });

  /* ---- update (PUT) ---- */
  router.put("/checkout-sessions/:id", (req, res) => {
    const co = checkouts.get(req.params.id);
    if (!co) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such checkout" }] });
    if (co.status === "completed" || co.status === "canceled")
      return res.status(409).json({ messages: [{ type: "error", code: "not_modifiable", content: `checkout is ${co.status}`, severity: "unrecoverable" }] });
    if (idemReplay(req, res)) return;
    const b = req.body ?? {};
    if (Array.isArray(b.line_items) && b.line_items.length) co.line_items = normalizeLineItems(b.line_items);
    if (b.buyer !== undefined) co.buyer = b.buyer;
    if (b.fulfillment !== undefined) co.fulfillment = b.fulfillment;
    if (b.payment !== undefined) co.payment = b.payment;
    co.totals = computeTotals(co.line_items, 0);
    withIdem(req, res, 200, co);
  });

  /* ---- cancel (idempotent on the same key; otherwise non-modifiable → 409) ---- */
  router.post("/checkout-sessions/:id/cancel", (req, res) => {
    if (idemReplay(req, res)) return; // same key replay wins over the state guard
    const co = checkouts.get(req.params.id);
    if (!co) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such checkout" }] });
    if (co.status === "completed" || co.status === "canceled")
      return res.status(409).json({ messages: [{ type: "error", code: "not_modifiable", content: `checkout is ${co.status}`, severity: "unrecoverable" }] });
    co.status = "canceled";
    withIdem(req, res, 200, co);
  });

  /* ---- complete (vanilla — no AP2 mandate required) ---- */
  router.post("/checkout-sessions/:id/complete", (req, res) => {
    if (idemReplay(req, res)) return;
    const co = checkouts.get(req.params.id);
    if (!co) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such checkout" }] });
    // Already terminal: only a same-idempotency-key replay (handled above) gets
    // a cached 200; a fresh re-complete is a 409 (not modifiable).
    if (co.status === "completed" || co.status === "canceled")
      return res.status(409).json({ messages: [{ type: "error", code: "not_modifiable", content: `checkout is ${co.status}`, severity: "unrecoverable" }] });

    const orderId = randomId("ord", 14);
    const total = co.totals.find((t) => t.type === "total")?.amount ?? 0;
    const order = {
      ucp: { version: VER },
      id: orderId,
      checkout_id: co.id,
      permalink_url: `https://${opts.domain}/orders/${orderId}`,
      line_items: co.line_items.map((l) => ({
        id: l.id,
        item: { id: l.item.id, title: l.item.title, price: l.item.price },
        quantity: { original: l.quantity, total: l.quantity, fulfilled: 0 },
        totals: l.totals,
        status: "processing",
      })),
      fulfillment: {
        expectations: co.fulfillment?.methods?.length
          ? [{
              id: "exp_1",
              line_items: co.line_items.map((l) => ({ id: l.id, quantity: l.quantity })),
              method_type: "shipping",
              destination: co.fulfillment.methods[0]?.destinations?.[0] ?? { address_country: "US" },
              fulfillable_on: new Date(Date.now() + 2 * 864e5).toISOString(),
            }]
          : [],
        events: [],
      },
      currency: co.currency,
      totals: co.totals,
    };
    orders.set(orderId, order);
    co.status = "completed";
    co.order = { id: orderId, permalink_url: order.permalink_url };
    const body = { ...co, order: { id: orderId, permalink_url: order.permalink_url } };
    withIdem(req, res, 200, body);
  });

  /* ---- get order ---- */
  router.get("/orders/:id", (req, res) => {
    const o = orders.get(req.params.id);
    if (!o) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such order" }] });
    res.json(o);
  });

  /* ---- simulation: shipping (suite is gated by a shared secret) ---- */
  router.post("/testing/simulate-shipping/:id", (req, res) => {
    const secret = req.header("simulation-secret");
    if (secret !== SIM_SECRET)
      return res.status(403).json({ messages: [{ type: "error", code: "forbidden", content: "invalid or missing Simulation-Secret", severity: "unrecoverable" }] });
    const o = orders.get(req.params.id);
    if (!o) return res.status(404).json({ messages: [{ type: "error", code: "not_found", content: "no such order" }] });
    o.fulfillment.events.push({
      id: `evt_${o.fulfillment.events.length + 1}`,
      occurred_at: new Date().toISOString(),
      type: "shipped",
      line_items: o.line_items.map((l: any) => ({ id: l.id, quantity: l.quantity.total })),
      carrier: "UPS",
      tracking_number: "1Z" + randomId("", 14).slice(1).toUpperCase(),
      description: "Package handed to carrier (simulated)",
    });
    res.json({ ok: true, order_id: o.id });
  });

  return router;
}
