import { describe, expect, it } from "vitest";
import { formatModelProvenance, modelProvenanceDetails, resolveDmModelProvenance } from "./modelProvenance";

describe("DM model provenance", () => {
  it("uses the tinygrad artifact history for current openpilot routes", async () => {
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json([{
        sha: "70e157462304e5ce7d03ffbec6cb7f45bf347bb7",
        commit: { committer: { date: "2026-06-05T12:00:00Z" }, message: "openpilot v0.11.1\n\nrelease" },
      }]);
    }) as typeof fetch;

    const result = await resolveDmModelProvenance({
      fullname: "route",
      version: "0.11.1",
      git_commit: "70e157462304e5ce7d03ffbec6cb7f45bf347bb7",
      git_branch: "release-tizi-staging",
      start_time: "2026-06-15T01:20:08Z",
    }, fetcher);

    expect(requested[0]).toContain("dmonitoring_model_tinygrad.pkl.chunk01of01");
    expect(result).toMatchObject({ source: "github", artifactDate: "2026-06-05T12:00:00Z" });
    expect(formatModelProvenance(result)).toBe("DM artifact last changed Jun 5, 2026 · drive recorded Jun 15, 2026 · openpilot 0.11.1");
    expect(modelProvenanceDetails(result)).toContain("openpilot v0.11.1");
  });

  it("checks the ONNX artifact first for earlier routes", async () => {
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return Response.json([{
        sha: "e946e90000000000000000000000000000000000",
        commit: { author: { date: "2026-02-10T00:00:00Z" }, message: "Update DM model" },
      }]);
    }) as typeof fetch;

    const result = await resolveDmModelProvenance({
      fullname: "route",
      version: "0.10.4",
      git_commit: "e946e90000000000000000000000000000000001",
    }, fetcher);

    expect(requested[0]).toContain("dmonitoring_model.onnx");
    expect(result.artifactPath).toBe("selfdrive/modeld/models/dmonitoring_model.onnx");
  });

  it("falls back to route metadata when artifact history cannot be resolved", async () => {
    const fetcher = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await resolveDmModelProvenance({
      fullname: "fork-route",
      version: "fork-build",
      git_commit: "private00000000000000000000000000000000000",
      start_time: "2025-08-09T10:00:00Z",
    }, fetcher);

    expect(result.source).toBe("route");
    expect(formatModelProvenance(result)).toBe("DM artifact history unavailable · drive recorded Aug 9, 2025 · openpilot fork-build");
  });
});
