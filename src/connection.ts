import WebSocket from "ws";
import { createLogger } from "./logger";
import { OCPP_MSG_CALL, OCPP_SUBPROTOCOLS, type ParsedMessage } from "./types";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - Messages from the charger are forwarded to the primary and mirrored
 *   to all secondaries.
 * - Only the primary CSMS can send commands back to the charger.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link.
 */

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const MAX_SECONDARY_QUEUE = 100;

function buildUpstreamUrl(baseUrl: string, chargePointId: string): string {
  const [path, query] = baseUrl.split("?");
  const cleanPath = `${path.replace(/\/+$/, "")}/${chargePointId}`;
  return query ? `${cleanPath}?${query}` : cleanPath;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: (WebSocket | null)[] = [];
  private alive = true;

  // Per-secondary message queues for when the secondary is reconnecting
  private secondaryQueues: string[][] = [];
  // Per-secondary keepalive intervals
  private secondaryKeepalives: (ReturnType<typeof setInterval> | null)[] = [];

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryUrl: string,
    private readonly secondaryUrls: string[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly endCallback?: () => void
  ) {
    this.log = createLogger(chargePointId);
    this.setup();
  }

  private setup() {
    this.primary = this.connectUpstream(this.primaryUrl, true, -1);

    for (let i = 0; i < this.secondaryUrls.length; i++) {
      this.secondaries.push(null);
      this.secondaryQueues.push([]);
      this.secondaryKeepalives.push(null);
      this.secondaries[i] = this.connectSecondary(this.secondaryUrls[i], i);
    }

    this.charger.on("message", (data) => {
      const raw = data.toString();
      this.log.debug("charger → proxy", { message: this.summarise(raw) });

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      }

      for (let i = 0; i < this.secondaryUrls.length; i++) {
        const sec = this.secondaries[i];
        if (sec?.readyState === WebSocket.OPEN) {
          try {
            sec.send(raw);
          } catch {
            /* best-effort */
          }
        } else {
          // Queue message while secondary is reconnecting
          const q = this.secondaryQueues[i];
          if (q.length < MAX_SECONDARY_QUEUE) {
            q.push(raw);
          } else {
            // Drop oldest to make room
            q.shift();
            q.push(raw);
            this.log.warn("secondary queue full, dropping oldest message", {
              url: this.secondaryUrls[i],
            });
          }
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
      this.primary?.ping(data);
    });

    this.charger.on("pong", (data) => {
      this.primary?.pong(data);
    });

    this.log.info("session started", {
      primary: this.primaryUrl,
      secondaries: this.secondaryUrls,
      protocol: this.protocol,
    });
  }

  /** Connect to the primary upstream CSMS. Its responses go back to the charger. */
  private connectUpstream(baseUrl: string, isPrimary: true, _idx: -1): WebSocket;
  private connectUpstream(baseUrl: string, isPrimary: false, idx: number): WebSocket;
  private connectUpstream(baseUrl: string, isPrimary: boolean, idx: number): WebSocket {
    const url = buildUpstreamUrl(baseUrl, this.chargePointId);
    const label = isPrimary ? "primary" : "secondary";

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const ws = new WebSocket(url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers,
      handshakeTimeout: 10_000,
      autoPong: false,
    });

    ws.on("open", () => {
      this.log.info(`${label} connected`, { url });
    });

    ws.on("message", (data) => {
      const raw = data.toString();

      if (isPrimary) {
        this.log.debug(`${label} → charger`, {
          message: this.summarise(raw),
        });
        if (this.charger.readyState === WebSocket.OPEN) {
          this.charger.send(raw);
        }
      } else {
        this.log.debug(`${label} response (ignored)`, {
          url,
          message: this.summarise(raw),
        });
      }
    });

    ws.on("close", (code, reason) => {
      this.log.warn(`${label} disconnected`, {
        url,
        code,
        reason: reason.toString(),
      });
      if (isPrimary) {
        this.charger.close(1001, "Primary CSMS disconnected");
        this.teardown();
      }
    });

    ws.on("error", (err) => {
      this.log.error(`${label} error`, { url, error: err.message });
      if (isPrimary && this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => {
      if (isPrimary) this.charger.ping(data);
    });

    ws.on("pong", (data) => {
      if (isPrimary) this.charger.pong(data);
    });

    return ws;
  }

  /** Connect (or reconnect) a secondary, with keepalive and auto-reconnect. */
  private connectSecondary(baseUrl: string, idx: number): WebSocket {
    const url = buildUpstreamUrl(baseUrl, this.chargePointId);

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const ws = new WebSocket(url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers,
      handshakeTimeout: 10_000,
      autoPong: false,
    });

    ws.on("open", () => {
      this.log.info("secondary connected", { url });

      // Flush any queued messages
      const q = this.secondaryQueues[idx];
      if (q.length > 0) {
        this.log.info(`secondary flushing ${q.length} queued messages`, { url });
        for (const msg of q) {
          try {
            ws.send(msg);
          } catch {
            /* best-effort */
          }
        }
        this.secondaryQueues[idx] = [];
      }

      // Start keepalive pings so the server doesn't time us out
      this.clearKeepalive(idx);
      this.secondaryKeepalives[idx] = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, SECONDARY_KEEPALIVE_INTERVAL_MS);
    });

    ws.on("message", (data) => {
      this.log.debug("secondary response (ignored)", {
        url,
        message: this.summarise(data.toString()),
      });
    });

    ws.on("close", (code, reason) => {
      this.log.warn("secondary disconnected", {
        url,
        code,
        reason: reason.toString(),
      });
      this.clearKeepalive(idx);
      this.scheduleSecondaryReconnect(baseUrl, idx);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", { url, error: err.message });
      // close event will follow and trigger reconnect
    });

    return ws;
  }

  private scheduleSecondaryReconnect(baseUrl: string, idx: number) {
    if (!this.alive) return;
    this.log.info("secondary reconnecting", {
      url: buildUpstreamUrl(baseUrl, this.chargePointId),
      delayMs: SECONDARY_RECONNECT_DELAY_MS,
    });
    setTimeout(() => {
      if (!this.alive) return;
      this.secondaries[idx] = this.connectSecondary(baseUrl, idx);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private clearKeepalive(idx: number) {
    const handle = this.secondaryKeepalives[idx];
    if (handle !== null) {
      clearInterval(handle);
      this.secondaryKeepalives[idx] = null;
    }
  }

  public teardown() {
    if (!this.alive) return;
    this.alive = false;

    // Clear all secondary keepalives
    for (let i = 0; i < this.secondaryKeepalives.length; i++) {
      this.clearKeepalive(i);
    }

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    this.secondaries.forEach(close);
    close(this.charger);

    this.log.info("session ended");
    this.endCallback?.();
  }

  /** Return a short summary string for logging (avoids dumping huge payloads). */
  private summarise(raw: string): string {
    try {
      const msg = JSON.parse(raw) as unknown[];
      if (!Array.isArray(msg) || msg.length < 3) return raw.slice(0, 120);

      const type = msg[0] as number;
      const id = msg[1] as string;

      if (type === OCPP_MSG_CALL) {
        return `[CALL] ${msg[2]} (${id})`;
      }
      return `[${type === 3 ? "RESULT" : "ERROR"}] (${id})`;
    } catch {
      return raw.slice(0, 120);
    }
  }
}
