import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { createLogger } from "./logger";

export class PersistentQueue {
  private queueDir: string;
  private hasFiles: boolean = false;
  private pendingCount: number = 0;
  private isFlushing: boolean = false;
  private log;

  constructor(
    baseDir: string,
    private chargePointId: string,
    private secondaryUrl: string
  ) {
    const urlHash = crypto.createHash("sha256").update(secondaryUrl).digest("hex").slice(0, 12);
    // Resolve the directory path (absolute or relative)
    this.queueDir = path.resolve(baseDir, chargePointId, urlHash);
    this.log = createLogger(`queue:${chargePointId}:${urlHash.slice(0, 6)}`);
  }

  /**
   * Initializes the queue directory and checks for pre-existing files on disk.
   */
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.queueDir, { recursive: true });
      const files = await fs.readdir(this.queueDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      this.pendingCount = jsonFiles.length;
      this.hasFiles = this.pendingCount > 0;
      
      if (this.hasFiles) {
        this.log.info("Initialized queue with pending messages on disk", {
          queueDir: this.queueDir,
          pendingCount: this.pendingCount,
        });
      } else {
        this.log.debug("Initialized empty queue on disk", {
          queueDir: this.queueDir,
        });
      }
    } catch (err: any) {
      this.log.error("Failed to initialize persistent queue directory", {
        error: err.message,
        queueDir: this.queueDir,
      });
      throw err;
    }
  }

  /**
   * Enqueues an OCPP message to the persistent storage.
   */
  async enqueue(messageId: string, rawMessage: string): Promise<void> {
    // Prefix with timestamp to ensure alphabetical/chronological sorting
    const filename = `${Date.now()}-${messageId}.json`;
    const filePath = path.join(this.queueDir, filename);
    try {
      await fs.writeFile(filePath, rawMessage, "utf8");
      this.pendingCount++;
      this.hasFiles = true;
      this.log.info("Persistently queued critical message", {
        messageId,
        filePath,
        queueSize: this.pendingCount,
      });
    } catch (err: any) {
      this.log.error("Failed to write message to persistent queue", {
        messageId,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Returns whether there are currently files queued on disk.
   */
  hasQueuedMessages(): boolean {
    return this.hasFiles;
  }

  /**
   * Returns the cached count of pending messages on disk.
   */
  getQueueSize(): number {
    return this.pendingCount;
  }

  /**
   * Reads queued files, sends them sequentially using the provided sender function,
   * and deletes them upon success. Stops flushing if the sender function throws.
   */
  async flush(sendFn: (data: string) => Promise<void>): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      while (true) {
        const files = await fs.readdir(this.queueDir);
        const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

        if (jsonFiles.length === 0) {
          this.pendingCount = 0;
          this.hasFiles = false;
          break;
        }

        const file = jsonFiles[0];
        const filePath = path.join(this.queueDir, file);
        
        let data: string;
        try {
          const buffer = await fs.readFile(filePath);
          data = buffer.toString("utf8");
        } catch (err: any) {
          this.log.error("Failed to read queued file, skipping", {
            file,
            error: err.message,
          });
          // Remove corrupted/unreadable file to prevent blocking the queue
          try {
            await fs.unlink(filePath);
            this.pendingCount = Math.max(0, this.pendingCount - 1);
          } catch {}
          continue;
        }

        // Attempt transmission
        try {
          await sendFn(data);
        } catch (err: any) {
          this.log.warn("Failed to transmit queued message, pausing flush", {
            file,
            error: err.message,
          });
          // Propagate error to stop the flush loop and preserve the file
          throw err;
        }

        // Successful transmission, clean up file
        try {
          await fs.unlink(filePath);
          this.pendingCount = Math.max(0, this.pendingCount - 1);
          this.log.debug("Successfully transmitted and unlinked queued message", { file });
        } catch (err: any) {
          this.log.error("Failed to delete processed queue file", {
            file,
            error: err.message,
          });
        }
      }
    } catch (err: any) {
      // Transmission failures are expected when offline
      this.log.debug("Flush interrupted or finished with error/pause");
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Helper to return the absolute queue directory path (useful for testing)
   */
  getQueueDir(): string {
    return this.queueDir;
  }
}
