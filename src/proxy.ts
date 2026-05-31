import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config";
import { ChargerConnection, maskUrl, maskString, maskIp, maskUrlForVisitor } from "./connection";
import { createLogger } from "./logger";
import { OCPP_SUBPROTOCOLS } from "./types";

const log = createLogger("proxy");
const startedAt = Date.now();

export function startProxy(config: Config) {
  const sessions = new Map<string, ChargerConnection>();

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
        uptimeSeconds: Math.floor(uptimeMs / 1000),
        primaryUrl: maskUrlForVisitor(config.primaryUrl),
        secondaryUrls: config.secondaryUrls.map(u => maskUrlForVisitor(u)),
        activeSessionsCount: sessions.size,
        sessions: Array.from(sessions.values()).map(s => s.getMetrics()),
      };
      res.end(JSON.stringify(metrics, null, 2));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "joulo-ocpp-proxy is running.\n" +
        "Connect your charge point via WebSocket.\n" +
        "Status dashboard available at /status\n"
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
    const authHeader = req.headers["authorization"] as string | undefined;
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
      config.primaryUrl,
      config.secondaryUrls,
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
      primary: maskUrl(config.primaryUrl),
      secondaries: config.secondaryUrls.map(u => maskUrl(u)),
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
  <title>OCPP Proxy Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #09080e;
      --card-bg: rgba(255, 255, 255, 0.04);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #8b5cf6;
      --secondary: #06b6d4;
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.25);
      --danger: #ef4444;
      --font: 'Outfit', sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 10% 10%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
        radial-gradient(at 90% 90%, rgba(6, 182, 212, 0.15) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      padding: 2rem;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2.5rem;
    }

    .logo-container {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .logo-icon {
      width: 2.5rem;
      height: 2.5rem;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 1.25rem;
      box-shadow: 0 0 20px rgba(139, 92, 246, 0.4);
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #ffffff, #d1d5db);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    /* Grid Layout */
    .grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 2rem;
    }

    @media (max-width: 1024px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }

    .column {
      display: flex;
      flex-column: column;
      flex-direction: column;
      gap: 2rem;
    }

    /* Cards */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 1.25rem;
      padding: 2rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      transition: border-color 0.3s ease;
    }

    .card:hover {
      border-color: rgba(255, 255, 255, 0.15);
    }

    h2 {
      font-size: 1.2rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Uptime & Global Metrics */
    .uptime-value {
      font-size: 2.25rem;
      font-weight: 700;
      background: linear-gradient(135deg, #ffffff, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 1rem;
    }

    .metrics-row {
      display: flex;
      gap: 2rem;
      margin-top: 1rem;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 1rem;
    }

    .metric-item {
      display: flex;
      flex-direction: column;
    }

    .metric-label {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .metric-value {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text);
    }

    /* Hosts */
    .host-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .host-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .host-name {
      font-weight: 500;
      font-size: 1rem;
    }

    .host-url {
      font-size: 0.8rem;
      color: var(--text-muted);
      word-break: break-all;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      gap: 0.4rem;
    }

    .badge::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .badge.online {
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.2);
      box-shadow: 0 0 10px var(--success-glow);
    }

    .badge.online::before {
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }

    .badge.offline {
      background: rgba(239, 68, 68, 0.1);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .badge.offline::before {
      background: var(--danger);
    }

    /* Active Chargers */
    .charger-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      transition: background 0.2s ease;
    }

    .charger-row:last-child {
      border-bottom: none;
    }

    .charger-row:hover {
      background: rgba(255, 255, 255, 0.01);
    }

    .charger-meta {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .charger-tag {
      font-weight: 600;
      font-size: 1.1rem;
      letter-spacing: 0.05em;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .charger-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .pulse {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 0 0 var(--success-glow);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      }
      70% {
        transform: scale(1);
        box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
      }
      100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    .chart-container {
      position: relative;
      width: 100%;
      height: 250px;
      margin-top: 1rem;
    }

    .no-sessions {
      color: var(--text-muted);
      text-align: center;
      padding: 3rem 0;
      font-size: 1rem;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-container">
        <div class="logo-icon">🎛️</div>
        <h1>OCPP Proxy Status</h1>
      </div>
      <div id="uptime" class="uptime-value">Uptime: --</div>
    </header>

    <div class="grid">
      <!-- Left Column: Diagnostics -->
      <div class="column">
        <!-- Global Stats -->
        <div class="card">
          <h2>Global Proxy Metrics</h2>
          <div class="uptime-value" style="font-size: 1.75rem; margin-bottom: 0;">Stateless Monitor</div>
          <div class="metrics-row">
            <div class="metric-item">
              <span class="metric-label">Active Sessions</span>
              <span id="active-sessions-count" class="metric-value">0</span>
            </div>
            <div class="metric-item">
              <span class="metric-label" style="cursor: help; border-bottom: 1px dotted rgba(255, 255, 255, 0.3);" title="Total processed WebSocket frames across all active connection legs (includes mirrored traffic and secondary backends responses)">Total Messages ℹ️</span>
              <span id="total-message-count" class="metric-value">0</span>
            </div>
          </div>
        </div>

        <!-- Host status -->
        <div class="card">
          <h2>Upstream CSMS Connections</h2>
          <div id="hosts-container">
            <div class="no-sessions">Waiting for active charger session...</div>
          </div>
        </div>
      </div>

      <!-- Right Column: Graphs & Sessions -->
      <div class="column">
        <!-- Power Graph Card -->
        <div class="card">
          <h2>Power Consumption (kW)</h2>
          <div class="chart-container">
            <canvas id="powerChart"></canvas>
          </div>
        </div>

        <!-- Energy Graph Card -->
        <div class="card">
          <h2>Energy Consumption (kWh)</h2>
          <div class="chart-container">
            <canvas id="energyChart"></canvas>
          </div>
        </div>

        <!-- Active Chargers Card -->
        <div class="card">
          <h2>Active Charger Details</h2>
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

    function formatUptime(seconds) {
      const d = Math.floor(seconds / (3600*24));
      const h = Math.floor((seconds % (3600*24)) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      
      const parts = [];
      if (d > 0) parts.push(d + 'd');
      if (h > 0) parts.push(h + 'h');
      if (m > 0) parts.push(m + 'm');
      parts.push(s + 's');
      return 'Uptime: ' + parts.join(' ');
    }

    function maskUrlForVisitor(url) {
      if (!url) return '';
      try {
        const parts = url.split('?');
        const pathPart = parts[0];
        const queryPart = parts[1];
        
        let protocol = '';
        if (pathPart.includes('://')) {
          protocol = pathPart.split('://')[0] + '://';
        }
        const pathWithoutProtocol = protocol ? pathPart.slice(protocol.length) : pathPart;
        
        const segments = pathWithoutProtocol.split('/');
        const host = segments[0];
        
        const hostParts = host.split('.');
        const maskedHostParts = hostParts.map(part => {
          if (part.length <= 3) return '***';
          return part.slice(0, 2) + '***' + part.slice(-1);
        });
        const maskedHost = maskedHostParts.join('.');
        
        segments[0] = maskedHost;
        const maskedPath = protocol + segments.join('/');
        
        if (!queryPart) return maskedPath;
        
        const params = queryPart.split('&').map(param => {
          const [key, value] = param.split('=');
          if (key && value) {
            return key + '=***';
          }
          return param;
        });
        return maskedPath + '?' + params.join('&');
      } catch (err) {
        return '***';
      }
    }

    function initCharts() {
      const ctxPower = document.getElementById('powerChart').getContext('2d');
      const ctxEnergy = document.getElementById('energyChart').getContext('2d');

      const gradientPower = ctxPower.createLinearGradient(0, 0, 0, 200);
      gradientPower.addColorStop(0, 'rgba(139, 92, 246, 0.3)');
      gradientPower.addColorStop(1, 'rgba(139, 92, 246, 0)');

      const gradientEnergy = ctxEnergy.createLinearGradient(0, 0, 0, 200);
      gradientEnergy.addColorStop(0, 'rgba(6, 182, 212, 0.3)');
      gradientEnergy.addColorStop(1, 'rgba(6, 182, 212, 0)');

      powerChartInstance = new Chart(ctxPower, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Active Power (kW)',
            data: [],
            borderColor: '#8b5cf6',
            backgroundColor: gradientPower,
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } }
          }
        }
      });

      energyChartInstance = new Chart(ctxEnergy, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Energy (kWh)',
            data: [],
            borderColor: '#06b6d4',
            backgroundColor: gradientEnergy,
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } },
            y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#9ca3af', font: { family: 'Outfit' } } }
          }
        }
      });
    }

    async function fetchStatus() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();

        // Uptime
        document.getElementById('uptime').textContent = formatUptime(data.uptimeSeconds);
        document.getElementById('active-sessions-count').textContent = data.activeSessionsCount;
        
        let totalMsgs = 0;
        data.sessions.forEach(s => totalMsgs += s.messageCount);
        document.getElementById('total-message-count').textContent = totalMsgs;

        // Chargers & Hosts List
        const hostsContainer = document.getElementById('hosts-container');
        const chargersContainer = document.getElementById('chargers-container');

        if (data.sessions.length === 0) {
          hostsContainer.innerHTML = '<div class="no-sessions">Waiting for active charger session...</div>';
          chargersContainer.innerHTML = '<div class="no-sessions">No active charger sessions</div>';
          
          powerChartInstance.data.labels = [];
          powerChartInstance.data.datasets[0].data = [];
          powerChartInstance.update();

          energyChartInstance.data.labels = [];
          energyChartInstance.data.datasets[0].data = [];
          energyChartInstance.update();
        } else {
          let hostsHtml = '';
          let chargersHtml = '';

          data.sessions.forEach(session => {
            // primary
            hostsHtml += '<div class="host-row">' +
              '<div class="host-info">' +
                '<span class="host-name">Primary CSMS</span>' +
                '<span class="host-url">' + maskUrlForVisitor(session.primaryUrl) + '</span>' +
              '</div>' +
              '<span class="badge ' + session.primaryState.toLowerCase() + '">' + session.primaryState + '</span>' +
            '</div>';

            // secondaries
            session.secondaryUrls.forEach((sec, idx) => {
              hostsHtml += '<div class="host-row">' +
                '<div class="host-info">' +
                  '<span class="host-name">Secondary CSMS [' + (idx + 1) + ']</span>' +
                  '<span class="host-url">' + maskUrlForVisitor(sec.url) + '</span>' +
                '</div>' +
                '<span class="badge ' + sec.state.toLowerCase() + '">' + sec.state + ' (' + sec.queueSize + ' q)</span>' +
              '</div>';
            });

            const connDate = new Date(session.connectedAt);
            const connTimeStr = connDate.toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            
            const s = session.uptimeSeconds;
            const hr = Math.floor(s / 3600);
            const min = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            const durationParts = [];
            if (hr > 0) durationParts.push(hr + 'h');
            if (min > 0) durationParts.push(min + 'm');
            durationParts.push(sec + 's');
            const sessionDurationStr = durationParts.join(' ');

            let typesHtml = '';
            if (session.messageTypes && Object.keys(session.messageTypes).length > 0) {
              typesHtml += '<div style="margin-top: 1rem; width: 100%;">' +
                '<div style="font-size: 0.75rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em;">OCPP Message Types (Current Session)</div>' +
                '<div style="display: flex; flex-wrap: wrap; gap: 0.5rem; width: 100%;">';
              for (const [type, count] of Object.entries(session.messageTypes)) {
                typesHtml += '<span style="font-size: 0.75rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); padding: 0.25rem 0.55rem; border-radius: 6px; color: #cbd5e1; display: inline-flex; align-items: center; gap: 0.25rem;">' +
                  type + ': <strong style="color: #a78bfa; font-weight: 600;">' + count + '</strong>' +
                '</span>';
              }
              typesHtml += '</div></div>';
            }

            chargersHtml += '<div class="charger-row" style="flex-direction: column; align-items: stretch; gap: 0.75rem; padding: 1.5rem;">' +
              '<div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">' +
                '<div class="charger-meta">' +
                  '<span class="charger-tag"><span class="pulse"></span>' + session.chargePointId + '</span>' +
                  '<span class="charger-sub">IP: ' + session.ipAddress + ' | Protocol: ' + session.protocol + '</span>' +
                  '<span class="charger-sub" style="font-size: 0.8rem; margin-top: 0.15rem; color: var(--text-muted);">Connected since: ' + connTimeStr + ' (' + sessionDurationStr + ' ago)</span>' +
                '</div>' +
                '<div class="charger-meta" style="text-align: right;">' +
                  '<span class="charger-tag" style="font-weight: 500; font-size: 1rem; color: #a78bfa;">' + session.latestPower.toFixed(2) + ' kW</span>' +
                  '<span class="charger-sub">' + session.latestEnergy.toFixed(2) + ' kWh | ' + session.messageCount + ' msgs</span>' +
                '</div>' +
              '</div>' +
              typesHtml +
            '</div>';

            // Update Chart Data (takes first active session for simplification)
            if (session.powerHistory && session.powerHistory.length > 0) {
              powerChartInstance.data.labels = session.powerHistory.map(p => new Date(p.time).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
              powerChartInstance.data.datasets[0].data = session.powerHistory.map(p => p.value);
              powerChartInstance.update();
            }
            if (session.energyHistory && session.energyHistory.length > 0) {
              energyChartInstance.data.labels = session.energyHistory.map(e => new Date(e.time).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
              energyChartInstance.data.datasets[0].data = session.energyHistory.map(e => e.value);
              energyChartInstance.update();
            }
          });

          hostsContainer.innerHTML = hostsHtml;
          chargersContainer.innerHTML = chargersHtml;
        }
      } catch (err) {
        console.error('Error fetching proxy status:', err);
      }
    }

    window.addEventListener('load', () => {
      initCharts();
      fetchStatus();
      setInterval(fetchStatus, 3000);
    });
  </script>
</body>
</html>
`;
}
