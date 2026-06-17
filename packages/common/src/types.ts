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
  ap2?: {
    merchant_authorization?: string;
    checkout_mandate?: string;
    checkout_receipt?: string; // signed AP2 Checkout Receipt (returned on complete)
    payment_receipt?: string; // signed AP2 Payment Receipt (from the PSP, surfaced on complete)
  };
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
  payment_mandate: string; // closed Payment Mandate SD-JWT+kb (human-present: issuer=CP/holder=user device; human-not-present: issuer=holder=agent key)
  /** Human-not-present: the user-signed Open Payment Mandate (cnf=agent) the closed
   *  mandate satisfies. Absent in the direct (human-present) flow. */
  open_payment_mandate?: string;
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

/** AP2 Merchant (ap2-protocol.org/ap2/payment_mandate#merchant). */
export interface Ap2Merchant {
  id: string;
  name: string;
  website?: string;
}

/** AP2 PaymentInstrument (ap2-protocol.org/ap2/payment_mandate#paymentinstrument). */
export interface Ap2PaymentInstrument {
  id: string;
  type: string; // "card" | "UPI" | ...
  description?: string;
}

/* ---------------- AP2 open-mandate constraints (v0.2 spec) ----------------
 *
 * The v0.2 specification has no "Intent Mandate" or "Cart Mandate". A user's
 * intent for an autonomous (human-not-present) purchase is expressed as an
 * Open Checkout Mandate + Open Payment Mandate: user-signed credentials that
 * carry `constraints[]` and are sender-constrained to the agent key via `cnf`.
 * The agent then signs the matching CLOSED mandates and presents both; the
 * verifier checks that the closed mandate satisfies the open constraints.
 */

/** checkout.allowed_merchants — constrains the merchants a Checkout Mandate may use. */
export interface AllowedMerchantsConstraint {
  type: "checkout.allowed_merchants";
  allowed: Ap2Merchant[];
}
/** A single line-item requirement: exactly one acceptable item must be present. */
export interface LineItemRequirement {
  id: string;
  acceptable_items: { id: string; title: string }[];
  quantity: number;
}
/** checkout.line_items — the line items that must be present in the checkout. */
export interface LineItemsConstraint {
  type: "checkout.line_items";
  items: LineItemRequirement[];
}
export type CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint;

/** payment.amount_range — valid range for a single payment amount (minor units). */
export interface AmountRangeConstraint {
  type: "payment.amount_range";
  currency: string;
  max: number;
  min?: number;
}
/** payment.budget — max total spend across recurrences (minor units). */
export interface BudgetConstraint {
  type: "payment.budget";
  max: number;
  currency: string;
}
/** payment.agent_recurrence — lets the agent reuse the mandate multiple times. */
export interface AgentRecurrenceConstraint {
  type: "payment.agent_recurrence";
  frequency: "ON_DEMAND" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  max_occurrences?: number;
}
/** payment.allowed_payees — constrains the payees a Payment Mandate may use. */
export interface AllowedPayeesConstraint {
  type: "payment.allowed_payees";
  allowed: Ap2Merchant[];
}
/** payment.allowed_payment_instruments — constrains the instruments allowed. */
export interface AllowedPaymentInstrumentsConstraint {
  type: "payment.allowed_payment_instruments";
  allowed: Ap2PaymentInstrument[];
}
/** AP2 Pisp (Payment Initiation Service Provider). */
export interface Pisp {
  legal_name: string;
  brand_name: string;
  domain_name: string;
}
/** payment.allowed_pisps — constrains the PISPs allowed to facilitate payment. */
export interface AllowedPispsConstraint {
  type: "payment.allowed_pisps";
  allowed: Pisp[];
}
/** payment.execution_date — constrains the valid execution-date window. */
export interface ExecutionDateConstraint {
  type: "payment.execution_date";
  not_before?: string; // ISO-8601
  not_after?: string; // ISO-8601
}
/** payment.reference — binds the open Payment Mandate to an open Checkout Mandate. */
export interface PaymentReferenceConstraint {
  type: "payment.reference";
  conditional_transaction_id: string; // digest of the open Checkout Mandate
}
export type PaymentConstraint =
  | AmountRangeConstraint
  | BudgetConstraint
  | AgentRecurrenceConstraint
  | AllowedPayeesConstraint
  | AllowedPaymentInstrumentsConstraint
  | AllowedPispsConstraint
  | ExecutionDateConstraint
  | PaymentReferenceConstraint;

