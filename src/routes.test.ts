import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBackendForTesting } from "./backend";
import { logSourceLabel, orderedLogUrls, parseRouteInput, segmentFromUrl } from "./routes";
import { buildAuthCallbackCleanUrl, buildRouteShareUrl, buildRouteTimeUrl, routeInputFromUrl, routeTimeFromUrl } from "./routeInput";

describe("route parsing", () => {
  it("accepts route names", () => {
    expect(parseRouteInput("5beb9b58bd12b691|0000010a--a51155e496")).toMatchObject({
      routeName: "5beb9b58bd12b691|0000010a--a51155e496",
      dongleId: "5beb9b58bd12b691",
      routeId: "0000010a--a51155e496",
    });
  });

  it("accepts comma Connect URLs", () => {
    expect(parseRouteInput("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496")).toMatchObject({
      routeName: "5beb9b58bd12b691|0000010a--a51155e496",
      source: "connect-url",
    });
  });

  it("preserves clip times from comma Connect URLs", () => {
    expect(parseRouteInput("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496/90/105")).toMatchObject({
      routeName: "5beb9b58bd12b691|0000010a--a51155e496",
      source: "connect-url",
      startSeconds: 90,
      endSeconds: 105,
      explicitClipRange: true,
    });
  });

  it("distinguishes bare routes from explicit clips", () => {
    expect(parseRouteInput("5beb9b58bd12b691|0000010a--a51155e496").explicitClipRange).toBe(false);
    expect(parseRouteInput("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496").explicitClipRange).toBe(false);
    expect(parseRouteInput("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496/10/20").explicitClipRange).toBe(true);
  });

  it("extracts segment numbers from signed log URLs", () => {
    expect(segmentFromUrl("https://example.test/dongle/route/12/qlog.zst?sig=abc")).toBe(12);
    expect(segmentFromUrl("https://example.test/dongle/route/7/rlog.bz2")).toBe(7);
    expect(segmentFromUrl("https://example.test/dongle/route/1/qcamera.ts?sig=abc")).toBe(1);
  });

  it("prefers qlogs by default and rlogs for high-resolution telemetry", () => {
    const files = {
      qlogs: ["https://example.test/dongle/route/0/qlog.zst"],
      logs: ["https://example.test/dongle/route/0/rlog.zst"],
    };
    expect(logSourceLabel(files)).toBe("qlogs");
    expect(orderedLogUrls(files)[0]).toContain("qlog.zst");
    expect(logSourceLabel(files, true)).toBe("rlogs");
    expect(orderedLogUrls(files, true)[0]).toContain("rlog.zst");
  });

  it("falls back to qlogs when high-resolution telemetry is unavailable", () => {
    const files = { qlogs: ["https://example.test/dongle/route/0/qlog.zst"] };
    expect(logSourceLabel(files, true)).toBe("qlogs");
    expect(orderedLogUrls(files, true)[0]).toContain("qlog.zst");
  });

  it("builds share URLs on the configured app base path", () => {
    expect(buildRouteShareUrl("https://example.test", "/op-dm-reading-tool/", "5beb9b58bd12b691|0000010a--a51155e496")).toBe(
      "https://example.test/op-dm-reading-tool/?route=5beb9b58bd12b691%7C0000010a--a51155e496",
    );
  });

  it("preserves Connect clip URLs in share URLs", () => {
    const shareUrl = buildRouteShareUrl(
      "https://example.test",
      "/",
      "https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496/90/105",
    );

    expect(routeInputFromUrl(shareUrl)).toBe("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496/90/105");
  });

  it("ignores empty and invalid route query params", () => {
    expect(routeInputFromUrl("https://example.test/?route=%20")).toBeNull();
    expect(routeInputFromUrl("https://example.test/?route=not-a-route")).toBeNull();
  });

  it("parses non-negative deep-link route times", () => {
    expect(routeTimeFromUrl("https://example.test/?t=270")).toBe(270);
    expect(routeTimeFromUrl("https://example.test/?t=270.5")).toBe(270.5);
    expect(routeTimeFromUrl("https://example.test/?t=-1")).toBeNull();
    expect(routeTimeFromUrl("https://example.test/?t=nope")).toBeNull();
    expect(routeTimeFromUrl("https://example.test/")).toBeNull();
  });

  it("updates route time without losing the route or hash", () => {
    expect(buildRouteTimeUrl("https://example.test/?route=demo#how-to-use", 270.8)).toBe(
      "https://example.test/?route=demo&t=270#how-to-use",
    );
  });

  it("preserves route params when cleaning OAuth callback URLs", () => {
    expect(
      buildAuthCallbackCleanUrl(
        "https://example.test/op-dm-reading-tool/?code=abc&provider=g&route=5beb9b58bd12b691%7C0000010a--a51155e496&t=270.9",
        "/op-dm-reading-tool/",
      ),
    ).toBe("https://example.test/op-dm-reading-tool/?route=5beb9b58bd12b691%7C0000010a--a51155e496&t=270");
  });
});

describe("clone frontend URL parsing", () => {
  beforeEach(() => {
    resetBackendForTesting();
    vi.stubGlobal("window", {
      location: {
        href: "https://opdm.example.com/?backend=konik",
        origin: "https://opdm.example.com",
        protocol: "https:",
        host: "opdm.example.com",
        hostname: "opdm.example.com",
        search: "?backend=konik",
      },
    });
  });

  afterEach(() => {
    resetBackendForTesting();
    vi.unstubAllGlobals();
  });

  it("accepts Konik Stable clip URLs when the konik backend is active", () => {
    expect(parseRouteInput("https://stable.konik.ai/5beb9b58bd12b691/0000010a--a51155e496")).toMatchObject({
      routeName: "5beb9b58bd12b691|0000010a--a51155e496",
      dongleId: "5beb9b58bd12b691",
      source: "connect-url",
    });
  });

  it("preserves clip times from Konik Stable URLs", () => {
    expect(parseRouteInput("https://stable.konik.ai/5beb9b58bd12b691/0000010a--a51155e496/90/105")).toMatchObject({
      startSeconds: 90,
      endSeconds: 105,
      explicitClipRange: true,
    });
  });

  it("still accepts comma Connect URLs even when a clone backend is active", () => {
    expect(parseRouteInput("https://connect.comma.ai/5beb9b58bd12b691/0000010a--a51155e496")).toMatchObject({
      source: "connect-url",
      dongleId: "5beb9b58bd12b691",
    });
  });

  it("still accepts bare route names when a clone backend is active", () => {
    expect(parseRouteInput("5beb9b58bd12b691|0000010a--a51155e496")).toMatchObject({
      dongleId: "5beb9b58bd12b691",
      source: "route",
    });
  });
});
