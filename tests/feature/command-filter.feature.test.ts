import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import fs from "fs";
import path from "path";

import { startProxy } from "../../src/proxy";
import { rawDataToString } from "../../src/utils/websocket";
import type { Config } from "../../src/config";

interface WsRecord {
  httpServer: ReturnType<typeof createServer>;
  server: WebSocketServer;
  connections: WebSocket[];
}

function createWsServer(): WsRecord {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  const connections: WebSocket[] = [];
  server.on("connection", (socket) => {
    connections.push(socket);
  });
  return { httpServer, server, connections };
}

function startWsServer(record: WsRecord): Promise<number> {
  const { httpServer } = record;
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Unable to obtain server port"));
      }
    });
  });
}

function closeWsServer(record: WsRecord): Promise<void> {
  for (const conn of record.connections) {
    conn.terminate();
  }
  return new Promise((resolve) => {
    record.server.close(() => {
      record.httpServer.close(() => resolve());
    });
  });
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket open timeout")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(socket: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket message timeout")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(rawDataToString(data));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Feature: OCPP CSMS Command Filtering", () => {
  const queueDir = path.join(process.cwd(), "tests", "fixtures", "filter-test-queue");
  let primaryWsRecord: WsRecord;
  let primaryPort: number;
  let proxyServer: ReturnType<typeof startProxy> | null = null;
  let proxyPort: number;

  beforeEach(async () => {
    fs.rmSync(queueDir, { recursive: true, force: true });
    primaryWsRecord = createWsServer();
    primaryPort = await startWsServer(primaryWsRecord);
  });

  afterEach(async () => {
    if (proxyServer) {
      const serverToClose = proxyServer.server;
      await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
      proxyServer = null;
    }
    await closeWsServer(primaryWsRecord);
    fs.rmSync(queueDir, { recursive: true, force: true });
  });

  it("intercepts ChangeConfiguration and UpdateFirmware while passing allowed commands", async () => {
    proxyPort = 19100 + Math.floor(Math.random() * 500);

    const config: Config = {
      port: proxyPort,
      primaryCsms: {
        url: `ws://127.0.0.1:${primaryPort}/ocpp`,
        appendChargePointId: true,
      },
      secondaryCsms: [],
      loggerConfig: { logLevel: "error" },
      queueDir,
      blockedCsmsActions: ["ChangeConfiguration", "UpdateFirmware"],
    };

    proxyServer = startProxy(config);
    await sleep(150);

    // 1. Connect mock charger
    const charger = new WebSocket(`ws://127.0.0.1:${proxyPort}/CP-FILTER-01`, "ocpp1.6");
    await waitForOpen(charger);

    // Wait until primary receives the connection from the proxy
    let primaryToProxySocket: WebSocket | null = null;
    for (let i = 0; i < 20; i++) {
      if (primaryWsRecord.connections.length > 0) {
        primaryToProxySocket = primaryWsRecord.connections[0];
        break;
      }
      await sleep(50);
    }
    expect(primaryToProxySocket).not.toBeNull();
    if (!primaryToProxySocket) {
      throw new Error("Primary connection socket was not established");
    }

    // 2. Test blocked ChangeConfiguration
    const chargerMessages: string[] = [];
    charger.on("message", (data) => {
      chargerMessages.push(rawDataToString(data));
    });

    const changeConfigCall = JSON.stringify([
      2,
      "csms-msg-101",
      "ChangeConfiguration",
      { key: "MaxCurrent", value: "6" },
    ]);

    const primaryReplyPromise = waitForMessage(primaryToProxySocket);
    primaryToProxySocket.send(changeConfigCall);

    const replyFromProxy = await primaryReplyPromise;
    expect(JSON.parse(replyFromProxy)).toEqual([
      3,
      "csms-msg-101",
      { status: "Rejected" },
    ]);

    // Ensure charger received NOTHING
    await sleep(100);
    expect(chargerMessages).toHaveLength(0);

    // 3. Test blocked UpdateFirmware
    const updateFwCall = JSON.stringify([
      2,
      "csms-msg-102",
      "UpdateFirmware",
      { location: "https://firmware.evil.com/patch.bin", retrieveDate: "2026-11-01T00:00:00Z" },
    ]);

    const fwReplyPromise = waitForMessage(primaryToProxySocket);
    primaryToProxySocket.send(updateFwCall);

    const fwReply = await fwReplyPromise;
    const parsedFwReply = JSON.parse(fwReply);
    expect(parsedFwReply[0]).toBe(4); // CallError
    expect(parsedFwReply[1]).toBe("csms-msg-102");
    expect(parsedFwReply[2]).toBe("NotSupported");

    // Charger still received nothing
    expect(chargerMessages).toHaveLength(0);

    // 4. Test allowed RemoteStartTransaction
    const allowPromise = waitForMessage(charger);
    const remoteStartCall = JSON.stringify([
      2,
      "csms-msg-103",
      "RemoteStartTransaction",
      { idTag: "VALID-RFID-123", connectorId: 1 },
    ]);
    primaryToProxySocket.send(remoteStartCall);

    const msgAtCharger = await allowPromise;
    expect(msgAtCharger).toBe(remoteStartCall);

    charger.close();
  });
});
