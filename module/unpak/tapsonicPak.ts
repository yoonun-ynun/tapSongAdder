/**
 * TAPSONIC .pak decrypt/unpack and encrypt/repack library for Browser & Node.js.
 * Accepts Web standard `File` objects directly (pakFile / inputFiles + external table.key File).
 * Static tables (SHAKE_TABLE, MASK1_TABLE, VCMF_TABLE) are embedded via packTables.ts.
 */

import { unzlibSync, zlibSync } from "fflate";
import { lzo1xCompress, lzo1xDecompress } from "./lzo1x.ts";
import { MASK1_TABLE, SHAKE_TABLE, VCMF_TABLE } from "./packTables.ts";

const FULL_CRYPT_EXTS = new Set(["txt", "ini", "crc", "csv", "xml", "prv"]);
const GLOBAL_HEADER_OFFSET = 0x1e;
const GLOBAL_HEADER_SIZE = 13;
const ENTRY_HEADER_SIZE = 0x94;
const DEFAULT_DATA_OFFSET = 0x5c;
const DEFAULT_CHUNK_SIZE = 0x50000; // 320 KB
const MAX_COMPRESSED_CHUNK = 0xa0019;

interface TextCodecLike {
  encode(input: string): Uint8Array;
  decode(input: Uint8Array): string;
}

function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + (((cp & 0x3ff) << 10) | (next & 0x3ff));
        i++;
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let out = "";
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0 && i < bytes.length) {
      const b1 = bytes[i++];
      out += (b1 & 0xc0) === 0x80 && b0 >= 0xc2 ? String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f)) : "\ufffd";
    } else if ((b0 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      out +=
        (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && cp >= 0x800 && (cp < 0xd800 || cp > 0xdfff)
          ? String.fromCharCode(cp)
          : "\ufffd";
    } else if ((b0 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if ((b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80 && cp >= 0x10000 && cp <= 0x10ffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff));
      } else {
        out += "\ufffd";
      }
    } else {
      out += "\ufffd";
    }
  }
  return out;
}

const g = globalThis as unknown as {
  TextDecoder?: new (label?: string) => Pick<TextCodecLike, "decode">;
  TextEncoder?: new () => Pick<TextCodecLike, "encode">;
  crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array };
};

const textDecoder: Pick<TextCodecLike, "decode"> = g.TextDecoder ? new g.TextDecoder("utf-8") : { decode: utf8Decode };
const textEncoder: Pick<TextCodecLike, "encode"> = g.TextEncoder ? new g.TextEncoder() : { encode: utf8Encode };

export interface PakHeader {
  dataOffset: number;
  version: number;
  reserved: number;
  count: number;
  seed: number;
  compressed: boolean;
  checksum: number;
}

export interface PakEntryInfo {
  index: number;
  name: string;
  hash64: bigint;
  storedSize: number;
  uncompressedSize: number;
  unknown: number;
  headerOffset: number;
  dataOffset: number;
}

export interface UnpackedEntry {
  info: PakEntryInfo;
  data: Uint8Array;
  file: File;
}

export interface UnpackOptions {
  decodeVce?: boolean;
  decodeTrackData?: boolean;
  onProgress?: (current: number, total: number, name: string) => void;
}

export type PackInputEntry = File | { path: string; file: File };

export interface PackOptions {
  outputName?: string;
  compress?: boolean;
  encodeVce?: boolean;
  encodeTrackData?: boolean;
  headerOffset?: number;
  seed?: number;
  chunkSize?: number;
  onProgress?: (current: number, total: number, name: string) => void;
}

// Standard IEEE 802.3 CRC32 table
const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  const fileWithArrayBuffer = file as File & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof fileWithArrayBuffer.arrayBuffer === "function") {
    return new Uint8Array(await fileWithArrayBuffer.arrayBuffer());
  }
  if (typeof Response !== "undefined") {
    return new Uint8Array(await new Response(file).arrayBuffer());
  }
  throw new Error("현재 환경에서 File 바이트를 읽을 수 없습니다.");
}

