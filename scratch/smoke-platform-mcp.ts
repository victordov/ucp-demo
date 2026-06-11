// In-process smoke test: boots the agent server (same module = same signing key),
// runs merchant separately, then exercises the new platform /mcp endpoint.
import "../apps/shopping-agent/src/server.ts";
import { callTool } from "../packages/common/src/jsonrpc.ts";
import { agentKey } from "../apps/shopping-agent/src/orchestrator.ts";
import { AGENT_PROFILE_URL } from "../packages/common/src/config.ts";

await new Promise((r) => setTimeout(r, 2500));
const id = { key: agentKey, profileUrl: AGENT_PROFILE_URL };
const r: any = await callTool("http://localhost:4100/mcp", "search_catalog", { query: "headphones" }, id);
console.log("aggregate products:", r.products.length);
const r2: any = await callTool("http://localhost:4100/mcp", "search_catalog", { query: "headphones", merchant_id: "wavelength" }, id);
console.log("single-merchant products:", r2.products.length);
const r3: any = await callTool("http://localhost:4100/mcp", "get_product", { id: r2.products[0].id, merchant_id: "wavelength" }, id);
console.log("get_product:", r3.product?.title ?? r3.product?.id ?? Object.keys(r3));
process.exit(0);
