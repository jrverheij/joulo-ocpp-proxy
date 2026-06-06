import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { createLogger } from "./logger";
import { OCPP_MSG_CALL, OCPP_SUBPROTOCOLS } from "./types";
import { PersistentQueue } from "./queue";

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
function roundToThreeDecimals(val: number): number {
  return Math.round(val * 1000) / 1000;
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

interface ParsedMetrics {
  power?: number;
  energy?: number;
  transactionId?: number;
}

function parseMeterValues(msgStr: string): ParsedMetrics | null {
  try {
    const parsed = JSON.parse(msgStr);
    if (!Array.isArray(parsed) || parsed[0] !== 2 || parsed[2] !== "MeterValues") return null;
    const payload = parsed[3] as Record<string, any>;
    if (!payload || !Array.isArray(payload.meterValue)) return null;

    const transactionId = payload.transactionId;
    let powerTotal = 0;
    let hasPower = false;
    let energyTotal = 0;
    let hasEnergy = false;

    for (const entry of payload.meterValue) {
      if (!Array.isArray(entry.sampledValue)) continue;

      let entryPower = 0;
      let entryHasPower = false;
      let entryEnergy = 0;
      let entryHasEnergy = false;

      const phasePowers: Record<string, number> = {};
      let totalPower: number | undefined;

      const phaseEnergies: Record<string, number> = {};
      let totalEnergy: number | undefined;

      for (const sample of entry.sampledValue) {
        const valStr = sample.value;
        const val = parseFloat(valStr);
        if (isNaN(val)) continue;

        const measurand = sample.measurand ?? "Energy.Active.Import.Register";
        const phase = sample.phase;

        if (measurand === "Power.Active.Import") {
          let resolvedUnit = sample.unit;
          if (!resolvedUnit) {
            // Guess unit based on value: if > 150, it is likely in Watts (W)
            resolvedUnit = val > 150 ? "W" : "kW";
          }
          const powerKw = resolvedUnit.toLowerCase() === "w" ? val / 1000 : val;
          if (phase) {
            phasePowers[phase] = powerKw;
          } else {
            totalPower = powerKw;
          }
        } else if (measurand === "Energy.Active.Import.Register") {
          let resolvedUnit = sample.unit;
          if (!resolvedUnit) {
            // Guess unit based on value: if > 10000 and is an integer, it is likely in Wh
            resolvedUnit = (val > 10000 && val % 1 === 0) ? "Wh" : "kWh";
          }
          const energyKwh = resolvedUnit.toLowerCase() === "wh" ? val / 1000 : val;
          if (phase) {
            phaseEnergies[phase] = energyKwh;
          } else {
            totalEnergy = energyKwh;
          }
        }
      }

      const phasePowerSum = Object.values(phasePowers).reduce((sum, p) => sum + p, 0);
      if (phasePowerSum > 0) {
        entryPower = phasePowerSum;
        entryHasPower = true;
      } else if (totalPower !== undefined) {
        entryPower = totalPower;
        entryHasPower = true;
      }

      const phaseEnergySum = Object.values(phaseEnergies).reduce((sum, e) => sum + e, 0);
      if (phaseEnergySum > 0) {
        entryEnergy = phaseEnergySum;
        entryHasEnergy = true;
      } else if (totalEnergy !== undefined) {
        entryEnergy = totalEnergy;
        entryHasEnergy = true;
      }

      if (entryHasPower) {
        powerTotal = entryPower;
        hasPower = true;
      }
      if (entryHasEnergy) {
        energyTotal = entryEnergy;
        hasEnergy = true;
      }
    }

    return {
      power: hasPower ? powerTotal : undefined,
      energy: hasEnergy ? energyTotal : undefined,
      transactionId,
    };
  } catch {
    return null;
  }
}

function isCriticalMessage(raw: string): { critical: boolean; messageId?: string } {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed[0] === 2 && typeof parsed[2] === "string") {
      const action = parsed[2];
      const isCritical =
        action === "StopTransaction" ||
        action === "MeterValues" ||
        action === "StartTransaction";
      return { critical: isCritical, messageId: String(parsed[1]) };
    }
  } catch {}
  return { critical: false };
}

