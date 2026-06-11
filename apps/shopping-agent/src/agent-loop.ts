/**
 * LLM agentic loop (#17). When OPENAI_API_KEY or ANTHROPIC_API_KEY is set, an
 * LLM drives the UCP/AP2 flow by calling agent tools (search → select →
 * checkout → pay) instead of following a hardcoded script. Each tool maps to
 * an orchestrator primitive, so every action is still a real signed protocol
 * call visible in the trace. Falls back to the deterministic flow on any error.
 */
import type { Session } from "./orchestrator.ts";
import { runIntent, select, addItem, createCheckout, selectShipping, applyPromo, preparePayment, confirmAndPay } from "./orchestrator.ts";

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (s: Session, args: any) => Promise<unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: "search_products",
    description: "Search merchants for products matching the user's request. Call this first.",
    parameters: { type: "object", properties: { request: { type: "string", description: "The user's full shopping request including budget and constraints." } }, required: ["request"] },
    run: async (s, a) => {
      const r = await runIntent(s, a.request);
      return { products: r.products.map((p: any) => ({ id: p.id, name: p.name, recommended: p.recommended, offers: p.offers.map((o: any) => ({ merchant: o.merchant, price: o.price })) })), merchants: Object.keys(r.merchants) };
    },
  },
  {
    name: "select_offer",
    description: "Choose a product from a specific merchant to buy.",
    parameters: { type: "object", properties: { product_id: { type: "string" }, merchant_id: { type: "string" } }, required: ["product_id", "merchant_id"] },
    run: async (s, a) => select(s, a.product_id, a.merchant_id),
  },
  {
    name: "go_to_checkout",
    description: "Open a checkout for the selected product. Returns totals.",
    parameters: { type: "object", properties: {} },
    run: async (s) => createCheckout(s),
  },
  {
    name: "set_shipping",
    description: "Choose a shipping option: standard_2day or express_next_day.",
    parameters: { type: "object", properties: { option_id: { type: "string" } }, required: ["option_id"] },
    run: async (s, a) => selectShipping(s, a.option_id),
  },
  {
    name: "apply_discount",
    description: "Apply a discount/promo code (e.g. SHOPPY10, SAVE20).",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    run: async (s, a) => applyPromo(s, a.code),
  },
  {
    name: "pay",
    description: "Prepare payment and complete the purchase. Call last.",
    parameters: { type: "object", properties: {} },
    run: async (s) => {
      await preparePayment(s);
      return confirmAndPay(s);
    },
  },
];

/**
 * Tools for the interactive chat. The LLM assembles the cart; it does NOT pay —
 * the user reviews the checkout card and pays via the Google Pay button. This
 * keeps the human-in-the-loop checkout UI identical to the scripted flow.
 */
const CHAT_TOOLS: ToolSpec[] = [
  TOOLS.find((t) => t.name === "search_products")!,
  {
    name: "add_to_cart",
    description: "Add a product from a specific merchant to the cart. Call once per item; call again to add more. All items must be from the same merchant.",
    parameters: { type: "object", properties: { product_id: { type: "string" }, merchant_id: { type: "string" } }, required: ["product_id", "merchant_id"] },
    run: async (s, a) => addItem(s, a.product_id, a.merchant_id),
  },
  {
    name: "open_checkout",
    description: "Open/refresh the checkout for everything in the cart. Call after the user is done adding items. Returns the line items and total. The user pays from the checkout card — do not try to pay yourself.",
    parameters: { type: "object", properties: {} },
    run: async (s) => createCheckout(s),
  },
  {
    name: "set_shipping",
    description: "Choose a shipping option: standard_2day or express_next_day.",
    parameters: { type: "object", properties: { option_id: { type: "string" } }, required: ["option_id"] },
    run: async (s, a) => selectShipping(s, a.option_id),
  },
  {
    name: "apply_discount",
    description: "Apply a discount/promo code (e.g. SHOPPY10, SAVE20).",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    run: async (s, a) => applyPromo(s, a.code),
  },
];

const SYSTEM =
  "You are Shoppy, an autonomous shopping agent using the Universal Commerce Protocol. " +
  "Fulfil the user's request by calling tools: search first, pick the best offer that meets their constraints, " +
  "open checkout, optionally set shipping or apply a discount they mention, then pay. " +
  "Prefer the recommended product and the lowest-price merchant unless the user says otherwise. Be decisive.";

// Interactive, human-in-the-loop chat: the LLM reasons turn by turn, presents
// options and ASKS before committing — the user stays in control.
const CHAT_SYSTEM =
  "You are Shoppy, a helpful shopping assistant built on the Universal Commerce Protocol (UCP) and Agent Payments Protocol (AP2). " +
  "You act on the user's behalf by calling tools, but you keep the user in the loop and converse naturally. Guidelines:\n" +
  "1. When the user describes what they want, call search_products, then PRESENT the options conversationally (name, merchant, price) and ask which they'd like.\n" +
  "2. When they pick an item, call add_to_cart. They may add several items (call add_to_cart again each time) — all from the same merchant. Ask if they want anything else.\n" +
  "3. When the user is ready, call open_checkout. Then tell them their cart and total are shown in the checkout card below, and to review it and click 'Pay with Google Pay' to complete the purchase.\n" +
  "4. You do NOT have a pay tool and you MUST NOT try to pay. Payment is done by the user from the checkout card. If they say 'pay', tell them to click the 'Pay with Google Pay' button in the checkout card.\n" +
  "5. If they ask for express shipping or give a discount code, call set_shipping / apply_discount (then re-run open_checkout if needed).\n" +
  "6. Keep replies short and friendly. Amounts you receive are already in dollars. You may call multiple tools in one turn, but stop and return text whenever you need the user's input.";

