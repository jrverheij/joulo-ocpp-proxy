import { describe, it, beforeAll, afterAll, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { PersistentQueue } from "../../src/queue";

describe("PersistentQueue", () => {
  const testBaseDir = path.resolve("./test-queue-temp");
  const chargePointId = "CP12345";
  const secondaryUrl = "ws://localhost:9999/ocpp";

  beforeAll(async () => {
    await fs.rm(testBaseDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(testBaseDir, { recursive: true, force: true });
  });

  it("should initialize an empty queue directory", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    expect(queue.hasQueuedMessages()).toBe(false);
    expect(queue.getQueueSize()).toBe(0);
    const dirExists = await fs.stat(queue.getQueueDir()).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
  });

  it("should write messages to disk and sort them chronologically", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    await queue.enqueue("msg-1", JSON.stringify([2, "msg-1", "MeterValues", {}]));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.enqueue("msg-2", JSON.stringify([2, "msg-2", "StopTransaction", {}]));

    expect(queue.hasQueuedMessages()).toBe(true);
    expect(queue.getQueueSize()).toBe(2);

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
    expect(jsonFiles.length).toBe(2);
    expect(jsonFiles[0]).toMatch(/-msg-1\.json$/);
    expect(jsonFiles[1]).toMatch(/-msg-2\.json$/);
  });

  it("should flush successfully and remove files", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    const sent: string[] = [];
    const sender = async (data: string) => {
      sent.push(data);
    };

    await queue.flush(sender);

    expect(sent.length).toBe(2);
    const parsed1 = JSON.parse(sent[0]);
    const parsed2 = JSON.parse(sent[1]);
    expect(parsed1[1]).toBe("msg-1");
    expect(parsed2[1]).toBe("msg-2");

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBe(0);
    expect(queue.hasQueuedMessages()).toBe(false);
    expect(queue.getQueueSize()).toBe(0);
  });

  it("should retain file if transmission fails", async () => {
    const queue = new PersistentQueue(testBaseDir, chargePointId, secondaryUrl);
    await queue.init();

    await queue.enqueue("msg-3", JSON.stringify([2, "msg-3", "MeterValues", {}]));
    expect(queue.getQueueSize()).toBe(1);

    let callCount = 0;
    const failingSender = async (data: string) => {
      callCount++;
      throw new Error("Connection timed out");
    };

    await queue.flush(failingSender);

    expect(callCount).toBe(1);
    expect(queue.hasQueuedMessages()).toBe(true);
    expect(queue.getQueueSize()).toBe(1);

    const files = await fs.readdir(queue.getQueueDir());
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBe(1);
  });
});