function sendAsync(ws: WebSocket, data: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket is not open"));
    }
    ws.send(data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

interface SecondaryState {
  url: string;
  ws: WebSocket | null;
  queue: string[];
  diskQueue: PersistentQueue;
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
  private connectedAt = Date.now();
  private messageCount = 0;
  private latestPower = 0;
  private latestEnergy = 0;
  private powerHistory: { time: number; value: number }[] = [];
  private energyHistory: { time: number; value: number }[] = [];
  private readonly messageTypes: Record<string, number> = {};

  // Session tracking & Fallback calculation
  private initialEnergy: number | null = null;
  private currentTransactionId: number | null = null;
  private lastEnergyTime: number | null = null;
  private lastEnergyValue: number | null = null;

  // Persistent stats
  private lifetimeChargedEnergyKwh = 0;
  private lastStateWriteTime = 0;
  private lastMessageAt: number | null = null;

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
    private readonly queueDir: string,
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly ipAddress: string,
    private readonly endCallback?: () => void
  ) {
    this.log = createLogger(maskString(chargePointId));
    this.setup();
  }

  private loadSessionStateSync() {
    const filePath = path.join(this.queueDir, this.chargePointId, "session_state.json");
    if (!fs.existsSync(filePath)) return;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const state = JSON.parse(raw);
      this.connectedAt = state.connectedAt ?? this.connectedAt;
      this.messageCount = state.messageCount ?? 0;
      this.latestPower = state.latestPower ?? 0;
      this.latestEnergy = state.latestEnergy ?? 0;
      this.powerHistory = state.powerHistory ?? [];
      this.energyHistory = state.energyHistory ?? [];
      Object.assign(this.messageTypes, state.messageTypes ?? {});
      this.initialEnergy = state.initialEnergy ?? null;
      this.currentTransactionId = state.currentTransactionId ?? null;
      this.lastEnergyTime = state.lastEnergyTime ?? null;
      this.lastEnergyValue = state.lastEnergyValue ?? null;
      this.lifetimeChargedEnergyKwh = state.lifetimeChargedEnergyKwh ?? 0;
      this.lastMessageAt = state.lastMessageAt ?? null;
      this.log.info("Loaded persistent session state from disk", { filePath });
    } catch (err: any) {
      this.log.error("Failed to load persistent session state", { error: err.message });
    }
  }

  private async saveSessionState(force = false) {
    if (!force && Date.now() - this.lastStateWriteTime < 10_000) {
      return;
    }
    this.lastStateWriteTime = Date.now();

    const filePath = path.join(this.queueDir, this.chargePointId, "session_state.json");
    const state = {
      connectedAt: this.connectedAt,
      messageCount: this.messageCount,
      latestPower: this.latestPower,
      latestEnergy: this.latestEnergy,
      powerHistory: this.powerHistory,
      energyHistory: this.energyHistory,
      messageTypes: this.messageTypes,
      initialEnergy: this.initialEnergy,
      currentTransactionId: this.currentTransactionId,
      lastEnergyTime: this.lastEnergyTime,
      lastEnergyValue: this.lastEnergyValue,
      lifetimeChargedEnergyKwh: this.lifetimeChargedEnergyKwh,
      lastMessageAt: this.lastMessageAt,
    };

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
      this.log.debug("Saved persistent session state to disk", { filePath });
    } catch (err: any) {
      this.log.error("Failed to save persistent session state", { error: err.message });
    }
  }

  private setup() {
    this.loadSessionStateSync();
    this.primary = this.connectPrimary(this.primaryUrl);

    for (const url of this.secondaryUrls) {
      const diskQueue = new PersistentQueue(this.queueDir, this.chargePointId, url);
      diskQueue.init().catch((err) => {
        this.log.error("Failed to initialize secondary disk queue", {
          url: maskUrl(url),
          error: err.message,
        });
      });

      const state: SecondaryState = {
        url,
        ws: null,
        queue: [],
        diskQueue,
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
      };
      this.secondaries.push(state);
      state.ws = this.connectSecondary(state);
    }

    this.charger.on("message", (data) => {
      this.lastMessageAt = Date.now();
      this.messageCount++;
      const raw = data.toString();
      this.trackMessage(raw);
      this.log.debug("charger → proxy", { message: this.summarise(raw) });

      // Intercept StartTransaction and StopTransaction
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed[0] === 2) {
          if (parsed[2] === "StartTransaction") {
            const payload = parsed[3] as Record<string, any>;
            if (payload && typeof payload.meterStart === "number") {
              // Commit previous session's energy before resetting if we had an ongoing transaction
              if (this.initialEnergy !== null && this.latestEnergy !== undefined) {
                this.lifetimeChargedEnergyKwh = roundToThreeDecimals(this.lifetimeChargedEnergyKwh + this.latestEnergy);
                this.log.info("Committing energy from previous transaction to lifetime total", {
                  committedKwh: this.latestEnergy,
                  newLifetimeKwh: this.lifetimeChargedEnergyKwh
                });
              }

              const startWh = payload.meterStart;
              this.initialEnergy = roundToThreeDecimals(startWh / 1000);
              this.currentTransactionId = null;
              this.latestEnergy = 0;
              this.energyHistory = [];
              this.lastEnergyTime = null;
              this.lastEnergyValue = null;
              this.latestPower = 0;
              this.powerHistory = [];
              this.log.info("intercepted StartTransaction: resetting initial session energy", {
                meterStartKwh: this.initialEnergy
              });
              this.saveSessionState(true);
            }
          } else if (parsed[2] === "StopTransaction") {
            if (this.initialEnergy !== null && this.latestEnergy !== undefined) {
              this.lifetimeChargedEnergyKwh = roundToThreeDecimals(this.lifetimeChargedEnergyKwh + this.latestEnergy);
              this.log.info("intercepted StopTransaction: committing transaction energy to lifetime total", {
                committedKwh: this.latestEnergy,
                newLifetimeKwh: this.lifetimeChargedEnergyKwh
              });
            }
            this.initialEnergy = null;
            this.currentTransactionId = null;
            this.latestEnergy = 0;
            this.energyHistory = [];
            this.lastEnergyTime = null;
            this.lastEnergyValue = null;
            this.latestPower = 0;
            this.powerHistory = [];
            this.saveSessionState(true);
          }
        }
      } catch {
        // ignore JSON parse errors
      }

      // Parse OCPP MeterValues for dashboard graphs
      const metrics = parseMeterValues(raw);
      if (metrics) {
        const timestamp = Date.now();

        // Log the parsed metrics for debugging
        this.log.debug("parsed meter values", { metrics });

        // Reset session energy on transaction change
        if (metrics.transactionId !== undefined) {
          if (this.currentTransactionId !== metrics.transactionId) {
            if (this.currentTransactionId !== null) {
              this.log.info("transaction changed, resetting session energy", {
                old: this.currentTransactionId,
                new: metrics.transactionId
              });
              // Commit previous session's energy before resetting if we had an ongoing transaction
              if (this.initialEnergy !== null && this.latestEnergy !== undefined) {
                this.lifetimeChargedEnergyKwh = roundToThreeDecimals(this.lifetimeChargedEnergyKwh + this.latestEnergy);
                this.log.info("Committing energy from changed transaction to lifetime total", {
                  committedKwh: this.latestEnergy,
                  newLifetimeKwh: this.lifetimeChargedEnergyKwh
                });
              }
              this.initialEnergy = null; // will reset on next energy reading
              this.energyHistory = [];
              this.lastEnergyTime = null;
              this.lastEnergyValue = null;
              this.latestPower = 0;
              this.powerHistory = [];
            } else {
              this.log.info("transaction ID resolved", {
                new: metrics.transactionId
              });
            }
            this.currentTransactionId = metrics.transactionId;
            this.saveSessionState(true);
          }
        }

        // Handle energy & session energy calculation
        if (metrics.energy !== undefined) {
          if (this.initialEnergy === null) {
            this.initialEnergy = metrics.energy;
            this.log.info("set initial session energy", { initialEnergy: this.initialEnergy });
          }

          const calculatedSessionEnergy = Math.max(0, roundToThreeDecimals(metrics.energy - this.initialEnergy));
          this.latestEnergy = calculatedSessionEnergy;

          this.energyHistory.push({ time: timestamp, value: calculatedSessionEnergy });
          if (this.energyHistory.length > 100) this.energyHistory.shift();
        }

        // Handle power (with fallback calculation)
        let resolvedPower: number | undefined = metrics.power;

        if (resolvedPower === undefined && metrics.energy !== undefined) {
          if (this.lastEnergyTime !== null && this.lastEnergyValue !== null) {
            const timeDeltaMs = timestamp - this.lastEnergyTime;
            const energyDeltaKwh = metrics.energy - this.lastEnergyValue;

            if (energyDeltaKwh > 0) {
              const timeDeltaHours = timeDeltaMs / 3600000;
              const calculatedPower = energyDeltaKwh / timeDeltaHours;

              if (calculatedPower >= 0 && calculatedPower <= 150) {
                resolvedPower = calculatedPower;
                this.latestPower = resolvedPower;
                this.powerHistory.push({ time: timestamp, value: resolvedPower });
                if (this.powerHistory.length > 100) this.powerHistory.shift();
              }

              this.lastEnergyTime = timestamp;
              this.lastEnergyValue = metrics.energy;
            } else if (timeDeltaMs > 120000) {
              // No energy increase for > 2 minutes: power has dropped to 0
              resolvedPower = 0;
              this.latestPower = resolvedPower;
              this.powerHistory.push({ time: timestamp, value: resolvedPower });
              if (this.powerHistory.length > 100) this.powerHistory.shift();
              this.lastEnergyTime = timestamp;
            }
          } else {
            this.lastEnergyTime = timestamp;
            this.lastEnergyValue = metrics.energy;
          }
        } else if (resolvedPower !== undefined) {
          this.latestPower = resolvedPower;
          this.powerHistory.push({ time: timestamp, value: resolvedPower });
          if (this.powerHistory.length > 100) this.powerHistory.shift();
        }
      }

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      } else {
        this.primaryQueue.push(raw);
      }

      for (const sec of this.secondaries) {
        const { critical, messageId } = isCriticalMessage(raw);
        if (sec.ws?.readyState === WebSocket.OPEN && !sec.diskQueue.hasQueuedMessages()) {
          sendAsync(sec.ws, raw).catch((err) => {
            this.log.warn("Direct send to secondary failed, queueing instead", {
              url: maskUrl(sec.url),
              error: err.message,
            });
            if (critical && messageId) {
              sec.diskQueue.enqueue(messageId, raw).catch(() => {});
            } else {
              if (sec.queue.length >= SECONDARY_MAX_QUEUE) sec.queue.shift();
              sec.queue.push(raw);
            }
          });
        } else {
          if (critical && messageId) {
            sec.diskQueue.enqueue(messageId, raw).catch((err) => {
              this.log.error("Failed to write to persistent queue", {
                messageId,
                error: err.message,
              });
            });
          } else {
            if (sec.queue.length >= SECONDARY_MAX_QUEUE) sec.queue.shift();
            sec.queue.push(raw);
          }
        }
      }
      this.saveSessionState(false).catch(() => {});
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
      this.lastMessageAt = Date.now();
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
      const raw = data.toString();
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      this.lastMessageAt = Date.now();
      this.messageCount++;
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

  private async flushSecondaryQueue(state: SecondaryState, ws: WebSocket) {
    if (state.diskQueue.hasQueuedMessages()) {
      this.log.info("secondary flushing persistent queue from disk", {
        url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
        pendingCount: state.diskQueue.getQueueSize(),
      });
      await state.diskQueue.flush((data) => sendAsync(ws, data));
    }

    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued in-memory messages", {
      url: maskUrl(buildUpstreamUrl(state.url, this.chargePointId)),
      count: state.queue.length,
    });
    for (const msg of state.queue) {
      try {
        await sendAsync(ws, msg);
      } catch {
        break;
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
    const activeSessionEnergy = this.initialEnergy !== null
      ? this.latestEnergy
      : 0;
    const totalLifetime = roundToThreeDecimals(this.lifetimeChargedEnergyKwh + activeSessionEnergy);

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
        queueSize: sec.queue.length + sec.diskQueue.getQueueSize(),
        diskQueueSize: sec.diskQueue.getQueueSize()
      })),
      latestPower: this.latestPower,
      latestEnergy: this.latestEnergy,
      lifetimeChargedEnergyKwh: totalLifetime,
      powerHistory: this.powerHistory,
      energyHistory: this.energyHistory,
      messageCount: this.messageCount,
      messageTypes: this.messageTypes,
      lastMessageAt: this.lastMessageAt
    };
  }

  public teardown() {
    if (!this.alive) return;
    this.alive = false;
    this.primaryQueue = [];

    // Force save final session state on teardown
    this.saveSessionState(true).catch(() => {});

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
