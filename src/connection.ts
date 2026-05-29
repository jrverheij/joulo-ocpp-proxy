import WebSocket from "ws";
import { createLogger } from "./logger";
import { OCPP_MSG_CALL, OCPP_SUBPROTOCOLS } from "./types";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 */

function forwardPing(ws: WebSocket | null, data: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.ping(data);
  } catch {
    /* best-effort */
  }
}

function forwardPong(ws: WebSocket | null, data: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.pong(data);
  } catch {
    /* best-effort */
  }
}

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
const SECONDARY_MAX_QUEUE = 100;

function buildUpstreamUrl(baseUrl: string, chargePointId: string): string {
  const [path, query] = baseUrl.split("?");
  const cleanPath = `${path.replace(/\/+$/, "")}/${chargePointId}`;
  return query ? `${cleanPath}?${query}` : cleanPath;
}

export function maskString(str: string): string {
  if (!str) return "";
  if (str.length <= 4) return str;
  return str.slice(0, 2) + "*****" + str.slice(-2);
}

export function maskIp(ip: string): string {
  if (!ip) return "Unknown";
  
  let ipv4Part = ip;
  let prefix = "";
  if (ip.startsWith("::ffff:")) {
    prefix = "::ffff:";
    ipv4Part = ip.slice(7);
  }

  if (ipv4Part.includes(".")) {
    const parts = ipv4Part.split(".");
    if (parts.length === 4) {
      return `${prefix}${parts[0]}.${parts[1]}.x.x`;
    }
  }

  if (ipv4Part.includes(":")) {
    const parts = ipv4Part.split(":");
    if (parts.length > 2) {
      return `${parts.slice(0, 2).join(":")}:xxxx:xxxx:xxxx:xxxx`;
    }
  }

  return "xx.xx.xx.xx";
}

export function maskUrl(url: string): string {
  if (!url) return "";
  try {
    const [pathPart, queryPart] = url.split("?");
    
    const segments = pathPart.split("/");
    const lastIdx = segments.length - 1;
    const lastSegment = segments[lastIdx];
    
    const isAbsolute = pathPart.includes("://");
    const minSegments = isAbsolute ? 4 : 2;

    if (segments.length >= minSegments && lastSegment && lastSegment.length > 4) {
      if (!lastSegment.includes(".")) {
        segments[lastIdx] = maskString(lastSegment);
      }
    }
    const maskedPath = segments.join("/");

    if (!queryPart) {
      return maskedPath;
    }

    const params = queryPart.split("&").map(param => {
      const [key, value] = param.split("=");
      if (value && value.length > 4) {
        return `${key}=${maskString(value)}`;
      }
      return param;
    });
    return `${maskedPath}?${params.join("&")}`;
  } catch {
    return maskString(url);
  }
}

export function maskUrlForVisitor(url: string): string {
  if (!url) return "";
  try {
    const [pathPart, queryPart] = url.split("?");
    
    let protocol = "";
    if (pathPart.includes("://")) {
      protocol = pathPart.split("://")[0] + "://";
    }
    const pathWithoutProtocol = protocol ? pathPart.slice(protocol.length) : pathPart;
    
    const segments = pathWithoutProtocol.split("/");
    const host = segments[0];
    
    const [hostName, port] = host.split(":");
    const hostParts = hostName.split(".");
    const maskedHostParts = hostParts.map(part => {
      if (part.length <= 3) return "***";
      return part.slice(0, 2) + "***" + part.slice(-1);
    });
    let maskedHost = maskedHostParts.join(".");
    if (port) {
      maskedHost = `${maskedHost}:${port}`;
    }
    
    segments[0] = maskedHost;
    
    const lastIdx = segments.length - 1;
    if (segments.length >= 2) {
      const lastSegment = segments[lastIdx];
      if (lastSegment && !lastSegment.includes("*") && lastSegment.length > 4) {
        segments[lastIdx] = maskString(lastSegment);
      }
    }
    
    const maskedPath = protocol + segments.join("/");
    
    if (!queryPart) {
      return maskedPath;
    }
    
    const params = queryPart.split("&").map(param => {
      const [key, value] = param.split("=");
      if (key && value) {
        return `${key}=***`;
      }
      return param;
    });
    return `${maskedPath}?${params.join("&")}`;
  } catch {
    return maskString(url);
  }
}

function parseMeterValues(msgStr: string): { power?: number; energy?: number } | null {
  try {
    const parsed = JSON.parse(msgStr);
    if (!Array.isArray(parsed) || parsed[0] !== 2 || parsed[2] !== "MeterValues") return null;
    const payload = parsed[3] as Record<string, any>;
    if (!payload || !Array.isArray(payload.meterValue)) return null;

    let power: number | undefined;
    let energy: number | undefined;

    for (const entry of payload.meterValue) {
      if (!Array.isArray(entry.sampledValue)) continue;
      for (const sample of entry.sampledValue) {
        const valStr = sample.value;
        const val = parseFloat(valStr);
        if (isNaN(val)) continue;

        const measurand = sample.measurand ?? "Energy.Active.Import.Register";
        const unit = (sample.unit ?? (measurand === "Power.Active.Import" ? "W" : "Wh")).toLowerCase();

        if (measurand === "Power.Active.Import") {
          power = unit === "w" ? val / 1000 : val;
        } else if (measurand === "Energy.Active.Import.Register") {
          energy = unit === "wh" ? val / 1000 : val;
        }
      }
    }
    return { power, energy };
  } catch {
    return null;
  }
}

