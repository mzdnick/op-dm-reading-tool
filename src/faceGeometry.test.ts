import { describe, expect, it } from "vitest";
import { parseFaceRendererMode, projectFaceAnchor, resolveDriverCameraProfile } from "./faceGeometry";

describe("driver face geometry", () => {
  it("selects mici from logged device type or OS04C10 stream dimensions", () => {
    expect(resolveDriverCameraProfile("mici", null)).toEqual({ name: "mici", anchorScale: 1.25 });
    expect(resolveDriverCameraProfile(null, { width: 1344, height: 760 })).toEqual({ name: "mici", anchorScale: 1.25 });
    expect(resolveDriverCameraProfile("tici", { width: 1344, height: 760 })).toEqual({ name: "mici", anchorScale: 1.25 });
    expect(resolveDriverCameraProfile("tici", { width: 1928, height: 1208 })).toEqual({ name: "tici", anchorScale: 1 });
  });

  it("projects the reported failing frame with the mici transform", () => {
    const profile = resolveDriverCameraProfile("mici", { width: 1344, height: 760 });
    const stock = projectFaceAnchor([0.1033976972, 0.0658624992], profile, [-0.0546351671, -0.823759973], "dm-0.10.3");
    const newer = projectFaceAnchor([0.1033976972, 0.0658624992], profile, [-0.0546351671, -0.823759973], "dm-0.11.1");
    expect(stock?.centerXPercent).toBeCloseTo(60.26, 1);
    expect(stock?.centerYPercent).toBeCloseTo(40.16, 1);
    expect(newer?.centerXPercent).toBeCloseTo(55.73, 1);
    expect(newer?.centerYPercent).toBeCloseTo(39.94, 1);
  });

  it("keeps the 299-second comparison distinct between compatibility modes", () => {
    const profile = resolveDriverCameraProfile("mici", { width: 1344, height: 760 });
    const position = [0.1339096725, 0.0549280122];
    const orientation = [0.0003407001, 0.3430024981, -0.0429623127];
    const stock = projectFaceAnchor(position, profile, orientation, "dm-0.10.3");
    const newer = projectFaceAnchor(position, profile, orientation, "dm-0.11.1");
    expect(stock?.centerXPercent).toBeCloseTo(63.28, 1);
    expect(stock?.centerYPercent).toBeCloseTo(38.99, 1);
    expect(newer?.centerXPercent).toBeCloseTo(65.17, 1);
    expect(newer?.centerYPercent).toBeCloseTo(38.99, 1);
  });

  it("keeps 0.10.3 position-only and makes newer pose bias explicit", () => {
    const profile = resolveDriverCameraProfile("tici", null);
    const stock = projectFaceAnchor([0, 0], profile, [0.1, 0.5], "dm-0.10.3");
    const newer = projectFaceAnchor([0, 0], profile, [0.1, 0.5], "dm-0.11.1");
    expect(stock).toEqual({ centerXPercent: 50, centerYPercent: 34.166666666666664 });
    expect(newer).toEqual({ centerXPercent: 52.25, centerYPercent: 34.56666666666666 });
    expect(projectFaceAnchor([Number.NaN, 0], profile)).toBeNull();
  });

  it("parses shareable renderer overrides safely", () => {
    expect(parseFaceRendererMode("dm-0.10.3")).toBe("dm-0.10.3");
    expect(parseFaceRendererMode("dm-0.11.1")).toBe("dm-0.11.1");
    expect(parseFaceRendererMode("fork-magic")).toBe("auto");
  });
});
