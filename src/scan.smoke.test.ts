import { describe, expect, it } from "vitest";
import { scanRouteForCalibration } from "./scan";

describe("demo route smoke", () => {
  it(
    "finds an early calibrated message",
    async () => {
      const result = await scanRouteForCalibration("5beb9b58bd12b691|0000010a--a51155e496", () => {});
      expect(result.message.statusName).toBe("calibrated");
      expect(result.message.rpyCalib).toHaveLength(3);
    },
    60_000,
  );
});