function isFileLike(value: unknown): value is File {
  if (typeof File !== "undefined" && value instanceof File) {
    return true;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function createMemoryBlob(bytes: Uint8Array, type = ""): Blob {
  return {
    size: bytes.byteLength,
    type,
    async arrayBuffer(): Promise<ArrayBuffer> {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    },
    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy;
    },
    async text(): Promise<string> {
      return textDecoder.decode(bytes);
    },
    slice(start?: number, end?: number, contentType?: string): Blob {
      return createMemoryBlob(bytes.subarray(start, end), contentType ?? "");
    },
  } as unknown as Blob;
}

function createFileObject(bytes: Uint8Array, name: string, type = "application/octet-stream"): File {
  const copy = new Uint8Array(bytes);
  const lastModified = Date.now();
  if (typeof File !== "undefined") {
    try {
      const nativeFile = new File([copy], name, { type, lastModified });
      if (typeof (nativeFile as File & { arrayBuffer?: unknown }).arrayBuffer === "function") {
        return nativeFile;
      }
    } catch {
      // React Native Blob/File는 ArrayBuffer/ArrayBufferView 생성자를 지원하지 않으므로 메모리 폴백 사용
    }
  }
  return Object.assign(createMemoryBlob(copy, type), {
    name,
    lastModified,
    webkitRelativePath: "",
  }) as unknown as File;
}

function isPlainJsonBytes(data: Uint8Array): boolean {
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b; // '{'
  }
  return false;
}

async function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  return unzlibSync(data);
}

async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  return zlibSync(data);
}

/**
 * Decompress zlib-compressed `trackData.dat` bytes into UTF-8 JSON bytes.
 */
export async function decodeTrackDataBytes(data: Uint8Array, pretty = true): Promise<Uint8Array> {
  const rawJson = isPlainJsonBytes(data) ? data : await zlibDecompress(data);
  if (!pretty) return rawJson;
  const parsed: unknown = JSON.parse(textDecoder.decode(rawJson));
  return textEncoder.encode(JSON.stringify(parsed, null, 2));
}

/**
 * Compress plain UTF-8 JSON bytes back into a zlib-compressed `trackData.dat` buffer.
 */
export async function encodeTrackDataBytes(data: Uint8Array): Promise<Uint8Array> {
  if (isPlainJsonBytes(data)) {
    const parsed: unknown = JSON.parse(textDecoder.decode(data));
    const compact = textEncoder.encode(JSON.stringify(parsed));
    return zlibCompress(compact);
  }
  return data;
}

/**
 * Decompress a `trackData.dat` `File` object into parsed JSON, formatted text, and a `.json` `File`.
 */
export async function decodeTrackData(
  trackDataFile: File,
): Promise<{ data: unknown; text: string; file: File }> {
  const raw = await readFileBytes(trackDataFile);
  const jsonBytes = await decodeTrackDataBytes(raw, true);
  const text = textDecoder.decode(jsonBytes);
  const data: unknown = JSON.parse(text);
  const outName = trackDataFile.name.replace(/\.dat$/i, "") + ".json";
  const file = createFileObject(jsonBytes, outName, "application/json");
  return { data, text, file };
}

/**
 * Compress a JSON `File`, string, or object into a zlib-compressed `trackData.dat` `File`.
 */
export async function encodeTrackData(
  input: File | string | object,
  fileName = "trackData.dat",
): Promise<File> {
  let rawBytes: Uint8Array;
  if (isFileLike(input)) {
    rawBytes = await readFileBytes(input);
  } else if (typeof input === "string") {
    rawBytes = textEncoder.encode(input);
  } else {
    rawBytes = textEncoder.encode(JSON.stringify(input));
  }
  const compressed = await encodeTrackDataBytes(rawBytes);
  return createFileObject(compressed, fileName, "application/octet-stream");
}

/**
 * Load and validate a 128-byte `table.key` File object.
 */
export async function loadTableKey(tableKeyFile: File): Promise<Uint8Array> {
  const bytes = await readFileBytes(tableKeyFile);
  if (bytes.length < 128) {
    throw new Error(`table.key 크기가 128바이트 미만입니다 (${bytes.length} bytes).`);
  }
  return bytes.subarray(0, 128);
}

export function shakeTransform(data: Uint8Array, encrypt: boolean): Uint8Array {
  const out = new Uint8Array(data);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let idx = out.length & 0xff;
  const wordCount = out.length >> 2;
  for (let i = 0; i < wordCount; i++) {
    const v = view.getUint32(i * 4, true);
    const next = encrypt ? (v + SHAKE_TABLE[idx]) >>> 0 : (v - SHAKE_TABLE[idx]) >>> 0;
    view.setUint32(i * 4, next, true);
    idx = (idx + 1) & 0xff;
  }
  return out;
}

