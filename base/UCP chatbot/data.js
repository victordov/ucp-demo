/* ============ Shoppy — demo data: catalog, merchants, address, protocol payloads ============ */

const MERCHANTS = {
  wavelength: { id: "wavelength", name: "Wavelength", color: "#0ea5a4", short: "WL", domain: "shop.wavelength.example", rating: 4.8 },
  soundhub:   { id: "soundhub",   name: "SoundHub",   color: "#7c3aed", short: "SH", domain: "soundhub.example",      rating: 4.6 },
  electromart:{ id: "electromart",name: "ElectroMart",color: "#ea580c", short: "EM", domain: "electromart.example",   rating: 4.4 },
  audionest:  { id: "audionest",  name: "AudioNest",  color: "#2563eb", short: "AN", domain: "audionest.example",     rating: 4.7 },
};

const PRODUCTS = [
  {
    id: "cadence-anc-pro",
    name: "Cadence ANC Pro",
    brand: "Northwave Audio",
    recommended: true,
    recReason: "Best match — hits every constraint",
    specs: [
      { label: "Over-ear", match: true },
      { label: "Hybrid ANC", match: true },
      { label: "32h battery" },
      { label: "Multipoint" },
      { label: "Ships in 2 days", match: true },
    ],
    note: "Class-leading noise cancelling with a warm, balanced signature. Comfortable clamp for long sessions and the fastest delivery in your window.",
    offers: [
      { merchant: "wavelength", price: 274, was: 299, ship: "Free 2-day", best: true, inStock: true },
      { merchant: "soundhub",   price: 279, was: null, ship: "2-day · $4.99", inStock: true },
      { merchant: "electromart",price: 289, was: null, ship: "3–4 days · Free", inStock: true },
    ],
  },
  {
    id: "halo-studio-nc",
    name: "Halo Studio NC",
    brand: "Auralis",
    recommended: false,
    specs: [
      { label: "Over-ear", match: true },
      { label: "Adaptive ANC", match: true },
      { label: "40h battery" },
      { label: "Lightweight" },
      { label: "Ships in 2 days", match: true },
    ],
    note: "Longest battery of the group and the lightest on your head. ANC is a touch behind the Cadence in deep rumble, but excellent for voices.",
    offers: [
      { merchant: "audionest", price: 249, was: null, ship: "Free 2-day", best: true, inStock: true },
      { merchant: "soundhub",  price: 255, was: 269, ship: "2-day · Free", inStock: true },
    ],
  },
  {
    id: "lumen-air-max",
    name: "Lumen Air Max",
    brand: "Vance",
    recommended: false,
    specs: [
      { label: "Over-ear", match: true },
      { label: "ANC", match: true },
      { label: "28h battery" },
      { label: "Budget pick" },
      { label: "Ships in 2 days", match: true },
    ],
    note: "The value option, comfortably under budget. Solid ANC for the price, though build is more plastic and the soundstage is narrower.",
    offers: [
      { merchant: "electromart", price: 189, was: null, ship: "Free 2-day", best: true, inStock: true },
      { merchant: "wavelength",  price: 194, was: null, ship: "2-day · Free", inStock: true },
    ],
  },
];

// accessory offered after the headphones are chosen (same merchant -> one checkout)
const ACCESSORY = {
  id: "travel-hardcase",
  name: "Cadence Travel Hardcase",
  brand: "Northwave Audio",
  merchant: "wavelength",
  price: 34,
  note: "molded zip case + cable pouch",
};

const DEFAULT_ADDRESS = {
  name: "Alex Morgan",
  line1: "248 Fillmore Street",
  line2: "Apt 5",
  city: "San Francisco",
  state: "CA",
  zip: "94117",
  country: "United States",
  phone: "+1 (415) 555-0148",
  email: "alex.morgan@example.com",
};

const CONSTRAINTS = {
  category: "over-ear headphones",
  features: ["active noise cancelling"],
  maxPrice: 300,
  currency: "USD",
  shipBy: "2 days",
};

/* ---------- constraint / intent text the user "types" ---------- */
const USER_INTENT_TEXT =
  "I'm looking for over-ear noise-cancelling headphones. Budget is under $300, and I need them delivered within 2 days.";

/* ---------- helpers ---------- */
function money(n) { return "$" + n.toFixed(2); }
function shortHash(len) {
  const c = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * 16)];
  return s;
}
function nowISO(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }
function ucpId(prefix) { return prefix + "_" + shortHash(20); }

/* ============ Protocol trace payload builders ============
   Each returns: { layer, tag, name, method, desc, payload, mandate? }      */