export function llmAgentEnabled() {
  return !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export function llmProvider(): "openai" | "anthropic" | null {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

/**
 * One conversational turn: append the user's message to the session's chat
 * history, let the LLM reason + call tools (real signed protocol calls), and
 * return its natural-language reply plus the tools it ran this turn. The
 * history persists on the session so the conversation continues across turns.
 */
export async function chatTurn(s: Session, userText: string, maxSteps = 6): Promise<{ reply: string; steps: any[]; engine: string }> {
  const provider = llmProvider();
  if (!provider) throw new Error("no LLM key configured");
  if (provider === "openai") return openaiChat(s, userText, maxSteps);
  return anthropicChat(s, userText, maxSteps);
}

async function openaiChat(s: Session, userText: string, maxSteps: number) {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const tools = CHAT_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const history: any[] = (s.chatHistory ??= []);
  history.push({ role: "user", content: userText });
  const steps: any[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: CHAT_SYSTEM }, ...history], tools, tool_choice: "auto", temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message;
    history.push(msg);
    if (!msg.tool_calls?.length) return { reply: msg.content ?? "", steps, engine: "openai" };
    for (const tc of msg.tool_calls) {
      const tool = CHAT_TOOLS.find((t) => t.name === tc.function.name);
      let result: unknown;
      try { result = tool ? await tool.run(s, JSON.parse(tc.function.arguments || "{}")) : { error: "unknown tool" }; }
      catch (e: any) { result = { error: e.message }; }
      steps.push({ tool: tc.function.name, args: tc.function.arguments, result });
      history.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 2000) });
    }
  }
  return { reply: "(I took several steps — let me know how you'd like to proceed.)", steps, engine: "openai" };
}

async function anthropicChat(s: Session, userText: string, maxSteps: number) {
  const key = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const tools = CHAT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const history: any[] = (s.chatHistory ??= []);
  history.push({ role: "user", content: userText });
  const steps: any[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1024, system: CHAT_SYSTEM, tools, messages: history }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    history.push({ role: "assistant", content: data.content });
    const toolUses = (data.content ?? []).filter((c: any) => c.type === "tool_use");
    const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
    if (!toolUses.length) return { reply: text || "", steps, engine: "anthropic" };
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const tool = CHAT_TOOLS.find((t) => t.name === tu.name);
      let result: unknown;
      try { result = tool ? await tool.run(s, tu.input ?? {}) : { error: "unknown tool" }; }
      catch (e: any) { result = { error: e.message }; }
      steps.push({ tool: tu.name, args: tu.input, result });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 2000) });
    }
    history.push({ role: "user", content: toolResults });
    if (text) return { reply: text, steps, engine: "anthropic" }; // assistant spoke + acted → yield to user
  }
  return { reply: "(I took several steps — let me know how you'd like to proceed.)", steps, engine: "anthropic" };
}

/** Run the LLM tool-calling loop. Returns a transcript of tool calls + final text. */
export async function runAgentLoop(s: Session, goal: string, maxSteps = 8): Promise<{ steps: any[]; final: string; engine: string }> {
  if (process.env.OPENAI_API_KEY) return openaiLoop(s, goal, maxSteps);
  if (process.env.ANTHROPIC_API_KEY) return anthropicLoop(s, goal, maxSteps);
  throw new Error("no LLM key configured");
}

async function openaiLoop(s: Session, goal: string, maxSteps: number) {
  const key = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const messages: any[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: goal },
  ];
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const steps: any[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0 }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return { steps, final: msg.content ?? "Done.", engine: "openai" };
    for (const tc of msg.tool_calls) {
      const tool = CHAT_TOOLS.find((t) => t.name === tc.function.name);
      let result: unknown;
      try {
        result = tool ? await tool.run(s, JSON.parse(tc.function.arguments || "{}")) : { error: "unknown tool" };
      } catch (e: any) {
        result = { error: e.message };
      }
      steps.push({ tool: tc.function.name, args: tc.function.arguments, result });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 2000) });
    }
  }
  return { steps, final: "Reached step limit.", engine: "openai" };
}

async function anthropicLoop(s: Session, goal: string, maxSteps: number) {
  const key = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages: any[] = [{ role: "user", content: goal }];
  const steps: any[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM, tools, messages }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data: any = await res.json();
    messages.push({ role: "assistant", content: data.content });
    const toolUses = (data.content ?? []).filter((c: any) => c.type === "tool_use");
    if (!toolUses.length) {
      const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
      return { steps, final: text || "Done.", engine: "anthropic" };
    }
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const tool = CHAT_TOOLS.find((t) => t.name === tu.name);
      let result: unknown;
      try {
        result = tool ? await tool.run(s, tu.input ?? {}) : { error: "unknown tool" };
      } catch (e: any) {
        result = { error: e.message };
      }
      steps.push({ tool: tu.name, args: tu.input, result });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 2000) });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { steps, final: "Reached step limit.", engine: "anthropic" };
}
