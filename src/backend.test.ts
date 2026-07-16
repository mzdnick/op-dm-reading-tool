import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBackend, resetBackendForTesting } from "./backend";

describe("backend resolution", () => {
  beforeEach(() => {
    resetBackendForTesting();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetBackendForTesting();
    vi.unstubAllGlobals();
  });

  it("defaults to the comma backend", () => {
    stubLocation("https://opdm.example.com/");
    expect(getBackend().id).toBe("comma");
    expect(getBackend().apiBaseUrl).toBe("https://api.comma.ai");
  });

  it("selects a built-in backend from ?backend=", () => {
    stubLocation("https://opdm.example.com/?backend=konik");
    const backend = getBackend();
    expect(backend.id).toBe("konik");
    expect(backend.apiBaseUrl).toBe("https://api.konik.ai");
    expect(backend.athenaBaseUrl).toBe("https://api.konik.ai/ws");
    expect(backend.authMethod).toBe("jwt");
  });

  it("honors window.OPDM_BACKEND set by config.js", () => {
    stubLocation("https://opdm.example.com/", { backend: "konik" });
    expect(getBackend().id).toBe("konik");
  });

  it("?backend= overrides window.OPDM_BACKEND", () => {
    stubLocation("https://opdm.example.com/?backend=comma", { backend: "konik" });
    expect(getBackend().id).toBe("comma");
  });

  it("derives a custom backend from ?api= with jwt auth", () => {
    stubLocation("https://opdm.example.com/?api=https://api.myfork.dev");
    const backend = getBackend();
    expect(backend.id).toBe("api.myfork.dev");
    expect(backend.apiBaseUrl).toBe("https://api.myfork.dev");
    expect(backend.athenaBaseUrl).toBe("https://api.myfork.dev/ws");
    expect(backend.authMethod).toBe("jwt");
    expect(backend.uploadAuth.header).toBe("Authorization");
  });

  it("?api= overrides a window.OPDM_BACKEND deploy default", () => {
    // config.js ships a comma default, but ?api= must still win per-visit.
    stubLocation("https://opdm.example.com/?api=https://api.myfork.dev", { backend: "comma" });
    expect(getBackend().apiBaseUrl).toBe("https://api.myfork.dev");
  });

  it("lets ?athena= override the derived Athena origin", () => {
    stubLocation("https://opdm.example.com/?api=https://api.myfork.dev&athena=https://athena.myfork.dev");
    expect(getBackend().athenaBaseUrl).toBe("https://athena.myfork.dev");
  });

  it("falls back to comma for an unknown ?backend= id", () => {
    stubLocation("https://opdm.example.com/?backend=nonexistent");
    expect(getBackend().id).toBe("comma");
  });
});

function stubLocation(href: string, opdmBackend?: { backend?: string; api?: string; athena?: string }): void {
  const url = new URL(href);
  vi.stubGlobal("window", {
    OPDM_BACKEND: opdmBackend,
    location: {
      href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      search: url.search,
    },
  });
}