export function crypt2Transform(data: Uint8Array, decrypt: boolean): Uint8Array {
  if (data.length < 4) return new Uint8Array(data);
  const out = new Uint8Array(data);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const firstOrig = view.getUint32(0, true);
  const first = (firstOrig ^ out.length ^ 0x18385868) >>> 0;
  view.setUint32(0, first, true);
  const xorVal = decrypt ? first : firstOrig;
  const extraWords = (out.length - 7) >> 2;
  for (let i = 0; i < extraWords; i++) {
    const off = 4 + i * 4;
    view.setUint32(off, (view.getUint32(off, true) ^ xorVal) >>> 0, true);
  }
  return out;
}

/**
 * Toggle the symmetric inner XOR layer on VCMF (version > 0x200) `.vce` buffers.
 */
export function vcmfTransform(data: Uint8Array): Uint8Array {
  if (
    data.length < 8 ||
    data[0] !== 0x56 || // V
    data[1] !== 0x43 || // C
    data[2] !== 0x4d || // M
    data[3] !== 0x46 // F
  ) {
    return data;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ver = view.getUint32(4, true);
  if (ver <= 0x200) return data;

  const verTag = `VCMF${(ver >>> 8).toString(16)}.${(ver & 0xff).toString(16).padStart(2, "0")}`;
  let seed = 0;
  for (let i = 0; i < verTag.length; i++) {
    seed = (seed + verTag.charCodeAt(i)) & 0xff;
  }

  const out = new Uint8Array(data);
  for (let i = 8; i < out.length; i++) {
    out[i] ^= VCMF_TABLE[(seed + (i - 8)) & 0xff] & 0xff;
  }
  return out;
}

export function hash64Path(pathStr: string): bigint {
  const norm = textEncoder.encode(pathStr.toLowerCase().replace(/\//g, "\\"));
  if (norm.length === 0) return 0xffffffff00000000n;

  let h = (norm[0] << 7) >>> 0;
  let i = 1;
  let ch = norm[0];
  while (true) {
    h = Math.imul(h, 0xf4243) >>> 0;
    h = (h ^ ch) >>> 0;
    if (i === norm.length) break;
    ch = norm[i++];
  }
  h = (h ^ norm.length) >>> 0;
  if (h === 0xffffffff) h = 0xfffffffe;
  const crc = crc32(norm);
  return (BigInt(crc) << 32n) | BigInt(h);
}

function payloadTransform(data: Uint8Array, name: string, encrypt: boolean): Uint8Array {
  const ext3 = name.length >= 3 ? name.slice(-3).toLowerCase() : "";
  if (FULL_CRYPT_EXTS.has(ext3)) {
    return shakeTransform(data, encrypt);
  }
  const nHead = Math.min(data.length, 0x3c);
  const out = new Uint8Array(data.length);
  out.set(shakeTransform(data.subarray(0, nHead), encrypt), 0);
  if (data.length > nHead) {
    out.set(data.subarray(nHead), nHead);
  }
  return out;
}

function decodeGlobalHeader(pakBytes: Uint8Array): PakHeader {
  if (pakBytes.length < GLOBAL_HEADER_OFFSET + GLOBAL_HEADER_SIZE) {
    throw new Error("파일 크기가 너무 작아 PAK 헤더를 읽을 수 없습니다.");
  }
  const raw = pakBytes.subarray(GLOBAL_HEADER_OFFSET, GLOBAL_HEADER_OFFSET + GLOBAL_HEADER_SIZE);
  const h = crypt2Transform(shakeTransform(raw, false), true);
  const view = new DataView(h.buffer, h.byteOffset, h.byteLength);

  const dataOffset = view.getUint32(0, true);
  const version = h[4];
  const reserved = h[5];
  const count = view.getUint32(6, true);
  const seed = h[10];
  const compByte = h[11];
  const checksum = h[12];

  const calcChk = (~(Math.imul(count ^ compByte, dataOffset) + seed)) & 0xff;
  if (checksum !== calcChk || version !== 1) {
    throw new Error(
      `PAK 헤더 검증 실패 (ver=${version}, chk=0x${checksum.toString(16)} != 0x${calcChk.toString(16)}). 잘못된 파일일 수 있습니다.`,
    );
  }

  return {
    dataOffset,
    version,
    reserved,
    count,
    seed,
    compressed: compByte !== 0,
    checksum,
  };
}

function decodeEntryHeader(
  rawEntry: Uint8Array,
  curSeed: number,
  key: Uint8Array,
  headerOffset: number,
  index: number,
): PakEntryInfo {
  const e = new Uint8Array(rawEntry);
  const eView = new DataView(e.buffer, e.byteOffset, e.byteLength);
  const a = eView.getUint32(0, true);
  const b = eView.getUint32(4, true);
  const hash64 = (BigInt(b) << 32n) | BigInt(a);

  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const k = keyView.getUint32(Number(hash64 % 0x7dn), true);
  const kLow = k & 0xff;
  for (let i = 8; i < ENTRY_HEADER_SIZE; i += 4) {
    e[i] ^= kLow;
  }

  let sv = curSeed;
  for (let i = 4; i < ENTRY_HEADER_SIZE; i += 4) {
    sv = (sv + 4) & 0xff;
    e[i] ^= MASK1_TABLE[sv];
  }

  const nameDec = shakeTransform(e.subarray(8, 0x88), false);
  const zeroIdx = nameDec.indexOf(0);
  const nameSlice = zeroIdx >= 0 ? nameDec.subarray(0, zeroIdx) : nameDec;
  const name = textDecoder.decode(nameSlice).replace(/\\/g, "/");

  const ds = e.subarray(0x88, 0x90);
  const storedSize = (ds[3] | (ds[5] << 8) | (ds[1] << 16) | (ds[7] << 24)) >>> 0;
  const uncompressedSize = (ds[6] | (ds[0] << 8) | (ds[4] << 16) | (ds[2] << 24)) >>> 0;
  const unknown = eView.getUint32(0x90, true);

  return {
    index,
    name,
    hash64,
    storedSize,
    uncompressedSize,
    unknown,
    headerOffset,
    dataOffset: headerOffset + ENTRY_HEADER_SIZE,
  };
}

/**
 * Read header and entry metadata from a `.pak` File object without decompressing payloads.
 */
export async function listPak(
  pakFile: File,
  tableKeyFile: File,
): Promise<{ header: PakHeader; entries: PakEntryInfo[] }> {
  const [pakBytes, key] = await Promise.all([readFileBytes(pakFile), loadTableKey(tableKeyFile)]);

  const header = decodeGlobalHeader(pakBytes);
  const entries: PakEntryInfo[] = [];
  let curOff = header.dataOffset;
  let curSeed = header.seed;

  for (let idx = 0; idx < header.count; idx++) {
    if (curOff + ENTRY_HEADER_SIZE > pakBytes.length) {
      throw new Error(`엔트리 ${idx} 헤더가 파일 범위를 벗어났습니다.`);
    }
    const info = decodeEntryHeader(
      pakBytes.subarray(curOff, curOff + ENTRY_HEADER_SIZE),
      curSeed,
      key,
      curOff,
      idx,
    );
    entries.push(info);
    curSeed = (curSeed - 1) & 0xff;
    curOff += ENTRY_HEADER_SIZE + info.storedSize;
  }

  return { header, entries };
}

/**
 * Decrypt and decompress a `.pak` File object into an array of `UnpackedEntry` (`Uint8Array` + `File`).
 */
export async function unpackPak(
  pakFile: File,
  tableKeyFile: File,
  options: UnpackOptions = {},
): Promise<{ header: PakHeader; entries: UnpackedEntry[] }> {
  const { decodeVce = false, decodeTrackData: shouldDecodeTrackData = false, onProgress } = options;

  const [pakBytes, key] = await Promise.all([readFileBytes(pakFile), loadTableKey(tableKeyFile)]);

  const header = decodeGlobalHeader(pakBytes);
  const entries: UnpackedEntry[] = [];
  let curOff = header.dataOffset;
  let curSeed = header.seed;

  for (let idx = 0; idx < header.count; idx++) {
    if (curOff + ENTRY_HEADER_SIZE > pakBytes.length) {
      throw new Error(`엔트리 ${idx} 헤더가 파일 범위를 벗어났습니다.`);
    }
    const info = decodeEntryHeader(
      pakBytes.subarray(curOff, curOff + ENTRY_HEADER_SIZE),
      curSeed,
      key,
      curOff,
      idx,
    );

    if (info.dataOffset + info.storedSize > pakBytes.length) {
      throw new Error(`엔트리 ${info.name}의 데이터가 잘려 있습니다.`);
    }
    const raw = pakBytes.subarray(info.dataOffset, info.dataOffset + info.storedSize);

    let decLzo: Uint8Array;
    if (!header.compressed) {
      decLzo = raw;
    } else {
      const out = new Uint8Array(info.uncompressedSize);
      let outPos = 0;
      let pos = 0;
      const rawView = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      while (pos < raw.length && outPos < info.uncompressedSize) {
        const blen = rawView.getUint32(pos, true);
        pos += 4;
        if (blen >= MAX_COMPRESSED_CHUNK || pos + blen > raw.length) {
          throw new Error(`잘못된 LZO 블록 크기 (${blen}) in ${info.name}`);
        }
        const blk = lzo1xDecompress(raw.subarray(pos, pos + blen));
        if (outPos + blk.length > out.length) {
          throw new Error(`LZO 압축 해제 크기가 헤더 크기(${info.uncompressedSize})를 초과했습니다: ${info.name}`);
        }
        out.set(blk, outPos);
        outPos += blk.length;
        pos += blen;
      }
      decLzo = outPos === out.length ? out : out.subarray(0, outPos);
    }

    let payload = payloadTransform(decLzo, info.name, false);
    const lowerName = info.name.toLowerCase();
    if (decodeVce && lowerName.endsWith(".vce")) {
      payload = vcmfTransform(payload);
    }
    if (shouldDecodeTrackData && lowerName.endsWith("trackdata.dat")) {
      payload = await decodeTrackDataBytes(payload, true);
    }

    const fileBytes = new Uint8Array(payload);
    const outFile = createFileObject(fileBytes, info.name, "application/octet-stream");
    entries.push({ info, data: fileBytes, file: outFile });

    if (onProgress) {
      onProgress(idx + 1, header.count, info.name);
    }

    curSeed = (curSeed - 1) & 0xff;
    curOff += ENTRY_HEADER_SIZE + info.storedSize;
  }

  return { header, entries };
}

function normalizeInputEntry(entry: PackInputEntry): { relPath: string; file: File } {
  if (isFileLike(entry)) {
    const rawPath = (entry as File & { webkitRelativePath?: string }).webkitRelativePath || entry.name;
    return { relPath: rawPath.replace(/\\/g, "/").replace(/^\/+/, ""), file: entry };
  }
  return { relPath: entry.path.replace(/\\/g, "/").replace(/^\/+/, ""), file: entry.file };
}

/**
 * Encrypt and optionally LZO1X-compress an array of `File` objects into a `.pak` `File` object.
 */
export async function packPak(
  inputFiles: PackInputEntry[],
  tableKeyFile: File,
  options: PackOptions = {},
): Promise<File> {
  const {
    outputName = "output.pak",
    compress = true,
    encodeVce = false,
    encodeTrackData: shouldEncodeTrackData = false,
    headerOffset = DEFAULT_DATA_OFFSET,
    seed,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onProgress,
  } = options;

  if (headerOffset < GLOBAL_HEADER_OFFSET + GLOBAL_HEADER_SIZE) {
    throw new Error(`headerOffset은 최소 0x${(GLOBAL_HEADER_OFFSET + GLOBAL_HEADER_SIZE).toString(16)} 이상이어야 합니다.`);
  }

  const key = await loadTableKey(tableKeyFile);

  const normalized = inputFiles
    .map(normalizeInputEntry)
    .filter(({ relPath }) => {
      const base = relPath.split("/").pop()?.toLowerCase() ?? "";
      return relPath.length > 0 && base !== "thumbs.db" && base !== ".ds_store";
    })
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  if (normalized.length === 0) {
    throw new Error("패킹할 파일이 없습니다.");
  }

  const count = normalized.length;
  const initSeed = seed === undefined ? count & 0xff : seed & 0xff;
  const compFlag = compress ? 1 : 0;
  const chk = (~(Math.imul(count ^ compFlag, headerOffset) + initSeed)) & 0xff;

  const plainHdr = new Uint8Array(GLOBAL_HEADER_SIZE);
  const hdrView = new DataView(plainHdr.buffer);
  hdrView.setUint32(0, headerOffset, true);
  plainHdr[4] = 1;
  plainHdr[5] = 0;
  hdrView.setUint32(6, count, true);
  plainHdr[10] = initSeed;
  plainHdr[11] = compFlag;
  plainHdr[12] = chk;

  const encHdr = shakeTransform(crypt2Transform(plainHdr, false), true);

  const prefix = new Uint8Array(headerOffset);
  const randomPrefix = prefix.subarray(0, GLOBAL_HEADER_OFFSET);
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(randomPrefix);
  } else {
    for (let i = 0; i < randomPrefix.length; i++) {
      randomPrefix[i] = Math.floor(Math.random() * 256);
    }
  }
  prefix.set(encHdr, GLOBAL_HEADER_OFFSET);

  const chunksOut: Uint8Array[] = [prefix];
  const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
  let curSeed = initSeed;

  for (let idx = 0; idx < count; idx++) {
    const { relPath, file } = normalized[idx];
    const relWin = relPath.replace(/\//g, "\\");
    const nameRaw = textEncoder.encode(relWin);
    if (nameRaw.length >= 0x80) {
      throw new Error(`파일 경로가 127바이트를 초과합니다: ${relWin}`);
    }

    let data = await readFileBytes(file);
    const lowerRel = relPath.toLowerCase();
    if (encodeVce && lowerRel.endsWith(".vce")) {
      data = vcmfTransform(data);
    }
    if (lowerRel.endsWith("trackdata.dat") && (shouldEncodeTrackData || isPlainJsonBytes(data))) {
      data = await encodeTrackDataBytes(data);
    }

    const encPayload = payloadTransform(data, relPath, true);
    const origSize = encPayload.length;

    let storedBlob: Uint8Array;
    if (!compress) {
      storedBlob = encPayload;
    } else {
      const blocks: Uint8Array[] = [];
      let totalStored = 0;
      if (origSize === 0) {
        const blk = lzo1xCompress(new Uint8Array(0));
        const lenPrefix = new Uint8Array(4);
        new DataView(lenPrefix.buffer).setUint32(0, blk.length, true);
        blocks.push(lenPrefix, blk);
        totalStored += 4 + blk.length;
      } else {
        for (let pos = 0; pos < origSize; pos += chunkSize) {
          const blk = lzo1xCompress(encPayload.subarray(pos, Math.min(origSize, pos + chunkSize)));
          const lenPrefix = new Uint8Array(4);
          new DataView(lenPrefix.buffer).setUint32(0, blk.length, true);
          blocks.push(lenPrefix, blk);
          totalStored += 4 + blk.length;
        }
      }
      storedBlob = new Uint8Array(totalStored);
      let off = 0;
      for (const b of blocks) {
        storedBlob.set(b, off);
        off += b.length;
      }
    }

    const storedSize = storedBlob.length;
    const e = new Uint8Array(ENTRY_HEADER_SIZE);
    const eView = new DataView(e.buffer);
    eView.setBigUint64(0, hash64Path(relWin), true);

    const paddedName = new Uint8Array(0x80);
    paddedName.set(nameRaw, 0);
    e.set(shakeTransform(paddedName, true), 8);

    e[0x88] = (origSize >>> 8) & 0xff;
    e[0x89] = (storedSize >>> 16) & 0xff;
    e[0x8a] = (origSize >>> 24) & 0xff;
    e[0x8b] = storedSize & 0xff;
    e[0x8c] = (origSize >>> 16) & 0xff;
    e[0x8d] = (storedSize >>> 8) & 0xff;
    e[0x8e] = origSize & 0xff;
    e[0x8f] = (storedSize >>> 24) & 0xff;

    let sv = curSeed;
    for (let i = 0; i < ENTRY_HEADER_SIZE; i += 4) {
      e[i] ^= MASK1_TABLE[sv];
      sv = (sv + 4) & 0xff;
    }

    const a = eView.getUint32(0, true);
    const b = eView.getUint32(4, true);
    const k = keyView.getUint32(Number(((BigInt(b) << 32n) | BigInt(a)) % 0x7dn), true);
    const kLow = k & 0xff;
    for (let i = 8; i < ENTRY_HEADER_SIZE; i += 4) {
      e[i] ^= kLow;
    }

    chunksOut.push(e, storedBlob);

    if (onProgress) {
      onProgress(idx + 1, count, relPath);
    }
    curSeed = (curSeed - 1) & 0xff;
  }

  const totalLen = chunksOut.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunksOut) {
    result.set(c, pos);
    pos += c.length;
  }

  return createFileObject(result, outputName, "application/octet-stream");
}

export { lzo1xCompress, lzo1xDecompress, MASK1_TABLE, SHAKE_TABLE, VCMF_TABLE };

const tapsonicPak = {
  listPak,
  unpackPak,
  packPak,
  decodeTrackData,
  encodeTrackData,
  decodeTrackDataBytes,
  encodeTrackDataBytes,
  loadTableKey,
  shakeTransform,
  crypt2Transform,
  vcmfTransform,
  hash64Path,
  lzo1xCompress,
  lzo1xDecompress,
  SHAKE_TABLE,
  MASK1_TABLE,
  VCMF_TABLE,
};

export default tapsonicPak;
