import { createFile } from "mp4box";
import type { DriverVideoFrameIndex } from "./dm";

const MAX_RANGE_BYTES = 2 * 1024 * 1024;
const HEVC_CODEC = "hvc1.1.6.L153.B0";
const TIMESCALE = 10_240;

export interface HevcSupport {
  mediaSource: boolean;
  htmlVideo: boolean;
  supported: boolean;
  codec: string;
}

export interface PlannedVideoRange {
  start: number;
  end: number;
  frames: DriverVideoFrameIndex[];
}

export function detectHevcSupport(): HevcSupport {
  const video = document.createElement("video");
  const mime = `video/mp4; codecs="${HEVC_CODEC}"`;
  const mediaSource = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
  const htmlVideo = video.canPlayType(mime) !== "";
  return { mediaSource, htmlVideo, supported: htmlVideo, codec: HEVC_CODEC };
}

export function framesForClip(frames: DriverVideoFrameIndex[], startSeconds: number, endSeconds: number): DriverVideoFrameIndex[] {
  if (frames.length === 0) return [];
  const presentation = [...frames].sort((a, b) => a.routeSeconds - b.routeSeconds);
  const targetIndex = presentation.findIndex((frame) => frame.routeSeconds >= startSeconds);
  const firstTarget = targetIndex < 0 ? presentation.length - 1 : targetIndex;
  let keyframe = firstTarget;
  while (keyframe > 0 && !presentation[keyframe].keyframe) keyframe -= 1;
  const selectedPresentation = presentation.filter((frame, index) => index >= keyframe && frame.routeSeconds < endSeconds);
  const selected = new Set(selectedPresentation.map((frame) => `${frame.segment}:${frame.presentationIndex}`));
  return frames
    .filter((frame) => selected.has(`${frame.segment}:${frame.presentationIndex}`))
    .sort((a, b) => a.encodeIndex - b.encodeIndex);
}

export function planVideoRanges(frames: DriverVideoFrameIndex[], maxBytes = MAX_RANGE_BYTES): PlannedVideoRange[] {
  const ranges: PlannedVideoRange[] = [];
  for (const frame of frames) {
    const previous = ranges.at(-1);
    const frameEnd = frame.byteOffset + frame.byteLength - 1;
    if (previous && frame.byteOffset === previous.end + 1 && frameEnd - previous.start + 1 <= maxBytes) {
      previous.end = frameEnd;
      previous.frames.push(frame);
    } else {
      ranges.push({ start: frame.byteOffset, end: frameEnd, frames: [frame] });
    }
  }
  return ranges;
}

export class DriverVideoPlayer {
  private abortController: AbortController | null = null;
  private objectUrl: string | null = null;
  playbackRouteStart = 0;

  constructor(private readonly video: HTMLVideoElement) {}

