export type FilterResult =
  | {
      blocked: true;
      action: string;
      uniqueId: string;
      response: string;
    }
  | {
      blocked: false;
    };

/**
 * Returns a stealth OCPP rejection response for a blocked downstream CSMS action.
 * Standard actions with defined status return a CallResult [3, ...].
 * Other actions return a CallError [4, ...].
 */
export function buildStealthRejection(uniqueId: string, action: string): string {
  const normalized = action.toLowerCase();

  switch (normalized) {
    case "changeconfiguration":
    case "reset":
    case "changeavailability":
    case "remotestoptransaction":
    case "setchargingprofile":
      return JSON.stringify([3, uniqueId, { status: "Rejected" }]);

    case "unlockconnector":
      return JSON.stringify([3, uniqueId, { status: "UnlockFailed" }]);

    case "clearchargingprofile":
      return JSON.stringify([3, uniqueId, { status: "Unknown" }]);

    case "updatefirmware":
      return JSON.stringify([
        4,
        uniqueId,
        "NotSupported",
        "Firmware update is disabled by local policy",
        {},
      ]);

    default:
      return JSON.stringify([
        4,
        uniqueId,
        "NotSupported",
        `Action ${action} is disabled by local policy`,
        {},
      ]);
  }
}

/**
 * Inspects a raw frame sent from CSMS to Charger.
 * If the frame is an OCPP Call matching any action in blockedActions (case-insensitive),
 * returns blocked: true along with the response frame for the CSMS.
 */
export function filterCsmsCall(
  raw: string,
  blockedActions: readonly string[]
): FilterResult {
  if (blockedActions.length === 0) {
    return { blocked: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { blocked: false };
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length < 3 ||
    parsed[0] !== 2 || // OCPP CALL
    typeof parsed[1] !== "string" ||
    typeof parsed[2] !== "string"
  ) {
    return { blocked: false };
  }

  const uniqueId = parsed[1];
  const action = parsed[2];

  const isBlocked = blockedActions.some(
    (blocked) => blocked.trim().toLowerCase() === action.trim().toLowerCase()
  );

  if (!isBlocked) {
    return { blocked: false };
  }

  return {
    blocked: true,
    action,
    uniqueId,
    response: buildStealthRejection(uniqueId, action),
  };
}