const TRACE = {
  discovery: () => ({
    layer: "UCP", tag: "UCP", kind: "request",
    name: "Capability Discovery",
    method: "GET /.well-known/ucp",
    desc: "Shoppy fetches the well-known document from each candidate business to learn which UCP capabilities and extensions they support.",
    payload: {
      "@context": "https://ucp.dev/2026-04-08",
      ucp_version: "2026-04-08",
      capabilities: {
        catalog: { search: true, lookup: true },
        checkout: { transports: ["rest", "a2a"] },
        cart: true,
        order: { tracking: true },
      },
      extensions: ["ap2-mandates", "fulfillment", "discounts", "buyer-consent"],
      payment_handlers: ["com.google.pay", "com.shopify.shop_pay"],
    },
  }),

  negotiate: () => ({
    layer: "UCP", tag: "UCP", kind: "response",
    name: "Capability Negotiation",
    method: "intersection()",
    desc: "Intersection of Shoppy's platform profile with each business. Orphaned extensions are pruned; ap2-mandates is retained on all four merchants.",
    payload: {
      profile: "advanced",
      negotiated: {
        catalog_search: true,
        checkout: "rest",
        ap2_mandates: true,
        fulfillment: true,
        discounts: true,
      },
      eligible_businesses: ["shop.wavelength.example", "soundhub.example", "electromart.example", "audionest.example"],
    },
  }),

  intentMandate: () => {
    const id = ucpId("intent");
    return {
      layer: "AP2", tag: "AP2", kind: "mandate",
      name: "Intent Mandate",
      method: "VDC · signed",
      desc: "Your shopping constraints are captured as a user-signed Intent Mandate. It bounds everything the agent is authorized to do — price ceiling, required features, and the delivery window.",
      payload: {
        type: "IntentMandate",
        id,
        issued_to: "agent:shoppy",
        constraints: {
          category: "over-ear headphones",
          required_features: ["active-noise-cancelling"],
          max_total: { amount: "300.00", currency: "USD" },
          delivery_by: "P2D",
        },
        human_present: true,
        expires: nowISO(1000 * 60 * 30),
      },
      mandate: {
        kind: "Intent Mandate",
        id,
        seal: "user · WebAuthn",
        rows: [
          ["category", "over-ear headphones"],
          ["features", "noise-cancelling"],
          ["max_total", "$300.00 USD"],
          ["delivery_by", "≤ 2 days"],
          ["human_present", "true"],
        ],
        sig: "ey" + shortHash(40),
      },
    };
  },

  catalogSearch: () => ({
    layer: "UCP", tag: "UCP", kind: "request",
    name: "Catalog Search",
    method: "POST /catalog/search",
    desc: "A single federated query fans out to all eligible merchants. Results are filtered against the Intent Mandate and ranked by match + price.",
    payload: {
      query: "over-ear noise cancelling headphones",
      filters: { price_max: 300, attributes: ["anc", "over-ear"], ship_within_days: 2 },
      bound_to: "IntentMandate",
      returned: 3,
      merchants_queried: 4,
    },
  }),

  createCheckout: (ctx) => {
    const id = ucpId("co");
    return {
      layer: "UCP", tag: "UCP", kind: "request",
      name: "Create Checkout",
      method: "POST /checkout",
      desc: "Shoppy opens a single checkout session with " + ctx.merchant.name + ". One session, one payment — even with multiple line items.",
      payload: {
        checkout_id: id,
        business: ctx.merchant.domain,
        line_items: ctx.items.map((i) => ({ sku: i.id, name: i.name, qty: i.qty, unit_price: { amount: i.price.toFixed(2), currency: "USD" } })),
        buyer: { email: ctx.address.email },
        status: "requires_fulfillment",
      },
      _checkoutId: id,
    };
  },

  updateCheckout: (ctx) => ({
    layer: "UCP", tag: "UCP", kind: "request",
    name: "Update Checkout · Fulfillment",
    method: "PATCH /checkout/{id}",
    desc: "The default shipping destination is attached. The merchant returns finalized shipping + tax for the session.",
    payload: {
      checkout_id: ctx.checkoutId,
      fulfillment: {
        destination: {
          name: ctx.address.name,
          line1: ctx.address.line1,
          line2: ctx.address.line2,
          city: ctx.address.city,
          region: ctx.address.state,
          postal_code: ctx.address.zip,
          country: "US",
        },
        method: "standard_2day",
      },
      totals: {
        subtotal: ctx.subtotal.toFixed(2),
        shipping: ctx.shipping.toFixed(2),
        discount: (-ctx.discount).toFixed(2),
        tax: ctx.tax.toFixed(2),
        total: ctx.total.toFixed(2),
        currency: "USD",
      },
      status: "ready_for_payment",
    },
  }),

  cartMandate: (ctx) => {
    const id = ucpId("cart");
    return {
      layer: "AP2", tag: "AP2", kind: "mandate",
      name: "Cart Mandate",
      method: "VDC · signed",
      desc: "The finalized cart — exact items, merchant, and total — is sealed into a Cart Mandate. The merchant counter-signs it, giving cryptographic proof of what was agreed before any money moves.",
      payload: {
        type: "CartMandate",
        id,
        derived_from: "IntentMandate",
        checkout_id: ctx.checkoutId,
        merchant: ctx.merchant.domain,
        items: ctx.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price.toFixed(2) })),
        total: { amount: ctx.total.toFixed(2), currency: "USD" },
        within_intent: true,
      },
      mandate: {
        kind: "Cart Mandate",
        id,
        seal: "user + merchant",
        rows: [
          ["merchant", ctx.merchant.name],
          ["items", ctx.items.reduce((a, i) => a + i.qty, 0) + " line items"],
          ["total", money(ctx.total)],
          ["≤ intent max", "$300.00 ✓"],
        ],
        sig: "ey" + shortHash(40),
      },
    };
  },

  mintInstrument: () => ({
    layer: "UCP", tag: "UCP", kind: "request",
    name: "Mint Instrument · Google Pay",
    method: "payment_handler.mint()",
    desc: "The selected payment handler (com.google.pay) tokenizes a card and returns a single-use, network-tokenized instrument. The raw card number is never exposed to the agent or merchant.",
    payload: {
      handler: "com.google.pay",
      instrument: {
        type: "network_token",
        token: "tok_" + shortHash(24),
        network: "visa",
        last4: "4291",
        single_use: true,
      },
      cryptogram: shortHash(28).toUpperCase(),
    },
  }),

  paymentMandate: (ctx) => {
    const id = ucpId("pay");
    return {
      layer: "AP2", tag: "AP2", kind: "mandate",
      name: "Payment Mandate",
      method: "VDC · signed",
      desc: "Linked to the Cart Mandate, the Payment Mandate authorizes exactly this amount to this merchant via this instrument. Approved with a device biometric in the Google Pay sheet.",
      payload: {
        type: "PaymentMandate",
        id,
        cart_mandate: ctx.cartId,
        handler: "com.google.pay",
        amount: { value: ctx.total.toFixed(2), currency: "USD" },
        payee: ctx.merchant.domain,
        authorized_by: "device_biometric",
      },
      mandate: {
        kind: "Payment Mandate",
        id,
        seal: "user · biometric",
        rows: [
          ["handler", "Google Pay"],
          ["amount", money(ctx.total)],
          ["payee", ctx.merchant.name],
          ["links cart", "✓"],
        ],
        sig: "ey" + shortHash(40),
      },
    };
  },

  completeCheckout: (ctx) => ({
    layer: "UCP", tag: "UCP", kind: "response",
    name: "Complete Checkout · Order Created",
    method: "POST /checkout/{id}/complete",
    desc: "The minted instrument and Payment Mandate are submitted. The merchant captures payment and returns a confirmed order.",
    payload: {
      checkout_id: ctx.checkoutId,
      order: {
        id: ctx.orderId,
        status: "confirmed",
        total: { amount: ctx.total.toFixed(2), currency: "USD" },
        payment: { status: "captured", handler: "com.google.pay", last4: "4291" },
        estimated_delivery: ctx.eta,
      },
      receipts: { cart_mandate: ctx.cartId, payment_mandate: ctx.payId },
    },
  }),

  webhook: (ctx) => ({
    layer: "UCP", tag: "UCP", kind: "response",
    name: "Order Webhook · Shipped",
    method: "POST {agent}/webhooks/ucp",
    desc: "Later, the merchant's fulfillment center emits a shipment event. UCP pushes it to Shoppy's webhook so the agent can proactively update you.",
    payload: {
      event: "order.shipped",
      order_id: ctx.orderId,
      carrier: "UPS",
      tracking: "1Z" + shortHash(16).toUpperCase(),
      estimated_delivery: ctx.eta,
    },
  }),
};

window.SHOPPY = { MERCHANTS, PRODUCTS, ACCESSORY, DEFAULT_ADDRESS, CONSTRAINTS, USER_INTENT_TEXT, TRACE, money, shortHash, nowISO, ucpId };