  async load(
    segmentSources: Array<{ url: string; frames: DriverVideoFrameIndex[] }>,
    startSeconds: number,
    endSeconds: number,
    onProgress: (message: string, fraction: number) => void,
  ): Promise<void> {
    this.destroy();
    this.abortController = new AbortController();
    const selected = segmentSources.map((source) => ({
      ...source,
      frames: framesForClip(source.frames, startSeconds, endSeconds),
    })).filter((source) => source.frames.length > 0);
    if (selected.length === 0) throw new Error("No indexed driver-camera frames overlap this clip.");
    this.playbackRouteStart = Math.min(...selected.flatMap((source) => source.frames.map((frame) => frame.routeSeconds)));
    const sourcePlans = selected.map((source) => {
      const allSourceFrames = segmentSources.find((candidate) => candidate.url === source.url)?.frames ?? source.frames;
      const firstSelected = source.frames[0];
      const lastSelected = source.frames.at(-1)!;
      const lookbehind = allSourceFrames.find((frame) => frame.encodeIndex === firstSelected.encodeIndex - 1);
      const lookahead = allSourceFrames.find((frame) => frame.encodeIndex === lastSelected.encodeIndex + 1);
      const downloadFrames = [
        ...(lookbehind ? [lookbehind] : []),
        ...source.frames,
        ...(lookahead ? [lookahead] : []),
      ];
      return { source, ranges: planVideoRanges(downloadFrames) };
    });
    const totalRanges = sourcePlans.reduce((sum, plan) => sum + plan.ranges.length, 0);

    let mp4: ReturnType<typeof createFile> | null = null;
    let trackId: number | null = null;
    let dts = 0;
    const samples: Array<{ data: Uint8Array<ArrayBuffer>; duration: number; keyframe: boolean; compositionOffset: number }> = [];
    let completedRanges = 0;

    for (const { source, ranges } of sourcePlans) {
      const chunks: Uint8Array[] = [];
      for (const range of ranges) {
        chunks.push(await fetchRange(source.url, range.start, range.end, this.abortController.signal));
        completedRanges += 1;
        onProgress(`Reading driver video (${completedRanges}/${totalRanges} chunks)`, completedRanges / totalRanges);
        await yieldToBrowser();
      }
      const streamNalus = splitAnnexB(concatBytes(...chunks));
      let configNalus = streamNalus;
      if (!hasHevcConfig(configNalus)) {
        const headerBytes = await fetchRange(source.url, 0, 256 * 1024 - 1, this.abortController.signal);
        configNalus = splitAnnexB(headerBytes);
      }
      if (!mp4 || trackId === null) {
          const config = buildHevcConfig(configNalus);
          const size = readHevcDimensions(config.sps);
          mp4 = createFile();
          mp4.init({ brands: ["iso6", "isom", "mp41"], timescale: TIMESCALE, duration: 0 });
          trackId = mp4.addTrack({
            type: "hvc1",
            width: size.width,
            height: size.height,
            timescale: TIMESCALE,
            duration: 0,
            media_duration: 0,
            hevcDecoderConfigRecord: config.record.buffer as ArrayBuffer,
          });
          if (!trackId) throw new Error("Could not create the HEVC MP4 track.");
      }
      const accessUnits = groupAccessUnits(streamNalus);
      const firstKeyframe = accessUnits.findIndex((unit) => unit.keyframe);
      const usableUnits = accessUnits.slice(Math.max(0, firstKeyframe), Math.max(0, firstKeyframe) + source.frames.length);
      if (usableUnits.length < source.frames.length) {
        throw new Error(`HEVC stream ended after ${usableUnits.length}/${source.frames.length} indexed frames.`);
      }
      for (let index = 0; index < usableUnits.length; index += 1) {
        const frame = source.frames[index];
        const unit = usableUnits[index];
        const sample = annexBToLengthPrefixed(unit.nalus);
        const duration = Math.max(1, Math.round(frame.durationMs * TIMESCALE / 1_000));
        samples.push({ data: sample, duration, keyframe: unit.keyframe, compositionOffset: Math.round(frame.compositionTimeOffsetMs * TIMESCALE / 1_000) });
        dts += duration;
    }
    }

    if (!mp4 || trackId === null) throw new Error("No HEVC samples were remuxed.");
    reorderMoovForCompatibility(mp4);
    const stream = mp4.getBuffer();
    const init = new Uint8Array(stream.buffer.slice(0, stream.byteLength));
    patchHvcCReservedBits(init);
    let decodeTime = 0;
    const groups = groupSamplesByKeyframe(samples);
    const fragments = groups.map((group, index) => {
      const fragment = makeFragment(trackId, index + 1, decodeTime, group);
      decodeTime += group.reduce((sum, sample) => sum + sample.duration, 0);
      return fragment;
    });
    const output = concatBytes(init, ...fragments);
    this.objectUrl = URL.createObjectURL(new Blob([output], { type: `video/mp4; codecs="${HEVC_CODEC}"` }));
    this.video.src = this.objectUrl;
    this.video.load();
  }

  destroy(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}

interface Nalu { type: number; data: Uint8Array<ArrayBuffer>; }
interface AccessUnit { nalus: Nalu[]; keyframe: boolean; }

export function splitAnnexB(bytes: Uint8Array): Nalu[] {
  const starts: Array<{ offset: number; size: number }> = [];
  for (let index = 0; index + 3 < bytes.length;) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 0 && bytes[index + 3] === 1) {
      starts.push({ offset: index, size: 4 });
      index += 4;
    } else if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      starts.push({ offset: index, size: 3 });
      index += 3;
    } else index += 1;
  }
  return starts.flatMap((start, index) => {
    const from = start.offset + start.size;
    const to = starts[index + 1]?.offset ?? bytes.length;
    if (to <= from) return [];
    const data = copyBytes(bytes.subarray(from, to));
    return [{ type: (data[0] >> 1) & 0x3f, data }];
  });
}

