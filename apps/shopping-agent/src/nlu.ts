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
  query: string;
  engine: "deterministic" | "llm";
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
    if (process.env.OPENAI_API_KEY) return await parseWithOpenAI(text, process.env.OPENAI_API_KEY);
    if (process.env.ANTHROPIC_API_KEY) return await parseWithAnthropic(text, process.env.ANTHROPIC_API_KEY);
  } catch (e: any) {
    console.warn(`[agent] LLM intent parsing failed (${e.message}) — falling back to deterministic parser`);
  }
  return parseDeterministic(text);
}
