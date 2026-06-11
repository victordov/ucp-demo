import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempConfigPath = path.join(__dirname, "ngrok-temp-config.yaml");

// Ports matching packages/common/src/config.ts
const PORTS = {
  agent: 4100,
  merchant: 4101,
  credentials: 4102,
  payments: 4103,
  gateway: 4099, // The single exposed port
};

// Create a temp ngrok configuration file using version 2 (exposing ONLY the gateway)
const ngrokConfig = `
version: "2"
tunnels:
  gateway:
    proto: http
    addr: ${PORTS.gateway}
`;

fs.writeFileSync(tempConfigPath, ngrokConfig.trim());

// Try to find the default ngrok config path to merge authentication token
function getDefaultConfigPath(): string | null {
  const home = os.homedir();
  const paths = [
    path.join(home, "Library/Application Support/ngrok/ngrok.yml"),
    path.join(home, ".config/ngrok/ngrok.yml"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let isCleanedUp = false;
let ngrokProcess: ChildProcess | null = null;
const localtunnelProcesses: ChildProcess[] = [];
let appProcess: ChildProcess | null = null;
let gatewayServer: http.Server | null = null;

function cleanup() {
  if (isCleanedUp) return;
  isCleanedUp = true;
  console.log("\n[tunnel-setup] Cleaning up resources...");
  try {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
  } catch (err) {
    console.error("[tunnel-setup] Failed to remove temp config:", err);
  }
  if (ngrokProcess) {
    ngrokProcess.kill();
  }
  for (const p of localtunnelProcesses) {
    p.kill();
  }
  if (appProcess) {
    appProcess.kill();
  }
  if (gatewayServer) {
    gatewayServer.close();
  }
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

// Poll ngrok API for the gateway URL
async function getNgrokUrl(): Promise<string> {
  const url = "http://127.0.0.1:4040/api/tunnels";
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any = await res.json();
      const tunnels = data.tunnels || [];
      for (const t of tunnels) {
        if (t.name === "gateway") {
          return t.public_url;
        }
      }
    } catch {
      // API not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timeout waiting for ngrok tunnel to be established");
}

// Start localtunnel for the gateway port
function startLocaltunnel(port: number): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["localtunnel", "--port", String(port)]);
    localtunnelProcesses.push(p);

    let resolved = false;

    p.stdout.on("data", (data) => {
      const text = data.toString();
      const match = text.match(/your url is: (https:\/\/[^\s]+)/);
      if (match) {
        resolved = true;
        resolve({ process: p, url: match[1].trim() });
      }
    });

    p.stderr.on("data", (data) => {
      const text = data.toString();
      if (text.includes("error") || text.includes("ERR_")) {
        console.warn(`[localtunnel-warn] ${text.trim()}`);
      }
    });

    p.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    p.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Localtunnel exited early with code ${code}`));
      }
    });
  });
}

// Start reverse proxy gateway on port 4099
function startGateway() {
  gatewayServer = http.createServer((req, res) => {
    const urlPath = req.url || "/";
    let targetPort = PORTS.agent;
    let targetPath = urlPath;

    // Route based on prefix
    if (urlPath === "/merchant" || urlPath.startsWith("/merchant/")) {
      targetPort = PORTS.merchant;
      targetPath = urlPath === "/merchant" ? "/" : urlPath.slice("/merchant".length);
    } else if (urlPath === "/credentials" || urlPath.startsWith("/credentials/")) {
      targetPort = PORTS.credentials;
      targetPath = urlPath === "/credentials" ? "/" : urlPath.slice("/credentials".length);
    } else if (urlPath === "/payments" || urlPath.startsWith("/payments/")) {
      targetPort = PORTS.payments;
      targetPath = urlPath === "/payments" ? "/" : urlPath.slice("/payments".length);
    } else if (urlPath === "/api/portal" || urlPath.startsWith("/api/portal/")) {
      targetPort = PORTS.merchant;
      targetPath = urlPath;
    } else if (urlPath === "/api/wallet" || urlPath.startsWith("/api/wallet/")) {
      targetPort = PORTS.credentials;
      targetPath = urlPath;
    } else if (urlPath === "/api/psp" || urlPath.startsWith("/api/psp/")) {
      targetPort = PORTS.payments;
      targetPath = urlPath;
    }

    // Ensure targetPath starts with "/"
    if (!targetPath.startsWith("/")) {
      targetPath = "/" + targetPath;
    }

    const originalHost = req.headers.host || "";
    const headers = { ...req.headers };

    // Set original host and path for PKI signature verification bypass
    headers["x-original-host"] = originalHost;
    headers["x-original-path"] = urlPath;
    // Bypass localtunnel warning interstitials
    headers["bypass-tunnel-reminder"] = "true";
    // Direct request to the correct local port
    headers["host"] = `localhost:${targetPort}`;

    const proxyReq = http.request({
      host: "localhost",
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      console.error(`[gateway-error] Failed to proxy ${urlPath} to port ${targetPort}:`, err.message);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Bad Gateway: ${err.message}`);
    });

    req.pipe(proxyReq);
  });

  gatewayServer.listen(PORTS.gateway, () => {
    console.log(`[gateway] Native reverse proxy gateway listening on port ${PORTS.gateway}`);
  });
}