function buildHevcConfig(nalus: Nalu[]): { record: Uint8Array<ArrayBuffer>; sps: Uint8Array<ArrayBuffer> } {
  const vps = nalus.find((nalu) => nalu.type === 32)?.data;
  const sps = nalus.find((nalu) => nalu.type === 33)?.data;
  const rawPps = nalus.find((nalu) => nalu.type === 34)?.data;
  if (!vps || !sps || !rawPps || sps.length < 15) throw new Error("The first keyframe is missing HEVC VPS/SPS/PPS configuration.");
  const pps = rawPps.at(-1) === 0 ? rawPps : concatBytes(rawPps, new Uint8Array([0]));
  const profile = removeEmulationPrevention(sps.slice(2));
  const header = new Uint8Array([
    1, profile[1], ...profile.slice(2, 6), ...profile.slice(6, 12), profile[12],
    0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 3,
  ]);
  return { record: concatBytes(header, hevcArray(32, vps), hevcArray(33, sps), hevcArray(34, pps)), sps };
}

function hasHevcConfig(nalus: Nalu[]): boolean {
  return [32, 33, 34].every((type) => nalus.some((nalu) => nalu.type === type));
}

function groupAccessUnits(nalus: Nalu[]): AccessUnit[] {
  const units: AccessUnit[] = [];
  let current: Nalu[] = [];
  let hasVcl = false;
  for (const nalu of nalus) {
    const isVcl = nalu.type <= 31;
    const firstSlice = isVcl && nalu.data.length > 2 && (nalu.data[2] & 0x80) !== 0;
    if (firstSlice && hasVcl) {
      units.push({ nalus: current, keyframe: current.some((item) => item.type >= 16 && item.type <= 21) });
      current = [];
      hasVcl = false;
    }
    current.push(nalu);
    hasVcl ||= isVcl;
  }
  if (hasVcl) units.push({ nalus: current, keyframe: current.some((item) => item.type >= 16 && item.type <= 21) });
  return units;
}

function hevcArray(type: number, nalu: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array([0x80 | type, 0, 1, (nalu.length >>> 8) & 0xff, nalu.length & 0xff]);
  return concatBytes(header, nalu);
}

function annexBToLengthPrefixed(nalus: Nalu[]): Uint8Array<ArrayBuffer> {
  const sampleNalus = nalus.filter((nalu) => nalu.type !== 32 && nalu.type !== 33 && nalu.type !== 34 && nalu.type !== 35);
  const parts = sampleNalus.flatMap((nalu) => {
    const length = nalu.data.length;
    return [new Uint8Array([(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]), nalu.data];
  });
  return concatBytes(...parts);
}

function readHevcDimensions(spsNalu: Uint8Array): { width: number; height: number } {
  const rbsp = removeEmulationPrevention(spsNalu.slice(2));
  const bits = new BitReader(rbsp);
  bits.skip(4);
  const maxSubLayersMinus1 = bits.read(3);
  bits.skip(1 + 2 + 1 + 5 + 32 + 48 + 8);
  const profileFlags: boolean[] = [];
  const levelFlags: boolean[] = [];
  for (let index = 0; index < maxSubLayersMinus1; index += 1) {
    profileFlags.push(Boolean(bits.read(1)));
    levelFlags.push(Boolean(bits.read(1)));
  }
  if (maxSubLayersMinus1 > 0) bits.skip((8 - maxSubLayersMinus1) * 2);
  for (let index = 0; index < maxSubLayersMinus1; index += 1) {
    if (profileFlags[index]) bits.skip(88);
    if (levelFlags[index]) bits.skip(8);
  }
  bits.ue();
  const chromaFormat = bits.ue();
  if (chromaFormat === 3) bits.skip(1);
  let width = bits.ue();
  let height = bits.ue();
  if (bits.read(1)) {
    const left = bits.ue(); const right = bits.ue(); const top = bits.ue(); const bottom = bits.ue();
    const subWidth = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
    const subHeight = chromaFormat === 1 ? 2 : 1;
    width -= subWidth * (left + right);
    height -= subHeight * (top + bottom);
  }
  if (!width || !height) throw new Error("Could not read HEVC dimensions from SPS.");
  return { width, height };
}

class BitReader {
  private position = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number { let value = 0; for (let index = 0; index < count; index += 1) value = value * 2 + this.readBit(); return value; }
  skip(count: number): void { this.position += count; }
  ue(): number { let zeros = 0; while (this.readBit() === 0 && zeros < 31) zeros += 1; return (2 ** zeros - 1) + (zeros ? this.read(zeros) : 0); }
  private readBit(): number { const value = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1; this.position += 1; return value; }
}

function removeEmulationPrevention(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const output: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (index >= 2 && bytes[index] === 3 && bytes[index - 1] === 0 && bytes[index - 2] === 0) continue;
    output.push(bytes[index]);
  }
  return new Uint8Array(output);
}

