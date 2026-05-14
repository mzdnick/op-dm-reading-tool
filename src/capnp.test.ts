import { describe, expect, it } from "vitest";
import { findDeviceType } from "./capnp";

describe("Cap'n Proto log parsing", () => {
  it("reads the stable initData deviceType field", () => {
    expect(findDeviceType(minimalInitDataMessage(7))).toBe("mici");
    expect(findDeviceType(minimalInitDataMessage(4))).toBe("tici");
  });
});

function minimalInitDataMessage(deviceType: number): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(4, 5, true);

  const segmentOffset = 8;
  writeStructPointer(view, segmentOffset, 0, 2, 1);
  view.setUint16(segmentOffset + 16, 0, true);

  writeStructPointer(view, segmentOffset + 24, 0, 1, 0);
  view.setUint16(segmentOffset + 32, deviceType, true);
  return bytes;
}

function writeStructPointer(view: DataView, offset: number, offsetWords: number, dataWords: number, pointerCount: number): void {
  const raw = (BigInt(offsetWords) << 2n) | (BigInt(dataWords) << 32n) | (BigInt(pointerCount) << 48n);
  view.setBigUint64(offset, raw, true);
}
