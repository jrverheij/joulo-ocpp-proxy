import { describe, expect, it } from "vitest";
import { buildStealthRejection, filterCsmsCall } from "../../src/utils/ocpp-filter";

describe("ocpp-filter", () => {
  describe("buildStealthRejection", () => {
    it("returns Rejected status for ChangeConfiguration", () => {
      const response = buildStealthRejection("101", "ChangeConfiguration");
      expect(JSON.parse(response)).toEqual([3, "101", { status: "Rejected" }]);
    });

    it("returns UnlockFailed status for UnlockConnector", () => {
      const response = buildStealthRejection("102", "UnlockConnector");
      expect(JSON.parse(response)).toEqual([3, "102", { status: "UnlockFailed" }]);
    });

    it("returns Rejected status for Reset and RemoteStopTransaction", () => {
      expect(JSON.parse(buildStealthRejection("103", "Reset"))).toEqual([
        3,
        "103",
        { status: "Rejected" },
      ]);
      expect(JSON.parse(buildStealthRejection("104", "RemoteStopTransaction"))).toEqual([
        3,
        "104",
        { status: "Rejected" },
      ]);
      expect(JSON.parse(buildStealthRejection("105", "ChangeAvailability"))).toEqual([
        3,
        "105",
        { status: "Rejected" },
      ]);
    });

    it("returns NotSupported CallError for UpdateFirmware", () => {
      const response = buildStealthRejection("106", "UpdateFirmware");
      const parsed = JSON.parse(response);
      expect(parsed[0]).toBe(4);
      expect(parsed[1]).toBe("106");
      expect(parsed[2]).toBe("NotSupported");
    });

    it("returns generic NotSupported CallError for unknown action", () => {
      const response = buildStealthRejection("107", "CustomAction");
      const parsed = JSON.parse(response);
      expect(parsed[0]).toBe(4);
      expect(parsed[1]).toBe("107");
      expect(parsed[2]).toBe("NotSupported");
    });
  });

  describe("filterCsmsCall", () => {
    const blockedActions = ["ChangeConfiguration", "UpdateFirmware"];

    it("blocks configured ChangeConfiguration call", () => {
      const raw = JSON.stringify([
        2,
        "req-1",
        "ChangeConfiguration",
        { key: "HeartbeatInterval", value: "30" },
      ]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result).toEqual({
        blocked: true,
        action: "ChangeConfiguration",
        uniqueId: "req-1",
        response: JSON.stringify([3, "req-1", { status: "Rejected" }]),
      });
    });

    it("is case-insensitive when matching blocked actions", () => {
      const raw = JSON.stringify([
        2,
        "req-2",
        "changeconfiguration",
        { key: "AuthorizeRemoteTxRequests", value: "true" },
      ]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result).toEqual({
        blocked: true,
        action: "changeconfiguration",
        uniqueId: "req-2",
        response: JSON.stringify([3, "req-2", { status: "Rejected" }]),
      });
    });

    it("blocks configured UpdateFirmware call", () => {
      const raw = JSON.stringify([
        2,
        "req-3",
        "UpdateFirmware",
        { location: "https://example.com/fw.bin", retrieveDate: "2026-11-01T00:00:00Z" },
      ]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result).toMatchObject({
        blocked: true,
        action: "UpdateFirmware",
        uniqueId: "req-3",
      });
    });

    it("allows non-blocked calls like RemoteStartTransaction", () => {
      const raw = JSON.stringify([
        2,
        "req-4",
        "RemoteStartTransaction",
        { idTag: "TAG123", connectorId: 1 },
      ]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result.blocked).toBe(false);
    });

    it("allows CallResult messages from CSMS", () => {
      const raw = JSON.stringify([3, "charger-req-1", { status: "Accepted" }]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result.blocked).toBe(false);
    });

    it("allows CallError messages from CSMS", () => {
      const raw = JSON.stringify([4, "charger-req-2", "NotSupported", "Not supported", {}]);
      const result = filterCsmsCall(raw, blockedActions);

      expect(result.blocked).toBe(false);
    });

    it("ignores malformed JSON without throwing", () => {
      expect(filterCsmsCall("invalid-json", blockedActions)).toEqual({ blocked: false });
      expect(filterCsmsCall("", blockedActions)).toEqual({ blocked: false });
    });

    it("allows all commands when blocked list is empty", () => {
      const raw = JSON.stringify([2, "req-5", "ChangeConfiguration", {}]);
      expect(filterCsmsCall(raw, [])).toEqual({ blocked: false });
    });
  });
});
