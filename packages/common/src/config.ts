// Bypass localtunnel warning pages for all server-to-server and script-to-server requests
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const newInit = { ...init };
  const headers = new Headers(newInit.headers);
  headers.set("Bypass-Tunnel-Reminder", "true");
  newInit.headers = headers as any;
  return originalFetch(input, newInit);
};

/** Service topology (single-host demo deployment). */
const HOST = process.env.UCP_HOST ?? "localhost";

export const PORTS = {
  shoppingAgent: Number(process.env.AGENT_PORT ?? 4100),
  merchantPortal: Number(process.env.MERCHANT_PORT ?? 4101),
  credentialsProvider: Number(process.env.CREDENTIALS_PORT ?? 4102),
  paymentProvider: Number(process.env.PAYMENTS_PORT ?? 4103),
};

export const URLS = {
  shoppingAgent: process.env.AGENT_URL ?? `http://${HOST}:${PORTS.shoppingAgent}`,
  merchantPortal: process.env.MERCHANT_URL ?? `http://${HOST}:${PORTS.merchantPortal}`,
  credentialsProvider: process.env.CREDENTIALS_URL ?? `http://${HOST}:${PORTS.credentialsProvider}`,
  paymentProvider: process.env.PAYMENTS_URL ?? `http://${HOST}:${PORTS.paymentProvider}`,
};

export const AGENT_PROFILE_URL = `${URLS.shoppingAgent}/.well-known/ucp`;
export const CREDENTIALS_PROFILE_URL = `${URLS.credentialsProvider}/.well-known/ucp`;
export const PAYMENTS_PROFILE_URL = `${URLS.paymentProvider}/.well-known/ucp`;
export const merchantProfileUrl = (merchantId: string) =>
  `${URLS.merchantPortal}/m/${merchantId}/.well-known/ucp`;
export const merchantMcpUrl = (merchantId: string) => `${URLS.merchantPortal}/m/${merchantId}/mcp`;

/**
 * AP2 short-term trust model: decentralized, manually curated allowlists.
 * For the demo every first-party service trusts the other three.
 */
export function defaultTrust(profileUrl: string): boolean {
  return [URLS.shoppingAgent, URLS.merchantPortal, URLS.credentialsProvider, URLS.paymentProvider].some((u) =>
    profileUrl.startsWith(u)
  );
}
