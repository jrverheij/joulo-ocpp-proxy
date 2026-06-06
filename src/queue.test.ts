import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";
import { PersistentQueue } from "./queue";

describe("PersistentQueue", () => {
  const testBaseDir = path.resolve("./test-queue-temp");
  const chargePointId = "CP12345";
  const secondaryUrl = "ws://localhost:9999/ocpp";

  before(async () => {
    await fs.rm(testBaseDir, { recursive: true, force: true });
  });

  after(async () => {
    await fs.rm(testBaseDir, { recursive: true, force: true });
  });

  it("should initialize an empty queue directory", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    assert.strictEqual(queue.hasQueuedMessages(), false);
    assert.strictEqual(queue.getQueueSize(), 0);
    const dirExists = await fs.stat(queue.getQueueDir()).then(() => true).catch(() => false);
    assert.strictEqual(dirExists, true);
  });

  it("should write messages to disk and sort them chronologically", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    await queue.enqueue("msg-1", JSON.stringify([2, "msg-1", "MeterValues", {}]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.enqueue("msg-2", JSON.stringify([2, "msg-2", "StopTransaction", {}]));

    assert.strictEqual(queue.hasQueuedMessages(), true);
    assert.strictEqual(queue.getQueueSize(), 2);

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
    assert.strictEqual(jsonFiles.length, 2);
    assert.match(jsonFiles[0], /-msg-1\.json$/);
    assert.match(jsonFiles[1], /-msg-2\.json$/);
  });

  it("should flush successfully and remove files", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    const sent: string[] = [];
    const sender = async (data: string) => {
      sent.push(data);
    };

    await queue.flush(sender);

    assert.strictEqual(sent.length, 2);
    const parsed1 = JSON.parse(sent[0]);
    const parsed2 = JSON.parse(sent[1]);
    assert.strictEqual(parsed1[1], "msg-1");
    assert.strictEqual(parsed2[1], "msg-2");

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.strictEqual(jsonFiles.length, 0);
    assert.strictEqual(queue.hasQueuedMessages(), false);
    assert.strictEqual(queue.getQueueSize(), 0);
  });

  it("should retain file if transmission fails", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    await queue.enqueue("msg-3", JSON.stringify([2, "msg-3", "MeterValues", {}]));
    assert.strictEqual(queue.getQueueSize(), 1);

    let callCount = 0;
    const failingSender = async (data: string) => {
      callCount++;
      throw new Error("Connection timed out");
    };

    await queue.flush(failingSender);

    assert.strictEqual(callCount, 1);
    assert.strictEqual(queue.hasQueuedMessages(), true);
    assert.strictEqual(queue.getQueueSize(), 1);

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.strictEqual(jsonFiles.length, 1);
  });
});
