/** Seed catalog for the four demo merchants (mirrors the Shoppy demo data). */
import type { CatalogProduct } from "../../../packages/common/src/types.ts";

export interface MerchantSeed {
  id: string;
  name: string;
  color: string;
  short: string;
  domain: string;
  rating: number;
  catalog: CatalogProduct[];
}

const CADENCE = {
  id: "cadence-anc-pro",
  image: "/img/cadence-anc-pro.webp",
  name: "Cadence ANC Pro",
  brand: "Northwave Audio",
  specs: [
    { label: "Over-ear", match: true },
    { label: "Hybrid ANC", match: true },
    { label: "32h battery" },
    { label: "Multipoint" },
  ],
  note: "Class-leading noise cancelling with a warm, balanced signature. Comfortable clamp for long sessions.",
  attributes: ["over-ear", "anc", "headphones", "noise-cancelling", "hybrid-anc"],
};

const HALO = {
  id: "halo-studio-nc",
  image: "/img/halo-studio-nc.webp",
  name: "Halo Studio NC",
  brand: "Auralis",
  specs: [
    { label: "Over-ear", match: true },
    { label: "Adaptive ANC", match: true },
    { label: "40h battery" },
    { label: "Lightweight" },
  ],
  note: "Longest battery of the group and the lightest on your head. Excellent ANC for voices.",
  attributes: ["over-ear", "anc", "headphones", "noise-cancelling", "adaptive-anc"],
};

const LUMEN = {
  id: "lumen-air-max",
  image: "/img/lumen-air-max.webp",
  name: "Lumen Air Max",
  brand: "Vance",
  specs: [
    { label: "Over-ear", match: true },
    { label: "ANC", match: true },
    { label: "28h battery" },
    { label: "Budget pick" },
  ],
  note: "The value option, comfortably under budget. Solid ANC for the price.",
  attributes: ["over-ear", "anc", "headphones", "noise-cancelling", "budget"],
};

const HARDCASE = {
  id: "travel-hardcase",
  image: "/img/travel-hardcase.webp",
  name: "Cadence Travel Hardcase",
  brand: "Northwave Audio",
  specs: [{ label: "Molded zip case" }, { label: "Cable pouch" }],
  note: "Molded zip case + cable pouch, sized for the Cadence ANC Pro.",
  attributes: ["accessory", "case", "headphones"],
  accessory_for: "cadence-anc-pro",
};


const PULSE = {
  id: "pulse-buds-pro",
  image: "/img/pulse-buds-pro.webp",
  name: "Pulse Buds Pro",
  brand: "Northwave Audio",
  specs: [
    { label: "In-ear TWS", match: true },
    { label: "ANC", match: true },
    { label: "8h + 24h case" },
    { label: "IPX4" },
  ],
  note: "True-wireless ANC buds with the same tuning as the Cadence line. Pocketable everyday carry.",
  attributes: ["in-ear", "earbuds", "anc", "noise-cancelling", "tws", "wireless"],
};

const ARIA = {
  id: "aria-open-air",
  image: "/img/aria-open-air.webp",
  name: "Aria Open-Air",
  brand: "Auralis",
  specs: [
    { label: "Over-ear", match: true },
    { label: "Open-back" },
    { label: "Wired · 3.5mm" },
    { label: "Studio tuning" },
  ],
  note: "Open-back reference cans for quiet rooms — huge soundstage, zero isolation by design.",
  attributes: ["over-ear", "open-back", "headphones", "wired", "audiophile", "studio"],
};

const NOVA = {
  id: "nova-go-speaker",
  image: "/img/nova-go-speaker.webp",
  name: "Nova Go",
  brand: "Vance",
  specs: [
    { label: "Portable BT speaker", match: true },
    { label: "14h battery" },
    { label: "IP67" },
    { label: "USB-C" },
  ],
  note: "Palm-sized Bluetooth speaker that survives the beach. Surprising low end for the size.",
  attributes: ["speaker", "bluetooth", "portable", "waterproof"],
};

const STAND = {
  id: "alu-stand",
  image: "/img/alu-stand.webp",
  name: "Auralis Alu Stand",
  brand: "Auralis",
  specs: [{ label: "Anodized aluminum" }, { label: "Non-slip base" }],
  note: "Weighted aluminum headphone stand — keeps the Halo (or anything else) off your desk.",
  attributes: ["accessory", "stand", "headphones"],
  accessory_for: "halo-studio-nc",
};


const TEMPO = {
  id: "tempo-sport-buds",
  image: "/img/tempo-sport-buds.webp",
  name: "Tempo Sport Buds",
  brand: "Vance",
  specs: [
    { label: "In-ear · ear hooks", match: true },
    { label: "IP55 sweatproof" },
    { label: "10h battery" },
    { label: "Ambient mode" },
  ],
  note: "Hooked sport buds that stay put through intervals. Ambient mode keeps you traffic-aware.",
  attributes: ["in-ear", "earbuds", "sport", "running", "wireless", "sweatproof"],
};