function patchHvcCReservedBits(bytes: Uint8Array): void {
  for (let index = 4; index + 18 < bytes.length; index += 1) {
    if (bytes[index] === 0x68 && bytes[index + 1] === 0x76 && bytes[index + 2] === 0x63 && bytes[index + 3] === 0x43) {
      // MP4Box.js 2.4.1 writes min_spatial_segmentation_idc without the six
      // required reserved one bits. VideoToolbox rejects that hvcC record.
      bytes[index + 4 + 13] |= 0xf0;
      return;
    }
  }
}

function reorderMoovForCompatibility(file: ReturnType<typeof createFile>): void {
  const moov = (file as unknown as { moov?: { boxes?: Array<{ type: string }> } }).moov;
  if (!moov?.boxes) return;
  const rank: Record<string, number> = { mvhd: 0, trak: 1, mvex: 2 };
  moov.boxes.sort((a, b) => (rank[a.type] ?? 1) - (rank[b.type] ?? 1));
}

function makeFragment(
  trackId: number,
  sequence: number,
  decodeTime: number,
  samples: Array<{ data: Uint8Array<ArrayBuffer>; duration: number; keyframe: boolean; compositionOffset: number }>,
): Uint8Array<ArrayBuffer> {
  const first = samples[0];
  const defaultFlags = 0x01010000;
  const firstSampleFlags = first.keyframe ? 0x02000000 : defaultFlags;
  const uniformDuration = samples.every((sample) => sample.duration === first.duration);
  const hasCompositionOffset = samples.some((sample) => sample.compositionOffset !== 0);
  const tfhd = fullBox("tfhd", 0, 0x020038, concatBytes(
    uint32(trackId), uint32(first.duration), uint32(first.data.byteLength), uint32(defaultFlags),
  ));
  const tfdt = fullBox("tfdt", 1, 0, uint64(BigInt(decodeTime)));
  const trunFlags = 0x000205 | (uniformDuration ? 0 : 0x000100) | (hasCompositionOffset ? 0x000800 : 0);
  const sampleFields = samples.flatMap((sample) => [
    ...(uniformDuration ? [] : [uint32(sample.duration)]),
    uint32(sample.data.byteLength),
    ...(hasCompositionOffset ? [uint32(sample.compositionOffset)] : []),
  ]);
  const trunPayload = concatBytes(
    uint32(samples.length),
    uint32(0), // patched to moof size + mdat header below
    uint32(firstSampleFlags),
    ...sampleFields,
  );
  let trun = fullBox("trun", samples.some((sample) => sample.compositionOffset < 0) ? 1 : 0, trunFlags, trunPayload);
  const traf = box("traf", concatBytes(tfhd, tfdt, trun));
  let moof = box("moof", concatBytes(fullBox("mfhd", 0, 0, uint32(sequence)), traf));
  const dataOffset = moof.byteLength + 8;
  trunPayload.set(uint32(dataOffset), 4);
  trun = fullBox("trun", samples.some((sample) => sample.compositionOffset < 0) ? 1 : 0, trunFlags, trunPayload);
  moof = box("moof", concatBytes(fullBox("mfhd", 0, 0, uint32(sequence)), box("traf", concatBytes(tfhd, tfdt, trun))));
  return concatBytes(moof, box("mdat", concatBytes(...samples.map((sample) => sample.data))));
}

function groupSamplesByKeyframe<T extends { keyframe: boolean }>(samples: T[]): T[][] {
  const groups: T[][] = [];
  for (const sample of samples) {
    if (sample.keyframe || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(sample);
  }
  return groups;
}

function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(uint32(payload.byteLength + 8), new TextEncoder().encode(type), payload);
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return box(type, concatBytes(new Uint8Array([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), payload));
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function uint64(value: bigint): Uint8Array<ArrayBuffer> {
  return concatBytes(uint32(Number((value >> 32n) & 0xffffffffn)), uint32(Number(value & 0xffffffffn)));
}

async function fetchRange(url: string, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (!response.ok) throw new Error(`Could not fetch driver video bytes (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = end - start + 1;
  if (response.status === 200 && bytes.byteLength >= end + 1) return bytes.slice(start, end + 1);
  if (bytes.byteLength < expected) throw new Error(`Driver video range was truncated (${bytes.byteLength}/${expected} bytes).`);
  return bytes.subarray(0, expected);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> { return new Uint8Array(bytes); }
function yieldToBrowser(): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, 0)); }
