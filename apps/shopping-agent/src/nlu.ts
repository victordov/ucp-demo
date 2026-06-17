/**
 * Intent understanding for the Shopping Agent.
 * Deterministic parser by default; if OPENAI_API_KEY or ANTHROPIC_API_KEY is
 * set, an LLM extracts the constraints instead — with deterministic fallback.
 */
export interface ParsedIntent {
  category?: string;
  required_features: string[];
  max_total?: number;
  delivery_days?: number;
  /** Human-not-present: the user asked the agent to buy on its own. */
  autonomous?: boolean;
  /** Conditional cap from "buy if it drops below $X" — sets the open Payment
   *  Mandate amount_range (dollars). Implies autonomous. */
  buy_below?: number;
  query: string;
  engine: "deterministic" | "llm";
}

const AUTONOMY_RE =
  /\b(autonomous(?:ly)?|human[ -]?not[ -]?present|on my behalf|without me|while i'?m away|you decide|don'?t ask|just buy it|buy it for me|purchase it for me|go ahead and buy|buy the best)\b/i;

/**
 * Deterministic detection of human-not-present intent and an optional conditional
 * price cap ("buy if it drops below $X"). Runs for both the deterministic and LLM
 * parsers so autonomy is recognised reliably from the chat text itself.
 */
export function detectAutonomy(text: string): { autonomous: boolean; buy_below?: number } {
  const drop =
    text.match(/(?:buy|purchase|get|grab|snag|order)[^.]*?(?:if|when|once)[^.]*?(?:drops?|falls?|goes?|below|under|less than|<=|≤)\s*\$?\s*([\d,]+)/i) ??
    text.match(/(?:if|when|once)[^.]*?(?:drops?|falls?|below|under)\s*\$?\s*([\d,]+)/i);
  const buy_below = drop ? Number(drop[1].replace(/,/g, "")) : undefined;
  const autonomous = AUTONOMY_RE.test(text) || buy_below != null;
  return { autonomous, ...(buy_below != null ? { buy_below } : {}) };
}

export function parseDeterministic(text: string): ParsedIntent {
  const t = text.toLowerCase();
  const out: ParsedIntent = { required_features: [], query: text.trim(), engine: "deterministic" };

  const budget =
    t.match(/under\s*\$?\s*([\d,]+)/) ??
    t.match(/below\s*\$?\s*([\d,]+)/) ??
    t.match(/budget(?:\s*(?:is|of))?\s*\$?\s*([\d,]+)/) ??
    t.match(/(?:max|maximum|up to)\s*\$?\s*([\d,]+)/) ??
    t.match(/\$\s*([\d,]+)/);
  if (budget) out.max_total = Number(budget[1].replace(/,/g, ""));

  const days =
    t.match(/within\s*(\d+)\s*days?/) ??
    t.match(/in\s*(\d+)\s*days?/) ??
    t.match(/(\d+)[\s-]*day (?:delivery|shipping)/);
  if (days) out.delivery_days = Number(days[1]);
  if (/next[\s-]*day|tomorrow|overnight/.test(t)) out.delivery_days = 1;
  if (/two[\s-]*day|2[\s-]*day/.test(t)) out.delivery_days = 2;

  if (/noise[\s-]*cancel/.test(t) || /\banc\b/.test(t)) out.required_features.push("noise-cancelling");
  if (/over[\s-]*ear/.test(t)) out.required_features.push("over-ear");
  if (/wireless|bluetooth/.test(t)) out.required_features.push("wireless");

  if (/headphone|headset|earphone|ear ?bud/.test(t)) out.category = "headphones";
  else if (/speaker/.test(t)) out.category = "speakers";
  else if (/case/.test(t)) out.category = "accessories";

  const a = detectAutonomy(text);
  out.autonomous = a.autonomous;
  if (a.buy_below != null) out.buy_below = a.buy_below;

  return out;
}

const SYSTEM_PROMPT =
  'Extract shopping constraints from the user message. Reply with ONLY a JSON object: {"category": string|null, "required_features": string[], "max_total": number|null, "delivery_days": number|null}. Features should be kebab-case attribute words like "noise-cancelling", "over-ear".';

function fromLlmJson(text: string, raw: string): ParsedIntent {
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return {
    category: parsed.category ?? undefined,
    required_features: Array.isArray(parsed.required_features) ? parsed.required_features : [],
    max_total: parsed.max_total ?? undefined,
    delivery_days: parsed.delivery_days ?? undefined,
    query: text.trim(),
    engine: "llm",
  };
}

async function parseWithOpenAI(text: string, apiKey: string): Promise<ParsedIntent> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      max_tokens: 300,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data: any = await res.json();
  return fromLlmJson(text, data.choices?.[0]?.message?.content ?? "");
}

async function parseWithAnthropic(text: string, apiKey: string): Promise<ParsedIntent> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data: any = await res.json();
  return fromLlmJson(text, data.content?.[0]?.text ?? "");
}

export function llmEnabled(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export async function parseIntent(text: string): Promise<ParsedIntent> {
  try {
    if (process.env.OPENAI_API_KEY) return mergeAutonomy(text, await parseWithOpenAI(text, process.env.OPENAI_API_KEY));
    if (process.env.ANTHROPIC_API_KEY) return mergeAutonomy(text, await parseWithAnthropic(text, process.env.ANTHROPIC_API_KEY));
  } catch (e: any) {
    console.warn(`[agent] LLM intent parsing failed (${e.message}) — falling back to deterministic parser`);
  }
  return parseDeterministic(text);
}

/** Merge deterministic autonomy detection onto an LLM-parsed intent. */
function mergeAutonomy(text: string, base: ParsedIntent): ParsedIntent {
  const a = detectAutonomy(text);
  return { ...base, autonomous: a.autonomous || base.autonomous, buy_below: a.buy_below ?? base.buy_below };
}