const DAC = {
  id: "vault-dac-amp",
  image: "/img/vault-dac-amp.webp",
  name: "Vault DAC-1",
  brand: "Northwave Audio",
  specs: [
    { label: "USB-C DAC/amp", match: true },
    { label: "32-bit / 384kHz" },
    { label: "4.4mm balanced" },
    { label: "Pocketable" },
  ],
  note: "Portable DAC/amp that makes wired headphones sing from a laptop or phone. Pairs well with the Aria.",
  attributes: ["dac", "amplifier", "usb-c", "audiophile", "wired", "accessory-electronics"],
};

const BOOM = {
  id: "boombar-300",
  image: "/img/boombar-300.webp",
  name: "BoomBar 300",
  brand: "Vance",
  specs: [
    { label: "Compact soundbar", match: true },
    { label: "Bluetooth + HDMI ARC" },
    { label: "Wall-mountable" },
    { label: "Night mode" },
  ],
  note: "Desk-to-TV soundbar with surprising width. HDMI ARC plus Bluetooth for the lazy evenings.",
  attributes: ["soundbar", "speaker", "bluetooth", "tv", "home-audio"],
};

const MIC = {
  id: "aria-cast-mic",
  image: "/img/aria-cast-mic.webp",
  name: "Aria Cast Mic",
  brand: "Auralis",
  specs: [
    { label: "USB condenser", match: true },
    { label: "Cardioid" },
    { label: "Tap-to-mute" },
    { label: "Desk stand incl." },
  ],
  note: "Podcast-ready USB condenser with a tight cardioid pattern — calls sound like broadcasts.",
  attributes: ["microphone", "mic", "usb", "podcast", "streaming", "recording"],
};

const PADS = {
  id: "aria-plush-pads",
  image: "/img/aria-plush-pads.webp",
  name: "Aria Plush Pads",
  brand: "Auralis",
  specs: [{ label: "Memory-foam earpads" }, { label: "Fits Aria Open-Air" }],
  note: "Replacement memory-foam pads for the Aria Open-Air — refresh the fit, deepen the bass.",
  attributes: ["accessory", "earpads", "headphones"],
  accessory_for: "aria-open-air",
};

const BUDSCASE = {
  id: "buds-shell-case",
  image: "/img/buds-shell-case.webp",
  name: "Pulse Shell Case",
  brand: "Northwave Audio",
  specs: [{ label: "Silicone shell" }, { label: "Carabiner clip" }],
  note: "Drop-proof silicone shell for the Pulse Buds charging case, with a carabiner for your pack.",
  attributes: ["accessory", "case", "earbuds"],
  accessory_for: "pulse-buds-pro",
};

export const MERCHANTS: MerchantSeed[] = [
  {
    id: "wavelength",
    name: "Wavelength",
    color: "#0ea5a4",
    short: "WL",
    domain: "shop.wavelength.example",
    rating: 4.8,
    catalog: [
      { ...CADENCE, price: 27400, was: 29900, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...LUMEN, price: 19400, was: null, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...HARDCASE, price: 3400, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...PULSE, price: 17900, was: 19900, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...DAC, price: 14900, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...BUDSCASE, price: 1900, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...TEMPO, price: 12900, was: 13900, ship: "Free 2-day", ship_days: 2, in_stock: true },
    ],
  },
  {
    id: "soundhub",
    name: "SoundHub",
    color: "#7c3aed",
    short: "SH",
    domain: "soundhub.example",
    rating: 4.6,
    catalog: [
      { ...CADENCE, price: 27900, was: null, ship: "2-day · $4.99", ship_days: 2, in_stock: true },
      { ...HALO, price: 25500, was: 26900, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...PULSE, price: 18400, was: null, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...ARIA, price: 24900, was: null, ship: "3-day · Free", ship_days: 3, in_stock: true },
      { ...TEMPO, price: 13400, was: null, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...MIC, price: 11900, was: 12900, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...BOOM, price: 19900, was: null, ship: "2-day · $4.99", ship_days: 2, in_stock: true },
    ],
  },
  {
    id: "electromart",
    name: "ElectroMart",
    color: "#ea580c",
    short: "EM",
    domain: "electromart.example",
    rating: 4.4,
    catalog: [
      { ...CADENCE, price: 28900, was: null, ship: "3–4 days · Free", ship_days: 4, in_stock: true },
      { ...LUMEN, price: 18900, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...NOVA, price: 8900, was: 9900, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...TEMPO, price: 12400, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...DAC, price: 15400, was: null, ship: "3–4 days · Free", ship_days: 4, in_stock: true },
      { ...BOOM, price: 18900, was: 21900, ship: "Free 2-day", ship_days: 2, in_stock: true },
    ],
  },
  {
    id: "audionest",
    name: "AudioNest",
    color: "#2563eb",
    short: "AN",
    domain: "audionest.example",
    rating: 4.7,
    catalog: [
      { ...HALO, price: 24900, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...ARIA, price: 25900, was: 27900, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...NOVA, price: 9400, was: null, ship: "2-day · Free", ship_days: 2, in_stock: true },
      { ...STAND, price: 4200, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...MIC, price: 12400, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
      { ...PADS, price: 2900, was: null, ship: "Free 2-day", ship_days: 2, in_stock: true },
    ],
  },
];