async function main() {
  // 1. Start the reverse proxy gateway
  startGateway();

  console.log("[tunnel-setup] Attempting to expose gateway via ngrok...");

  let ngrokFailed = false;
  let ngrokErrorMsg = "";

  const defaultConfigPath = getDefaultConfigPath();
  const ngrokArgs = ["start", "gateway"];

  if (defaultConfigPath) {
    ngrokArgs.push("--config", defaultConfigPath);
  }
  ngrokArgs.push("--config", tempConfigPath);

  // Start ngrok with stdout and stderr piped
  ngrokProcess = spawn("ngrok", ngrokArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  ngrokProcess.on("error", (err) => {
    ngrokFailed = true;
    ngrokErrorMsg = err.message;
  });

  const handleNgrokOutput = (data: Buffer) => {
    const text = data.toString();
    if (text.includes("error") || text.includes("ERR_") || text.includes("failed to start tunnel") || text.includes("account may not run more than")) {
      ngrokFailed = true;
      ngrokErrorMsg = text.trim().split("\n")[0];
      ngrokProcess?.kill();
    }
  };

  ngrokProcess.stdout?.on("data", handleNgrokOutput);
  ngrokProcess.stderr?.on("data", handleNgrokOutput);

  // Wait 1.5 seconds to see if ngrok fails immediately
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let gatewayUrl = "";

  if (!ngrokFailed) {
    try {
      gatewayUrl = await getNgrokUrl();
      console.log("\n[tunnel-setup] Ngrok tunnel established successfully.");
    } catch (err: any) {
      ngrokFailed = true;
      ngrokErrorMsg = err.message;
      if (ngrokProcess) {
        ngrokProcess.kill();
        ngrokProcess = null;
      }
    }
  }

  // Fallback to Localtunnel if ngrok fails
  if (ngrokFailed) {
    console.log(`\n[tunnel-setup] Ngrok failed: ${ngrokErrorMsg}`);
    console.log("[tunnel-setup] Falling back to Localtunnel...");

    try {
      const res = await startLocaltunnel(PORTS.gateway);
      gatewayUrl = res.url;
      console.log("\n[tunnel-setup] Localtunnel tunnel established successfully.");
    } catch (err: any) {
      console.error(`\n[tunnel-setup] Localtunnel fallback failed: ${err.message}`);
      cleanup();
      return;
    }
  }

  // Map the single tunnel URL to path prefixes
  const urls = {
    agent: gatewayUrl,
    merchant: `${gatewayUrl}/merchant`,
    credentials: `${gatewayUrl}/credentials`,
    payments: `${gatewayUrl}/payments`,
  };

  // Log Tunnel Setup
  console.log(`  Tunnel Endpoint:      ${gatewayUrl}`);
  console.log(`  Shopping Agent:       ${urls.agent}`);
  console.log(`  Merchant Portal:      ${urls.merchant}`);
  console.log(`  Credentials Provider: ${urls.credentials}`);
  console.log(`  Payment Provider:     ${urls.payments}\n`);

  // Start application servers with environment variables
  const env = {
    ...process.env,
    AGENT_URL: urls.agent,
    MERCHANT_URL: urls.merchant,
    CREDENTIALS_URL: urls.credentials,
    PAYMENTS_URL: urls.payments,
    RP_ID: new URL(urls.credentials).hostname,
  };

  console.log("[tunnel-setup] Starting application servers...");
  appProcess = spawn(
    "npx",
    [
      "concurrently",
      "-n",
      "agent,merchant,credentials,payments",
      "-c",
      "blue,green,magenta,yellow",
      "npm run dev:agent",
      "npm run dev:merchant",
      "npm run dev:credentials",
      "npm run dev:payments",
    ],
    {
      stdio: "inherit",
      env,
    }
  );

  appProcess.on("exit", (code) => {
    console.log(`[tunnel-setup] App servers exited with code ${code}`);
    cleanup();
  });
}

main().catch((err) => {
  console.error("[tunnel-setup] Unexpected error:", err);
  cleanup();
});
