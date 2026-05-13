import bz2 from "bz2";
import { decompress as zstdDecompress } from "fzstd";

export function decompressLog(bytes: Uint8Array, fileNameOrUrl: string): Uint8Array {
  const path = fileNameOrUrl.split("?", 1)[0].toLowerCase();
  if (path.endsWith(".zst") || hasZstdMagic(bytes)) {
    return zstdDecompress(bytes);
  }
  if (path.endsWith(".bz2") || hasBzip2Magic(bytes)) {
    return bz2.decompress(bytes);
  }
  return bytes;
}

function hasZstdMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

function hasBzip2Magic(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68;
}
