import { describe, expect, it, vi } from "vitest";
import { proxyAthenaRequest } from "./athenaProxy";

const DONGLE_ID = "5beb9b58bd12b691";

describe("Athena upload proxy", () => {
  it("forwards only the JWT and validated upload payload to comma Athena", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: "Device offline, message queued" }));
    const request = uploadRequest();

    const response = await proxyAthenaRequest(request, DONGLE_ID, fetcher);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: "Device offline, message queued" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://athena.comma.ai/${DONGLE_ID}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "JWT test-token", "Content-Type": "application/json" },
    });
  });

  it("rejects requests without a comma JWT", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyAthenaRequest(uploadRequest({ authorization: null }), DONGLE_ID, fetcher);

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects other Athena methods and file types", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const payload = uploadPayload();
    payload.method = "reboot";
    const methodResponse = await proxyAthenaRequest(uploadRequest({ payload }), DONGLE_ID, fetcher);

    const wrongFile = uploadPayload();
    wrongFile.params.files_data[0].fn = "route--4/rlog.bz2";
    const fileResponse = await proxyAthenaRequest(uploadRequest({ payload: wrongFile }), DONGLE_ID, fetcher);

    expect(methodResponse.status).toBe(400);
    expect(fileResponse.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a controlled gateway error when Athena is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
    const response = await proxyAthenaRequest(uploadRequest(), DONGLE_ID, fetcher);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Could not reach comma Athena." });
  });

  it("returns only requested queue progress without signed URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: 0,
      jsonrpc: "2.0",
      result: [
        {
          path: "0000010a--a51155e496--4/dcamera.hevc",
          url: "https://secret-upload.example/route/4/dcamera.hevc?signed=yes",
          headers: { Authorization: "secret" },
          current: true,
          progress: 0.46,
          retry_count: 1,
          allow_cellular: false,
          priority: 0,
        },
        {
          path: "another-route--5/dcamera.hevc",
          url: "https://secret-upload.example/other?signed=yes",
          current: false,
          progress: 0.2,
        },
      ],
    }));

    const response = await proxyAthenaRequest(queueRequest(), DONGLE_ID, fetcher);
    const json = await response.json();

    expect(json).toEqual({
      id: 0,
      jsonrpc: "2.0",
      result: [{
        path: "0000010a--a51155e496--4/dcamera.hevc",
        current: true,
        progress: 0.46,
        retry_count: 1,
        allow_cellular: false,
        priority: 0,
      }],
    });
    expect(JSON.stringify(json)).not.toContain("secret-upload");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ id: 0, jsonrpc: "2.0", method: "listUploadQueue" }));
  });
});

function uploadRequest(options: { authorization?: string | null; payload?: ReturnType<typeof uploadPayload> } = {}): Request {
  const authorization = options.authorization === undefined ? "JWT test-token" : options.authorization;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization) headers.set("Authorization", authorization);
  return new Request(`https://opdm.mindflakes.com/api/athena/${DONGLE_ID}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.payload ?? uploadPayload()),
  });
}

function uploadPayload() {
  return {
    id: 0,
    jsonrpc: "2.0",
    method: "uploadFilesToUrls",
    params: {
      files_data: [{
        fn: "0000010a--a51155e496--4/dcamera.hevc",
        url: "https://upload.example/driver-video?signed=yes",
        headers: { "x-ms-blob-type": "BlockBlob" },
        allow_cellular: false,
        priority: 0,
      }],
    },
    expiry: 123456789,
  };
}

function queueRequest(): Request {
  return new Request(`https://opdm.mindflakes.com/api/athena/${DONGLE_ID}`, {
    method: "POST",
    headers: { Authorization: "JWT test-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 0,
      jsonrpc: "2.0",
      method: "listUploadQueue",
      params: { paths: ["0000010a--a51155e496--4/dcamera.hevc"] },
    }),
  });
}
