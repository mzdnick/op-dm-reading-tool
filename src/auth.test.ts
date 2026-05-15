import { beforeEach, describe, expect, it, vi } from "vitest";
import { authHeaders, getAccessToken, setAccessToken, signOut } from "./auth";

describe("comma auth token storage", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
  });

  it("stores comma JWTs without a duplicated JWT prefix", () => {
    setAccessToken("JWT test-token");

    expect(getAccessToken()).toBe("test-token");
    expect(authHeaders()).toEqual({ Authorization: "JWT test-token" });
  });

  it("removes blank tokens", () => {
    setAccessToken("test-token");
    setAccessToken(" ");

    expect(getAccessToken()).toBeNull();
    expect(authHeaders()).toEqual({});
  });

  it("signs out", () => {
    setAccessToken("test-token");
    signOut();

    expect(getAccessToken()).toBeNull();
  });
});