interface SecondaryState {
  url: string;
  ws: WebSocket | null;
  queue: string[];
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: SecondaryState[] = [];
  private alive = true;
  private primaryQueue: string[] = [];

  // Metrics
  private readonly connectedAt = Date.now();
  private messageCount = 0;
  private latestPower = 0;
  private latestEnergy = 0;
  private powerHistory: { time: number; value: number }[] = [];
  private energyHistory: { time: number; value: number }[] = [];
  private readonly messageTypes: Record<string, number> = {};

  private trackMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const type = parsed[0];
        if (type === 2 && typeof parsed[2] === "string") {
          const action = parsed[2];
          this.messageTypes[action] = (this.messageTypes[action] || 0) + 1;
        } else if (type === 3) {
          this.messageTypes["CallResult"] = (this.messageTypes["CallResult"] || 0) + 1;
        } else if (type === 4) {
          this.messageTypes["CallError"] = (this.messageTypes["CallError"] || 0) + 1;
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryUrl: string,
    private readonly secondaryUrls: string[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly ipAddress: string,
    private readonly endCallback?: () => void
  ) {
    this.log = createLogger(maskString(chargePointId));
    this.setup();
  }

  private setup() {
    this.primary = this.connectPrimary(this.primaryUrl);

    for (const url of this.secondaryUrls) {
      const state: SecondaryState = {
        url,
        ws: null,
        queue: [],
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
      };
      this.secondaries.push(state);
      state.ws = this.connectSecondary(state);
    }

    this.charger.on("message", (data) => {
      this.messageCount++;
      const raw = data.toString();
      this.trackMessage(raw);
      this.log.debug("charger → proxy", { message: this.summarise(raw) });

      // Parse OCPP MeterValues for dashboard graphs
      const metrics = parseMeterValues(raw);
      if (metrics) {
        const timestamp = Date.now();
        if (metrics.power !== undefined) {
          this.latestPower = metrics.power;
          this.powerHistory.push({ time: timestamp, value: metrics.power });
          if (this.powerHistory.length > 100) this.powerHistory.shift();
        }
        if (metrics.energy !== undefined) {
          this.latestEnergy = metrics.energy;
          this.energyHistory.push({ time: timestamp, value: metrics.energy });
          if (this.energyHistory.length > 100) this.energyHistory.shift();
        }
      }

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      } else {
        this.primaryQueue.push(raw);
      }

      for (const sec of this.secondaries) {
        if (sec.ws?.readyState === WebSocket.OPEN) {
          try {
            sec.ws.send(raw);
          } catch {
            /* best-effort */
          }
        } else {
          this.enqueueForSecondary(sec, raw);
        }
      }
    });

    this.charger.on("close", (code, reason) => {
      this.log.info("charger disconnected", {
        code,
        reason: reason.toString(),
      });
      this.teardown();
    });

    this.charger.on("error", (err) => {
      this.log.error("charger connection error", { error: err.message });
    });

    this.charger.on("ping", (data) => {
      forwardPing(this.primary, data);
    });

    this.charger.on("pong", (data) => {
      forwardPong(this.primary, data);
    });

    this.log.info("session started", {
      primary: maskUrl(this.primaryUrl),
      secondaries: this.secondaryUrls.map(u => maskUrl(u)),
      protocol: this.protocol,
    });
  }

  private connectPrimary(baseUrl: string): WebSocket {
    const url = buildUpstreamUrl(baseUrl, this.chargePointId);

    const ws = new WebSocket(
      url,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildHeaders(),
        handshakeTimeout: 10_000,
        autoPong: false,
      }
    );

    ws.on("open", () => {
      this.log.info("primary connected", { url: maskUrl(url) });
      if (this.primaryQueue.length > 0) {
        this.log.info(`primary flushing ${this.primaryQueue.length} queued messages`, { url: maskUrl(url) });
        for (const msg of this.primaryQueue) {
          try {
            ws.send(msg);
          } catch {
            /* best-effort */
          }
        }
        this.primaryQueue = [];
      }
    });

    ws.on("message", (data) => {
      this.messageCount++;
      const raw = data.toString();
      this.trackMessage(raw);
      this.log.debug("primary → charger", { message: this.summarise(raw) });
      if (this.charger.readyState === WebSocket.OPEN) {
        this.charger.send(raw);
      }
    });

