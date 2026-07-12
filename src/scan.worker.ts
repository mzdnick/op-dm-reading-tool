import { decompressLog } from "./decompress";
import { decodeDriverDebugSegment } from "./dm";
import { summarizeDriverMonitoringSegment, type SegmentScanResult } from "./scanLogic";

interface ScanWorkerRequest {
  id: number;
  segment: number;
  url: string;
}

type ScanWorkerResponse =
  | { id: number; ok: true; result: SegmentScanResult }
  | { id: number; ok: false; error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ScanWorkerRequest>) => void) | null;
  postMessage: (message: ScanWorkerResponse) => void;
};

workerScope.onmessage = (event) => {
  void scan(event.data);
};

async function scan(request: ScanWorkerRequest): Promise<void> {
  try {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error(`qlog download failed (${response.status})`);
    const compressed = new Uint8Array(await response.arrayBuffer());
    const bytes = decompressLog(compressed, request.url);
    const decoded = decodeDriverDebugSegment(bytes, request.segment);
    workerScope.postMessage({ id: request.id, ok: true, result: summarizeDriverMonitoringSegment(decoded) });
  } catch (error) {
    workerScope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
