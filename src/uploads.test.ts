import { describe, expect, it, vi } from "vitest";
import { buildDriverVideoUploadRequest, queueDriverVideoUpload, watchDriverVideoUpload } from "./uploads";

describe("driver-video upload recovery", () => {
  it("builds dcamera paths only for the missing clip segments", () => {
    expect(buildDriverVideoUploadRequest("abc123|00000054--route", [2, 1, 2])).toEqual({
      dongleId: "abc123",
      routeName: "abc123|00000054--route",
      segments: [1, 2],
      paths: ["00000054--route--1/dcamera.hevc", "00000054--route--2/dcamera.hevc"],
    });
  });

  it("requests destinations and queues a Wi-Fi upload through Athena", async () => {
    const request = buildDriverVideoUploadRequest("abc123|route", [3]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ url: "https://upload.test/route/3/dcamera.hevc?signed" }]))
      .mockResolvedValueOnce(Response.json({ result: "Device offline, message queued" }));

    await expect(queueDriverVideoUpload(request, fetcher)).resolves.toContain("waiting for the device");
    const athenaBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(athenaBody).toMatchObject({
      method: "uploadFilesToUrls",
      params: { files_data: [{ fn: "route--3/dcamera.hevc", allow_cellular: false, priority: 0 }] },
    });
  });

  it("watches route files until every requested dcamera segment appears", async () => {
    const request = buildDriverVideoUploadRequest("abc123|route", [3, 4]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ dcameras: ["https://files.test/abc/route/3/dcamera.hevc"] }))
      .mockResolvedValueOnce(Response.json({ dcameras: [
        "https://files.test/abc/route/3/dcamera.hevc",
        "https://files.test/abc/route/4/dcamera.hevc",
      ] }));
    const updates: string[] = [];
    const pause = vi.fn(async () => {});

    await watchDriverVideoUpload(request, (update) => updates.push(update.message), new AbortController().signal, {
      fetcher,
      pause,
      maxPolls: 2,
    });

    expect(updates).toEqual(["Driver video uploaded (1/2 segments)"]);
    expect(pause).toHaveBeenCalledOnce();
  });

  it("explains when driver-camera recording was not found on the device", async () => {
    const request = buildDriverVideoUploadRequest("abc123|route", [3]);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([{ url: "https://upload.test/signed" }]))
      .mockResolvedValueOnce(Response.json({ result: { failed: ["route--3/dcamera.hevc"] } }));

    await expect(queueDriverVideoUpload(request, fetcher)).rejects.toThrow("Recording was probably not enabled");
  });
});
