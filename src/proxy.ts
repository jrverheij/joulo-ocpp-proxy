import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config";
import { ChargerConnection, maskUrl, maskString, maskIp, maskUrlForVisitor } from "./connection";
import { createLogger } from "./logger";
import { OCPP_SUBPROTOCOLS } from "./types";
import fs from "fs";
import path from "path";

const log = createLogger("proxy");
const startedAt = Date.now();

let version = { sha: "unknown", build: "local" };
try {
  const versionPath = path.join(process.cwd(), "version.json");
  if (fs.existsSync(versionPath)) {
    version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  }
} catch {
  // ignore
}

export function startProxy(config: Config) {
  const sessions = new Map<string, ChargerConnection>();

  const cleanExit = () => {
    log.info("Shutdown signal received, tearing down active sessions...");
    for (const session of sessions.values()) {
      try {
        session.teardown();
      } catch (err: any) {
        log.error("Error tearing down session during shutdown", { error: err.message });
      }
    }
    setTimeout(() => {
      process.exit(0);
    }, 500);
  };

  process.on("SIGTERM", cleanExit);
  process.on("SIGINT", cleanExit);

  const server = createServer((req, res) => {
    const url = req.url || "/";

    if (url === "/status") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getDashboardHtml(config));
      return;
    }

    if (url === "/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      const uptimeMs = Date.now() - startedAt;
      const metrics = {
        version,
        uptimeSeconds: Math.floor(uptimeMs / 1000),
        primaryUrl: maskUrlForVisitor(config.primaryCsms.url),
        secondaryUrls: config.secondaryCsms.map(u => maskUrlForVisitor(u.url)),
        activeSessionsCount: sessions.size,
        sessions: Array.from(sessions.values()).map(s => s.getMetrics()),
      };
      res.end(JSON.stringify(metrics, null, 2));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "joulo-ocpp-proxy is running.\n" +
        "Connect your charge point via WebSocket.\n"
    );
  });

  const wss = new WebSocketServer({
    server,
    autoPong: false,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) {
        if (protocols.has(p)) return p;
      }
      return false;
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const chargePointId = extractChargePointId(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url ? maskUrl(req.url) : undefined,
      });
      ws.close(1002, "Charge point ID required in URL path");
      return;
    }

    const protocol = ws.protocol;
    const authHeader = req.headers.authorization;
    const ipAddress = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "Unknown").split(",")[0].trim();

    log.info("charger connected", {
      chargePointId: maskString(chargePointId),
      protocol: protocol || "none",
      ip: maskIp(ipAddress),
    });

    const existing = sessions.get(chargePointId);
    if (existing) {
      log.info("replacing existing session", { chargePointId: maskString(chargePointId) });
      existing.teardown();
    }

    const conn = new ChargerConnection(
      ws,
      chargePointId,
      config.primaryCsms,
      config.secondaryCsms,
      config.queueDir ?? "./queue",
      protocol,
      authHeader,
      ipAddress,
      () => sessions.delete(chargePointId)
    );
    sessions.set(chargePointId, conn);
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  server.listen(config.port, () => {
    log.info("proxy listening", {
      port: config.port,
      primary: maskUrl(config.primaryCsms.url),
      secondaries: config.secondaryCsms.map(u => maskUrl(u.url)),
    });
  });

  const shutdown = () => {
    log.info("shutting down…");
    wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function extractChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const segments = url
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) return null;
  return segments[segments.length - 1];
}

