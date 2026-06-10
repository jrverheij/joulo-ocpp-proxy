import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import { ChargerConnection } from "./connection";

class MockWebSocket extends EventEmitter {
  public readyState = 1; // OPEN
  public protocol = "ocpp1.6";
  public sendCalled = false;
  public lastSentData: string | null = null;

  send(data: string, cb?: (err?: Error) => void) {
    this.sendCalled = true;
    this.lastSentData = data;
    if (cb) process.nextTick(() => cb());
  }

  ping() {}
  pong() {}
  close() {
    this.readyState = 3; // CLOSED
    this.emit("close", 1000, "");
  }
}

describe("ChargerConnection State & Accumulator", () => {
  const testBaseDir = path.resolve("./test-conn-state-temp");

  before(async () => {
    await fsPromises.rm(testBaseDir, { recursive: true, force: true });
  });

  after(async () => {
    await fsPromises.rm(testBaseDir, { recursive: true, force: true });
  });

  it("should initialize with default state if no file exists", async () => {
    const chargePointId = "CP_STATE_TEST_1";
    const mockCharger = new MockWebSocket() as any;
    const conn = new ChargerConnection(
      mockCharger,
      chargePointId,
      "ws://localhost:8001",
      [],
      testBaseDir,
      "ocpp1.6",
      undefined,
      "127.0.0.1"
    );

    const metrics = conn.getMetrics();
    assert.strictEqual(metrics.lifetimeChargedEnergyKwh, 0);
    assert.strictEqual(metrics.messageCount, 0);
    conn.teardown();
    // Allow any background writes to finish
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("should load existing state from session_state.json", async () => {
    const chargePointId = "CP_STATE_TEST_2";
    const stateFilePath = path.join(testBaseDir, chargePointId, "session_state.json");
    
    await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
    const preExistingState = {
      connectedAt: 123456789,
      messageCount: 50,
      latestPower: 5.5,
      latestEnergy: 12.0,
      powerHistory: [{ time: 123456789, value: 5.5 }],
      energyHistory: [{ time: 123456789, value: 12.0 }],
      messageTypes: { "MeterValues": 50 },
      initialEnergy: 500.0,
      currentTransactionId: 1001,
      lifetimeChargedEnergyKwh: 350.0
    };
    await fsPromises.writeFile(stateFilePath, JSON.stringify(preExistingState, null, 2), "utf8");

    const mockCharger = new MockWebSocket() as any;
    const conn = new ChargerConnection(
      mockCharger,
      chargePointId,
      "ws://localhost:8001",
      [],
      testBaseDir,
      "ocpp1.6",
      undefined,
      "127.0.0.1"
    );

    const metrics = conn.getMetrics();
    assert.strictEqual(metrics.lifetimeChargedEnergyKwh, 362.0);
    assert.strictEqual(metrics.messageCount, 0);
    assert.strictEqual(metrics.latestPower, 5.5);
    assert.strictEqual(metrics.connectedAt !== 123456789, true);
    assert.strictEqual(Date.now() - metrics.connectedAt < 5000, true);
    conn.teardown();
    // Allow any background writes to finish
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("should accumulate lifetime energy correctly across transaction boundaries", async () => {
    const chargePointId = "CP_STATE_TEST_3";
    const mockCharger = new MockWebSocket() as any;
    const conn = new ChargerConnection(
      mockCharger,
      chargePointId,
      "ws://localhost:8001",
      [],
      testBaseDir,
      "ocpp1.6",
      undefined,
      "127.0.0.1"
    );

    const startMsg = JSON.stringify([2, "msg-start-1", "StartTransaction", { meterStart: 100000 }]);
    mockCharger.emit("message", Buffer.from(startMsg));

    const mvMsg = JSON.stringify([2, "msg-mv-1", "MeterValues", {
      transactionId: 101,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: "105.5", measurand: "Energy.Active.Import.Register", unit: "kWh" }]
      }]
    }]);
    mockCharger.emit("message", Buffer.from(mvMsg));

    let metrics = conn.getMetrics();
    assert.strictEqual(metrics.latestEnergy, 5.5);
    assert.strictEqual(metrics.lifetimeChargedEnergyKwh, 5.5);

    const stopMsg = JSON.stringify([2, "msg-stop-1", "StopTransaction", {}]);
    mockCharger.emit("message", Buffer.from(stopMsg));

    metrics = conn.getMetrics();
    assert.strictEqual(metrics.latestEnergy, 0);
    assert.strictEqual(metrics.lifetimeChargedEnergyKwh, 5.5);

    const startMsg2 = JSON.stringify([2, "msg-start-2", "StartTransaction", { meterStart: 200000 }]);
    mockCharger.emit("message", Buffer.from(startMsg2));

    const mvMsg2 = JSON.stringify([2, "msg-mv-2", "MeterValues", {
      transactionId: 102,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [{ value: "203.2", measurand: "Energy.Active.Import.Register", unit: "kWh" }]
      }]
    }]);
    mockCharger.emit("message", Buffer.from(mvMsg2));

    metrics = conn.getMetrics();
    assert.strictEqual(metrics.latestEnergy, 3.2);
    assert.strictEqual(metrics.lifetimeChargedEnergyKwh, 8.7);

    conn.teardown();
    // Allow any background writes to finish
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
