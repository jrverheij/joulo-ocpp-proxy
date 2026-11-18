import { describe, expect, it, beforeEach, vi, afterAll } from "vitest";
import WebSocket from "ws";
import fsPromises from "fs/promises";
import path from "path";
import type { CsmsBackend } from "../../src/config";
import { ChargerConnection } from "../../src/connection";

interface MockSocket {
  readyState: number;
  sent: string[];
  failNextSend: boolean;
  emit: (event: string, ...args: unknown[]) => void;
  send: (data: string, cb?: (err?: Error) => void) => void;
  close: () => void;
  ping: () => void;
  pong: () => void;
}

let sockets: MockSocket[] = [];

vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    failNextSend = false;
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(_url: string | null) {
      sockets.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = this.handlers.get(event);
      if (existing) existing.push(handler);
      else this.handlers.set(event, [handler]);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(data: string, cb?: (err?: Error) => void) {
      if (this.failNextSend) {
        this.failNextSend = false;
        const err = new Error("socket error");
        if (cb) cb(err);
        throw err;
      }
      this.sent.push(data);
      if (cb) cb();
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, "");
    }

    ping() {}
    pong() {}
  }

  return {
    default: MockWebSocket,
  };
});

describe("ChargerConnection Response Mirroring (PR #51)", () => {
  const testQueueDir = path.resolve("./test-queue-mirroring-temp");

  beforeEach(() => {
    sockets = [];
  });

  afterAll(async () => {
    await fsPromises.rm(testQueueDir, { recursive: true, force: true });
  });

  function setupConnection() {
    const charger = new WebSocket(null);
    const primaryBackend: CsmsBackend = {
      url: "ws://primary.example/ocpp",
      appendChargePointId: false,
    };
    const secondaryBackend: CsmsBackend = {
      url: "ws://secondary.example/ocpp",
      appendChargePointId: false,
    };

    const connection = new ChargerConnection(
      charger,
      "CP-MIRROR-TEST",
      primaryBackend,
      [secondaryBackend],
      testQueueDir,
      "ocpp1.6",
      undefined,
      "127.0.0.1"
    );

    // sockets order: [0: charger, 1: primary, 2: secondary]
    const [chargerSocket, primarySocket, secondarySocket] = sockets;
    return { connection, chargerSocket, primarySocket, secondarySocket };
  }

  it("forwards charger CALL frames to both primary and secondaries", () => {
    const { connection, chargerSocket, primarySocket, secondarySocket } = setupConnection();
    const frame = '[2,"msg-1","Heartbeat",{}]';

    chargerSocket.emit("message", Buffer.from(frame));

    expect(primarySocket.sent).toContain(frame);
    expect(secondarySocket.sent).toContain(frame);
    connection.teardown();
  });

  it("withholds charger CALLRESULT frames from secondaries while forwarding to primary (PR #51)", () => {
    const { connection, chargerSocket, primarySocket, secondarySocket } = setupConnection();
    const resultFrame = '[3,"msg-resp-1",{"status":"Accepted"}]';

    chargerSocket.emit("message", Buffer.from(resultFrame));

    expect(primarySocket.sent).toContain(resultFrame);
    expect(secondarySocket.sent).not.toContain(resultFrame);
    connection.teardown();
  });

  it("withholds charger CALLERROR frames from secondaries while forwarding to primary (PR #51)", () => {
    const { connection, chargerSocket, primarySocket, secondarySocket } = setupConnection();
    const errorFrame = '[4,"msg-err-1","NotSupported","Details",{}]';

    chargerSocket.emit("message", Buffer.from(errorFrame));

    expect(primarySocket.sent).toContain(errorFrame);
    expect(secondarySocket.sent).not.toContain(errorFrame);
    connection.teardown();
  });
});