function getDashboardHtml(config: Config): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OCPP Proxy</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      /* Apple Dark Palette (Default) */
      --canvas: #000000;
      --card-bg: rgba(28, 28, 30, 0.75);
      --card-solid-bg: #1c1c1e;
      --card-border: rgba(255, 255, 255, 0.12);
      --card-border-top: rgba(255, 255, 255, 0.22);
      --card-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);
      --row-bg: rgba(255, 255, 255, 0.04);
      --row-border: rgba(255, 255, 255, 0.06);
      --row-hover: rgba(255, 255, 255, 0.08);
      --hairline: rgba(255, 255, 255, 0.08);

      --text-primary: #f5f5f7;
      --text-secondary: #86868b;
      --text-tertiary: #48484a;

      --system-blue: #0a84ff;
      --system-blue-subtle: rgba(10, 132, 255, 0.15);
      --system-green: #30d158;
      --system-green-subtle: rgba(48, 209, 88, 0.15);
      --system-red: #ff453a;
      --system-red-subtle: rgba(255, 69, 58, 0.15);
      --system-orange: #ff9f0a;

      --font-system: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
      --font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;

      --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
    }

    @media (prefers-color-scheme: light) {
      :root {
        /* Apple Light Palette */
        --canvas: #f5f5f7;
        --card-bg: rgba(255, 255, 255, 0.82);
        --card-solid-bg: #ffffff;
        --card-border: rgba(0, 0, 0, 0.08);
        --card-border-top: rgba(255, 255, 255, 0.9);
        --card-shadow: 0 4px 20px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.02);
        --row-bg: rgba(0, 0, 0, 0.03);
        --row-border: rgba(0, 0, 0, 0.05);
        --row-hover: rgba(0, 0, 0, 0.06);
        --hairline: rgba(0, 0, 0, 0.06);

        --text-primary: #1d1d1f;
        --text-secondary: #6e6e73;
        --text-tertiary: #aeaeb2;

        --system-blue: #0071e3;
        --system-blue-subtle: rgba(0, 113, 227, 0.1);
        --system-green: #34c759;
        --system-green-subtle: rgba(52, 199, 89, 0.1);
        --system-red: #ff3b30;
        --system-red-subtle: rgba(255, 59, 48, 0.1);
        --system-orange: #ff9500;
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--canvas);
      color: var(--text-primary);
      font-family: var(--font-system);
      min-height: 100vh;
      padding: 2.5rem 1.5rem;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding: 0 0.25rem;
    }

    .header-branding {
      display: flex;
      align-items: center;
      gap: 0.875rem;
    }

    .app-icon {
      width: 44px;
      height: 44px;
      background: var(--system-blue-subtle);
      color: var(--system-blue);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.375rem;
      border: 1px solid var(--card-border);
    }

    .title-group {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.022em;
      color: var(--text-primary);
      line-height: 1.2;
    }

    .version-tag {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-secondary);
      letter-spacing: 0.02em;
    }

    .header-uptime {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--card-bg);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--card-border);
      border-radius: 9999px;
      padding: 0.4rem 0.875rem;
      font-size: 0.8125rem;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      color: var(--text-secondary);
      box-shadow: var(--card-shadow);
    }

    .header-uptime-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--system-green);
    }

    /* Grid Layout */
    .grid {
      display: grid;
      grid-template-columns: 1fr 1.25fr;
      gap: 1.5rem;
    }

    @media (max-width: 1024px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }

    .column {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    /* Materials & Depth (§12) */
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(25px) saturate(190%);
      -webkit-backdrop-filter: blur(25px) saturate(190%);
      border: 1px solid var(--card-border);
      border-top-color: var(--card-border-top);
      border-radius: 18px;
      padding: 1.5rem;
      box-shadow: var(--card-shadow);
      transition: transform 0.35s var(--ease-spring), box-shadow 0.35s var(--ease-spring);
    }

    .card:hover {
      transform: translateY(-2px);
    }

    h2 {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-secondary);
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }

    .metric-cell {
      background: var(--row-bg);
      border: 1px solid var(--row-border);
      border-radius: 12px;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .metric-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      letter-spacing: 0.02em;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }

    .metric-value {
      font-size: 1.875rem;
      font-weight: 600;
      letter-spacing: -0.03em;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
    }

    /* Tooltips (§16) */
    .tooltip {
      position: relative;
      cursor: help;
    }

    .tooltip .tooltiptext {
      visibility: hidden;
      opacity: 0;
      position: absolute;
      bottom: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%) translateY(4px);
      width: 250px;
      padding: 0.625rem 0.8125rem;
      background: var(--card-solid-bg);
      color: var(--text-primary);
      font-size: 0.75rem;
      line-height: 1.35;
      font-weight: 400;
      letter-spacing: normal;
      text-transform: none;
      border-radius: 10px;
      border: 1px solid var(--card-border);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      z-index: 100;
      transition: opacity 0.2s ease, transform 0.2s var(--ease-spring);
    }

    .tooltip:hover .tooltiptext {
      visibility: visible;
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    /* Hosts list */
    .host-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.875rem 1rem;
      background: var(--row-bg);
      border: 1px solid var(--row-border);
      border-radius: 12px;
      margin-bottom: 0.625rem;
      transition: background 0.2s ease;
    }

    .host-row:last-child {
      margin-bottom: 0;
    }

    .host-row:hover {
      background: var(--row-hover);
    }

    .host-info {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;
    }

    .host-name {
      font-weight: 500;
      font-size: 0.875rem;
      color: var(--text-primary);
    }

    .host-url {
      font-size: 0.75rem;
      font-family: var(--font-mono);
      color: var(--text-secondary);
      word-break: break-all;
    }

    /* Badges (§16) */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }

    .badge::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .badge.online {
      background: var(--system-green-subtle);
      color: var(--system-green);
    }

    .badge.online::before {
      background: var(--system-green);
    }

    .badge.offline {
      background: var(--system-red-subtle);
      color: var(--system-red);
    }

    .badge.offline::before {
      background: var(--system-red);
    }

    /* Chargers */
    .charger-card {
      background: var(--row-bg);
      border: 1px solid var(--row-border);
      border-radius: 14px;
      padding: 1.125rem;
      margin-bottom: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
    }

    .charger-card:last-child {
      margin-bottom: 0;
    }

    .charger-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
    }

    .charger-meta {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .charger-tag {
      font-weight: 600;
      font-size: 1rem;
      letter-spacing: -0.01em;
      color: var(--text-primary);
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--system-green);
      display: inline-block;
    }

    .charger-sub {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .charger-time {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .charger-readout {
      text-align: right;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .charger-power {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--system-blue);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }

    .charger-energy {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .type-pill {
      font-size: 0.6875rem;
      font-family: var(--font-mono);
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      color: var(--text-secondary);
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }

    .type-pill strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .chart-container {
      position: relative;
      width: 100%;
      height: 220px;
    }

    .no-sessions {
      color: var(--text-secondary);
      text-align: center;
      padding: 2.5rem 0;
      font-size: 0.875rem;
    }

    /* Accessibility (§14) */
    @media (prefers-reduced-motion: reduce) {
      *, .card, .tooltip .tooltiptext {
        transition: none !important;
        transform: none !important;
        animation: none !important;
      }
    }

    @media (prefers-reduced-transparency: reduce) {
      .card, header .header-uptime {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background: var(--card-solid-bg) !important;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-branding">
        <div class="app-icon">⚡</div>
        <div class="title-group">
          <h1>OCPP Proxy</h1>
          <span class="version-tag">Build ${version.sha}</span>
        </div>
      </div>
      <div id="uptime" class="header-uptime">
        <span class="header-uptime-dot"></span>
        <span>Uptime: --</span>
      </div>
    </header>

    <div class="grid">
      <!-- Left Column: Metrics & Hosts -->
      <div class="column">
        <!-- Global Metrics -->
        <div class="card">
          <h2>Proxy Telemetry</h2>
          <div class="metrics-grid">
            <div class="metric-cell">
              <span class="metric-label">Active Sessions</span>
              <span id="active-sessions-count" class="metric-value">0</span>
            </div>
            <div class="metric-cell">
              <span class="metric-label tooltip">
                Total Frames ⓘ
                <span class="tooltiptext">Processed WebSocket frames across all active sessions, including mirrored upstream traffic.</span>
              </span>
              <span id="total-message-count" class="metric-value">0</span>
            </div>
          </div>
        </div>

        <!-- Upstream CSMS Connections -->
        <div class="card">
          <h2>Upstream CSMS Backends</h2>
          <div id="hosts-container">
            <div class="no-sessions">Waiting for active charger session...</div>
          </div>
        </div>
      </div>

      <!-- Right Column: Charts & Chargers -->
      <div class="column">
        <!-- Power Graph Card -->
        <div class="card">
          <h2>Active Power (kW)</h2>
          <div class="chart-container">
            <canvas id="powerChart"></canvas>
          </div>
        </div>

        <!-- Energy Graph Card -->
        <div class="card">
          <h2>Delivered Energy (kWh)</h2>
          <div class="chart-container">
            <canvas id="energyChart"></canvas>
          </div>
        </div>

        <!-- Active Chargers Card -->
        <div class="card">
          <h2>Connected Charge Points</h2>
          <div id="chargers-container">
            <div class="no-sessions">No active charger sessions</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let powerChartInstance = null;
    let energyChartInstance = null;

    function formatDateTime(timeMs) {
      const date = new Date(timeMs);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const dd = String(date.getDate()).padStart(2, "0");
      const hh = String(date.getHours()).padStart(2, "0");
      const min = String(date.getMinutes()).padStart(2, "0");
      const ss = String(date.getSeconds()).padStart(2, "0");
      return yyyy + "-" + mm + "-" + dd + " " + hh + ":" + min + ":" + ss;
    }

    function formatUptime(seconds) {
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      
      const parts = [];
      if (d > 0) parts.push(d + "d");
      if (h > 0) parts.push(h + "h");
      if (m > 0) parts.push(m + "m");
      parts.push(s + "s");
      return parts.join(" ");
    }

    function maskUrlForVisitor(url) {
      if (!url) return "";
      try {
        const parts = url.split("?");
        const pathPart = parts[0];
        const queryPart = parts[1];
        
        let protocol = "";
        if (pathPart.includes("://")) {
          protocol = pathPart.split("://")[0] + "://";
        }
        const pathWithoutProtocol = protocol ? pathPart.slice(protocol.length) : pathPart;
        
        const segments = pathWithoutProtocol.split("/");
        const host = segments[0];
        
        const hostParts = host.split(".");
        const maskedHostParts = hostParts.map(part => {
          if (part.length <= 3) return "***";
          return part.slice(0, 2) + "***" + part.slice(-1);
        });
        const maskedHost = maskedHostParts.join(".");
        
        segments[0] = maskedHost;
        const maskedPath = protocol + segments.join("/");
        
        if (!queryPart) return maskedPath;
        
        const params = queryPart.split("&").map(param => {
          const [key, value] = param.split("=");
          if (key && value) {
            return key + "=***";
          }
          return param;
        });
        return maskedPath + "?" + params.join("&");
      } catch (err) {
        return "***";
      }
    }

    function getChartColors() {
      const styles = getComputedStyle(document.documentElement);
      return {
        tickColor: styles.getPropertyValue("--text-secondary").trim() || "#86868b",
        gridColor: styles.getPropertyValue("--hairline").trim() || "rgba(255, 255, 255, 0.08)",
        blue: styles.getPropertyValue("--system-blue").trim() || "#0a84ff",
        green: styles.getPropertyValue("--system-green").trim() || "#30d158"
      };
    }

    function initCharts() {
      const ctxPower = document.getElementById("powerChart").getContext("2d");
      const ctxEnergy = document.getElementById("energyChart").getContext("2d");
      const colors = getChartColors();

      powerChartInstance = new Chart(ctxPower, {
        type: "line",
        data: {
          labels: [],
          datasets: [{
            label: "Power (kW)",
            data: [],
            borderColor: colors.blue,
            backgroundColor: "rgba(10, 132, 255, 0.08)",
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(28, 28, 30, 0.9)",
              titleFont: { family: "-apple-system, system-ui, sans-serif", size: 11 },
              bodyFont: { family: "-apple-system, system-ui, sans-serif", size: 12 },
              cornerRadius: 8,
              padding: 8
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: colors.tickColor, font: { family: "-apple-system, system-ui, sans-serif", size: 10 } }
            },
            y: {
              grid: { color: colors.gridColor },
              ticks: { color: colors.tickColor, font: { family: "-apple-system, system-ui, sans-serif", size: 10 } }
            }
          }
        }
      });

      energyChartInstance = new Chart(ctxEnergy, {
        type: "line",
        data: {
          labels: [],
          datasets: [{
            label: "Energy (kWh)",
            data: [],
            borderColor: colors.green,
            backgroundColor: "rgba(48, 209, 88, 0.08)",
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(28, 28, 30, 0.9)",
              titleFont: { family: "-apple-system, system-ui, sans-serif", size: 11 },
              bodyFont: { family: "-apple-system, system-ui, sans-serif", size: 12 },
              cornerRadius: 8,
              padding: 8
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: colors.tickColor, font: { family: "-apple-system, system-ui, sans-serif", size: 10 } }
            },
            y: {
              grid: { color: colors.gridColor },
              ticks: { color: colors.tickColor, font: { family: "-apple-system, system-ui, sans-serif", size: 10 } }
            }
          }
        }
      });

      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        const newColors = getChartColors();
        powerChartInstance.data.datasets[0].borderColor = newColors.blue;
        powerChartInstance.options.scales.x.ticks.color = newColors.tickColor;
        powerChartInstance.options.scales.y.ticks.color = newColors.tickColor;
        powerChartInstance.options.scales.y.grid.color = newColors.gridColor;

        energyChartInstance.data.datasets[0].borderColor = newColors.green;
        energyChartInstance.options.scales.x.ticks.color = newColors.tickColor;
        energyChartInstance.options.scales.y.ticks.color = newColors.tickColor;
        energyChartInstance.options.scales.y.grid.color = newColors.gridColor;

        powerChartInstance.update();
        energyChartInstance.update();
      });
    }

    async function fetchStatus() {
      try {
        const response = await fetch("/api/status");
        const data = await response.json();

        const uptimeEl = document.getElementById("uptime");
        if (uptimeEl) {
          uptimeEl.innerHTML = "<span class='header-uptime-dot'></span><span>Uptime " + formatUptime(data.uptimeSeconds) + "</span>";
        }

        document.getElementById("active-sessions-count").textContent = data.activeSessionsCount;
        
        let totalMsgs = 0;
        data.sessions.forEach(s => totalMsgs += s.messageCount);
        document.getElementById("total-message-count").textContent = totalMsgs;

        const hostsContainer = document.getElementById("hosts-container");
        const chargersContainer = document.getElementById("chargers-container");

        if (data.sessions.length === 0) {
          hostsContainer.innerHTML = "<div class='no-sessions'>Waiting for active charger session...</div>";
          chargersContainer.innerHTML = "<div class='no-sessions'>No active charger sessions</div>";
          
          powerChartInstance.data.labels = [];
          powerChartInstance.data.datasets[0].data = [];
          powerChartInstance.update();

          energyChartInstance.data.labels = [];
          energyChartInstance.data.datasets[0].data = [];
          energyChartInstance.update();
        } else {
          let hostsHtml = "";
          let chargersHtml = "";

          data.sessions.forEach(session => {
            hostsHtml += "<div class='host-row'>" +
              "<div class='host-info'>" +
                "<span class='host-name'>Primary CSMS</span>" +
                "<span class='host-url'>" + maskUrlForVisitor(session.primaryUrl) + "</span>" +
              "</div>" +
              "<span class='badge " + session.primaryState.toLowerCase() + "'>" + session.primaryState + "</span>" +
            "</div>";

            session.secondaryUrls.forEach((sec, idx) => {
              hostsHtml += "<div class='host-row'>" +
                "<div class='host-info'>" +
                  "<span class='host-name'>Secondary CSMS [" + (idx + 1) + "]</span>" +
                  "<span class='host-url'>" + maskUrlForVisitor(sec.url) + "</span>" +
                "</div>" +
                "<span class='badge " + sec.state.toLowerCase() + "'>" + sec.state + " (" + sec.queueSize + " q)</span>" +
              "</div>";
            });

            const connTimeStr = formatDateTime(session.connectedAt);
            const sessionDurationStr = formatUptime(session.uptimeSeconds);

            let lastMsgHtml = "";
            if (session.lastMessageAt) {
              const lastMsgTimeStr = formatDateTime(session.lastMessageAt);
              const lastMsgDiffSec = Math.floor((Date.now() - session.lastMessageAt) / 1000);
              const lastMsgDurationStr = formatUptime(lastMsgDiffSec);
              lastMsgHtml = "<span class='charger-time'>Last frame: " + lastMsgTimeStr + " (" + lastMsgDurationStr + " ago)</span>";
            } else {
              lastMsgHtml = "<span class='charger-time'>Last frame: none</span>";
            }

            let typesHtml = "";
            if (session.messageTypes && Object.keys(session.messageTypes).length > 0) {
              typesHtml += "<div style='margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.375rem; width: 100%;'>";
              for (const [type, count] of Object.entries(session.messageTypes)) {
                typesHtml += "<span class='type-pill'>" +
                   type + ": <strong>" + count + "</strong>" +
                "</span>";
              }
              typesHtml += "</div>";
            }

            chargersHtml += "<div class='charger-card'>" +
              "<div class='charger-header'>" +
                "<div class='charger-meta'>" +
                  "<span class='charger-tag'><span class='status-dot'></span>" + session.chargePointId + "</span>" +
                  "<span class='charger-sub'>IP: " + session.ipAddress + " &middot; " + session.protocol + "</span>" +
                  "<span class='charger-time'>Connected: " + connTimeStr + " (" + sessionDurationStr + " ago)</span>" +
                  lastMsgHtml +
                "</div>" +
                "<div class='charger-readout'>" +
                  "<span class='charger-power'>" + session.latestPower.toFixed(2) + " kW</span>" +
                  "<span class='charger-energy'>" +
                    "Session: " + session.latestEnergy.toFixed(2) + " kWh" +
                    (session.lifetimeChargedEnergyKwh !== undefined ? " &middot; Total: " + session.lifetimeChargedEnergyKwh.toFixed(2) + " kWh" : "") +
                    " &middot; " + session.messageCount + " frames" +
                  "</span>" +
                "</div>" +
              "</div>" +
              typesHtml +
            "</div>";

            if (session.powerHistory && session.powerHistory.length > 0) {
              powerChartInstance.data.labels = session.powerHistory.map(p => formatDateTime(p.time));
              powerChartInstance.data.datasets[0].data = session.powerHistory.map(p => p.value);
              powerChartInstance.update();
            }
            if (session.energyHistory && session.energyHistory.length > 0) {
              energyChartInstance.data.labels = session.energyHistory.map(e => formatDateTime(e.time));
              energyChartInstance.data.datasets[0].data = session.energyHistory.map(e => e.value);
              energyChartInstance.update();
            }
          });

          hostsContainer.innerHTML = hostsHtml;
          chargersContainer.innerHTML = chargersHtml;
        }
      } catch (err) {
        console.error("Error fetching proxy status:", err);
      }
    }

    window.addEventListener("load", () => {
      initCharts();
      fetchStatus();
      setInterval(fetchStatus, 3000);
    });
  </script>
</body>
</html>
`;
}