    ws.on("close", (code, reason) => {
      this.log.warn("primary disconnected", {
        url: maskUrl(url),
        code,
        reason: reason.toString(),
      });
      this.charger.close(1001, "Primary CSMS disconnected");
      this.teardown();
    });

    ws.on("error", (err) => {
      this.log.error("primary error", { url: maskUrl(url), error: err.message });
      if (this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => forwardPing(this.charger, data));
    ws.on("pong", (data) => forwardPong(this.charger, data));

    return ws;
  }

  private connectSecondary(state: SecondaryState): WebSocket {
    const url = buildUpstreamUrl(state.url, this.chargePointId);

    const ws = new WebSocket(
      url,
      this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS,
      {
        headers: this.buildHeaders(),
        handshakeTimeout: 10_000,
        autoPong: false,
      }
    );

    ws.on("open", () => {
      this.log.info("secondary connected", { url: maskUrl(url) });
      state.lastPongAt = Date.now();
      this.flushSecondaryQueue(state, ws);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data) => {
      this.messageCount++;
      const raw = data.toString();
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      this.log.debug("secondary response (ignored)", {
        url: maskUrl(url),
        message: this.summarise(raw),
      });
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      this.log.warn("secondary disconnected", {
        url: maskUrl(url),
        code,
        reason: reason.toString(),
      });
      this.stopSecondaryKeepalive(state);
      this.scheduleSecondaryReconnect(state);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", { url: maskUrl(url), error: err.message });
    });

    return ws;
  }

  private enqueueForSecondary(state: SecondaryState, raw: string) {
    if (state.queue.length >= SECONDARY_MAX_QUEUE) {
      state.queue.shift();
      this.log.warn("secondary queue full, dropping oldest message", {
        url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
        max: SECONDARY_MAX_QUEUE,
      });
    }
    state.queue.push(raw);
  }

  private flushSecondaryQueue(state: SecondaryState, ws: WebSocket) {
    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued messages", {
      url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
      count: state.queue.length,
    });
    for (const msg of state.queue) {
      try {
        ws.send(msg);
      } catch {
        /* best-effort */
      }
    }
    state.queue = [];
  }

  private startSecondaryKeepalive(state: SecondaryState, ws: WebSocket) {
    this.stopSecondaryKeepalive(state);
    state.keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - state.lastPongAt > SECONDARY_PONG_TIMEOUT_MS) {
        this.log.warn("secondary pong timeout, forcing reconnect", {
          url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
        });
        try { ws.close(4000, "pong timeout"); } catch { /* */ }
        return;
      }

      try {
        ws.ping();
      } catch {
        /* best-effort */
      }
    }, SECONDARY_KEEPALIVE_INTERVAL_MS);
  }

  private stopSecondaryKeepalive(state: SecondaryState) {
    if (state.keepalive !== null) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
  }

  private scheduleSecondaryReconnect(state: SecondaryState) {
    if (!this.alive) return;
    if (state.reconnectTimer !== null) return;

    this.log.info("secondary reconnecting", {
      url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
      delayMs: SECONDARY_RECONNECT_DELAY_MS,
    });

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!this.alive) return;
      state.ws = this.connectSecondary(state);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }
    return headers;
  }

  public getMetrics() {
    return {
      chargePointId: maskString(this.chargePointId),
      primaryUrl: maskUrlForVisitor(buildUpstreamUrl(this.primaryUrl, this.chargePointId)),
      connectedAt: this.connectedAt,
      uptimeSeconds: Math.floor((Date.now() - this.connectedAt) / 1000),
      ipAddress: maskIp(this.ipAddress),
      protocol: this.protocol || "none",
      primaryState: this.primary?.readyState === WebSocket.OPEN ? "Online" : "Offline",
      secondaryUrls: this.secondaries.map(sec => ({
        url: maskUrlForVisitor(buildUpstreamUrl(sec.url, this.chargePointId)),
        state: sec.ws?.readyState === WebSocket.OPEN ? "Online" : "Offline",
        queueSize: sec.queue.length
      })),
      latestPower: this.latestPower,
      latestEnergy: this.latestEnergy,
      powerHistory: this.powerHistory,
      energyHistory: this.energyHistory,
      messageCount: this.messageCount,
      messageTypes: this.messageTypes
    };
  }

  public teardown() {
    if (!this.alive) return;
    this.alive = false;
    this.primaryQueue = [];

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      sec.queue = [];
    }

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    for (const sec of this.secondaries) close(sec.ws);
    close(this.charger);

    this.log.info("session ended");
    this.endCallback?.();
  }

  private summarise(raw: string): string {
    try {
      const msg = JSON.parse(raw) as unknown[];
      if (!Array.isArray(msg) || msg.length < 3) return raw.slice(0, 120);

      const type = msg[0] as number;
      const id = msg[1] as string;

      if (type === 2) {
        return `[CALL] ${msg[2]} (${id})`;
      }
      return `[${type === 3 ? "RESULT" : "ERROR"}] (${id})`;
    } catch {
      return raw.slice(0, 120);
    }
  }
}
