/**
 * Shared UCP + AP2 data types — UCP 2026-04-08.
 * Amounts are MINOR UNITS (cents) per the spec ("Amounts format: Minor units").
 */
import type { Jwk } from "./crypto.ts";

export const UCP_VERSION = "2026-04-08";
export const SPEC = (page: string) => `https://ucp.dev/${UCP_VERSION}/specification/${page}`;
export const SCHEMA = (path: string) => `https://ucp.dev/${UCP_VERSION}/schemas/${path}`;

/* ---------------- UCP profile (discovery) ---------------- */

/** Shared entity foundation (ucp.json#/$defs/entity). */
export interface UcpEntity {
  version: string;
  spec?: string;
  schema?: string;
  id?: string;
  config?: Record<string, unknown>;
  extends?: string | string[];
  available_instruments?: { type: string; constraints?: Record<string, unknown> }[];
}

export interface UcpService extends UcpEntity {
  transport: "rest" | "mcp" | "a2a" | "embedded";
  endpoint?: string;
}

/** The `ucp` envelope used in profiles and responses (ucp.json#/$defs/base). */
export interface UcpEnvelope {
  version: string;
  status?: "success" | "error";
  services?: Record<string, UcpService[]>;
  capabilities?: Record<string, UcpEntity[]>;
  payment_handlers?: Record<string, UcpEntity[]>;
}

/** Profile document at /.well-known/ucp: ucp envelope + signing keys (PKI). */
export interface UcpProfile {
  ucp: UcpEnvelope;
  signing_keys: Jwk[];
  /** Non-normative display name (additional property). */
  name?: string;
}

/* ---------------- Catalog ---------------- */

export interface CatalogProduct {
  id: string;
  name: string;
  brand: string;
  price: number; // minor units
  ship: string;
  ship_days: number;
  in_stock: boolean;
  was?: number | null; // minor units
  specs?: { label: string; match?: boolean }[];
  /** Persisted product image, served by the merchant portal (/img/{id}.webp). */
  image?: string;
  note?: string;
  attributes?: string[];
  accessory_for?: string;
}

/* ---------------- Checkout (schemas/shopping/checkout.json) ---------------- */

export type CheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

export interface Total {
  type: string; // subtotal | items_discount | discount | fulfillment | tax | fee | total | custom
  amount: number; // minor units; discounts MUST be negative
  display_text?: string; // required for non-well-known types
}

export interface LineItem {
  id: string;
  item: { id: string; title: string; brand?: string; price: number };
  quantity: number;
  totals: Total[];
}

/** Postal address (schema.org-style field names per UCP examples). */
export interface PostalAddress {
  id?: string;
  first_name?: string;
  last_name?: string;
  street_address: string;
  extended_address?: string;
  address_locality: string;
  address_region: string;
  postal_code: string;
  address_country: string;
  phone?: string;
}