/** RFC 7800 confirmation claim — sender-constrains the open mandate to the agent key. */
export interface Cnf {
  jwk: Jwk;
}

/**
 * Open Checkout Mandate (AP2 `mandate.checkout.open.1`). User-signed authorization
 * for FUTURE checkout actions, sender-constrained to the agent (`cnf`) and bounded
 * by `constraints`. Presented alongside the agent-signed closed Checkout Mandate in
 * the human-not-present flow.
 */
export interface OpenCheckoutMandatePayload {
  vct: "mandate.checkout.open.1";
  id: string;
  user: string;
  constraints: CheckoutConstraint[];
  cnf: Cnf; // agent public key authorized to sign the closed mandate
  iat: number; // unix epoch
  exp: number; // unix epoch
}

/**
 * Open Payment Mandate (AP2 `mandate.payment.open.1`). User-signed authorization
 * for FUTURE payment actions, sender-constrained to the agent (`cnf`) and bounded
 * by `constraints` (amount_range/budget/agent_recurrence/allowed_payees/reference).
 */
export interface OpenPaymentMandatePayload {
  vct: "mandate.payment.open.1";
  id: string;
  user: string;
  constraints: PaymentConstraint[];
  cnf: Cnf;
  iat: number;
  exp: number;
}

/**
 * Closed Payment Mandate (AP2 `mandate.payment.1`). Issued as an SD-JWT+kb by
 * the Credentials Provider, key-bound to the user device key. Canonical AP2
 * fields (`vct`, `transaction_id`, `payee`, `payment_amount`,
 * `payment_instrument`) plus operational linkage claims used by this demo.
 */
export interface PaymentMandatePayload {
  type: "PaymentMandate";
  vct: "mandate.payment.1"; // AP2 Verifiable Credential Type (exact match required)
  id: string;
  transaction_id: string; // base64url hash of the merchant-signed checkout (links payment ↔ checkout)
  payee: Ap2Merchant; // AP2 Merchant object (was a bare URL string)
  payment_amount: Money; // AP2 Amount (was `amount`)
  payment_instrument: Ap2PaymentInstrument; // AP2 PaymentInstrument
  // --- operational / linkage claims (permitted extra claims) ---
  /** base64url digest of the open Payment Mandate this closed mandate satisfies
   *  (human-not-present only; absent in the human-present/direct flow). */
  open_payment_mandate?: string;
  checkout_id: string;
  handler: string;
  agent?: string; // agent profile URL (KYA / velocity / reputation keying)
  rail?: PaymentRail; // multi-rail settlement: which rail the agent selected
  authorized_by: "device_biometric" | "passkey_user_verification" | "agent_open_mandate";
  human_present: boolean;
  iat?: number; // unix epoch (AP2)
  exp?: number; // unix epoch (AP2) — checked by SD-JWT verify
  issued_at: string;
  expires_at: string;
}

/* ---------------- AP2 receipts (ap2-protocol.org) ---------------- */

export type ReceiptStatus = "Success" | "Error";

/** Checkout Receipt — merchant-issued final state of a checkout. */
export interface CheckoutReceiptPayload {
  status: ReceiptStatus;
  iss: string; // issuer (merchant profile URL)
  iat: number; // unix epoch
  reference: string; // hash of the closed Checkout Mandate this receipt binds to
  order_id?: string; // present iff status === Success
  error?: string; // present iff status === Error
  error_description?: string; // present iff status === Error
}

/** Payment Receipt — MPP-issued final state of a payment. */
export interface PaymentReceiptPayload {
  status: ReceiptStatus;
  iss: string; // issuer (payment provider profile URL)
  iat: number; // unix epoch
  reference: string; // hash of the closed Payment Mandate this receipt binds to
  payment_id: string;
  psp_confirmation_id?: string; // present iff status === Success
  network_confirmation_id?: string; // present iff status === Success
  error?: string; // present iff status === Error
  error_description?: string; // present iff status === Error
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
