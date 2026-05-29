export interface Config {
  port: number;
  primaryUrl: string;
  secondaryUrls: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadConfig(): Config {
  const primaryUrl = process.env.PRIMARY_CSMS_URL;
  if (!primaryUrl) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it to your primary CSMS WebSocket URL."
    );
  }

  const raw = process.env.SECONDARY_CSMS_URLS ?? "";
  const secondaryUrls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel = LOG_LEVELS.includes(level as any)
    ? (level as Config["logLevel"])
    : "info";

  const portRaw = process.env.PORT ?? "9000";
  const port = parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT value: "${portRaw}". Must be an integer between 1 and 65535.`
    );
  }

  return {
    port,
    primaryUrl,
    secondaryUrls,
    logLevel,
  };
}