export interface Buyer {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface FulfillmentOption {
  id: string;
  title: string;
  description?: string;
  totals: Total[];
}

export interface FulfillmentMethod {
  id: string;
  type: "shipping";
  line_item_ids: string[];
  destinations: PostalAddress[];
  selected_destination_id?: string;
  groups: {
    id: string;
    line_item_ids: string[];
    selected_option_id?: string;
    options: FulfillmentOption[];
  }[];
}

export interface UcpMessage {
  type: "error" | "warning" | "info";
  code?: string;
  content: string;
  severity?: "recoverable" | "requires_buyer_input" | "unrecoverable";
  path?: string;
}

/** Order confirmation inside a completed checkout (types/order_confirmation.json). */
export interface OrderConfirmation {
  id: string;
  permalink_url: string;
  label?: string;
  // additionalProperties are permitted by the schema:
  estimated_delivery?: string;
}

export interface Checkout {
  ucp: UcpEnvelope; // version + active capabilities + payment_handlers (REQUIRED in responses)
  id: string;
  status: CheckoutStatus;
  currency: string;
  line_items: LineItem[];
  buyer?: Buyer;
  fulfillment?: { methods: FulfillmentMethod[] };
  totals: Total[]; // exactly one subtotal + one total
  messages?: UcpMessage[];
  links: { type: string; url: string }[];
  expires_at?: string;
  continue_url?: string;
  signals?: Record<string, unknown>;
  payment?: { instruments?: PaymentInstrument[] };
  order?: OrderConfirmation;
  ap2?: { merchant_authorization?: string; checkout_mandate?: string };
  /** Additional property (tenant routing in this multi-tenant demo). */
  merchant_id?: string;
}

export interface PaymentInstrument {
  id: string;
  handler_id: string; // handler instance id from ucp.payment_handlers[*][*].id
  type: "card";
  selected: boolean;
  display: { brand?: string; last_digits?: string; description?: string };
  billing_address?: Partial<PostalAddress>;
  credential: {
    type: "AP2_COMPOSITE" | "PAYMENT_GATEWAY" | "card";
    token: CompositeToken | string;
  };
}

/** AP2 composite token: network token + payment mandate travel together to the PSP. */
export interface CompositeToken {
  network_token: { token: string; network: string; last4: string; single_use: boolean; cryptogram: string };
  payment_mandate: string; // JWS signed by the user's device key (held at the Credentials Provider)
}

/* ---------------- Order capability (schemas/shopping/order.json) ---------------- */

export interface OrderLineItem {
  id: string;
  item: { id: string; title: string; price: number; image_url?: string };
  quantity: { original?: number; total: number; fulfilled: number };
  totals: Total[];
  status: "processing" | "partial" | "fulfilled" | "removed";
}

export interface OrderObject {
  ucp: UcpEnvelope;
  id: string;
  label?: string;
  checkout_id: string;
  permalink_url: string;
  line_items: OrderLineItem[];
  fulfillment: {
    expectations?: {
      id: string;
      line_items: { id: string; quantity: number }[];
      method_type: "shipping" | "pickup" | "digital";
      destination: Partial<PostalAddress>;
      description?: string;
      fulfillable_on?: string;
    }[];
    events?: {
      id: string;
      occurred_at: string;
      type: string; // processing | shipped | delivered | ...
      line_items: { id: string; quantity: number }[];
      carrier?: string;
      tracking_number?: string;
      tracking_url?: string;
      description?: string;
    }[];
  };
  adjustments?: {
    id: string;
    type: "refund" | "return" | "credit" | "dispute" | "cancellation";
    amount?: Total;
    reason?: string;
    occurred_at: string;
    [k: string]: unknown;
  }[];
  currency: string;
  totals: Total[];
  messages?: UcpMessage[];
}

/** Official catalog product shape (schemas/shopping/types/product.json). */
export interface CatalogProductWire {
  id: string;
  title: string;
  description: string;
  url?: string;
  price_range: { min: { amount: number; currency: string }; max: { amount: number; currency: string } };
  variants: {
    id: string;
    title: string;
    description: string;
    price: { amount: number; currency: string };
    list_price?: { amount: number; currency: string };
  }[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/* ---------------- AP2 mandates ---------------- */

export interface Money {
  amount: number; // minor units
  currency: string;
}

export interface IntentMandatePayload {
  type: "IntentMandate";
  id: string;
  issued_to: string; // agent profile URL
  user: string;
  constraints: {
    category?: string;
    required_features?: string[];
    max_total?: Money;
    delivery_by_days?: number;
    query: string;
  };
  human_present: boolean;
  prompt_playback: string;
  issued_at: string;
  expires_at: string;
}

export interface CartMandatePayload {
  type: "CartMandate";
  id: string;
  derived_from: string;
  checkout_id: string;
  merchant_id: string;
  merchant_profile: string;
  items: { id: string; title: string; quantity: number; price: number }[];
  total: Money;
  merchant_authorization: string; // embedded merchant JWS (nested binding)
  within_intent: boolean;
  issued_at: string;
  expires_at: string;
}

export interface PaymentMandatePayload {
  type: "PaymentMandate";
  id: string;
  cart_mandate: string;
  checkout_id: string;
  handler: string;
  amount: Money;
  payee: string; // merchant profile URL
  agent?: string; // agent profile URL (KYA / velocity / reputation keying)
  rail?: PaymentRail; // multi-rail settlement: which rail the agent selected
  authorized_by: "device_biometric" | "passkey_user_verification";
  human_present: boolean;
  issued_at: string;
  expires_at: string;
}

/* ---------------- agent spend-control policy (programmable payment) ---------------- */

export type PaymentRail = "card_network" | "rtp";

/**
 * Per-agent consent policy held by the Credentials Provider — the demo analog
 * of a network-enforced "agentic token" scope: what the agent may buy, how
 * much, from whom, until when, and how autonomously. Amounts in minor units.
 */
export interface AgentPolicy {
  agent: string; // agent profile URL
  /** always_ask: never autonomous · ask_above: autonomous below the threshold · autonomous: no limit on modality */
  autonomy: "always_ask" | "ask_above" | "autonomous";
  ask_above_amount: number; // threshold for ask_above (minor units)
  per_tx_cap: number; // max single transaction (minor units)
  budget: number; // total budget for the validity window (minor units)
  spent: number; // accumulated spend (minor units)
  merchants_allowed: string[] | null; // merchant ids; null = any merchant
  valid_from: string;
  valid_until: string;
  preferred_rail: PaymentRail | "auto";
  updated_at: string;
}

/* ---------------- Trace events (UI inspector) ---------------- */

export interface TraceEvent {
  uid: string;
  ts: number;
  layer: "UCP" | "AP2" | "PKI";
  tag: string;
  kind: "request" | "response" | "mandate" | "verify";
  name: string;
  method: string;
  desc: string;
  payload: unknown;
  /** Immutable audit trail: tamper-evident hash chain. */
  seq?: number;
  prev_hash?: string;
  hash?: string;
  mandate?: {
    kind: string;
    id: string;
    seal: string;
    rows: [string, string][];
    sig: string;
  };
  _auto?: boolean;
}
