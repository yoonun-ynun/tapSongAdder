import { NativeModules, TurboModuleRegistry } from 'react-native';

export type FileEncoding = 'utf8' | 'base64';
export type ReadFileMode = FileEncoding | 'File';

export type DirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

type NativeFilePickerSpec = {
  pick(options: { directory: boolean; multiple: boolean }): Promise<string[]>;
  pickSave(defaultFileName: string): Promise<string>;
  readFile(path: string, encoding: FileEncoding): Promise<string>;
  writeFile(path: string, data: string, encoding: FileEncoding): Promise<boolean>;
  readDir(path: string): Promise<DirEntry[]>;
  copyFile(srcPath: string, destPath: string): Promise<boolean>;
  mkdir(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
};

const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.trim();
  if (!clean) return new Uint8Array(0);

  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;

  const out = new Uint8Array((clean.length * 3) / 4 - pad);
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)];
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = clean[i + 2] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 2)];
    const c3 = clean[i + 3] === '=' ? 0 : B64_LOOKUP[clean.charCodeAt(i + 3)];
    const v = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outIdx++] = (v >> 16) & 0xff;
    if (clean[i + 2] !== '=') out[outIdx++] = (v >> 8) & 0xff;
    if (clean[i + 3] !== '=') out[outIdx++] = v & 0xff;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x3000; // 3의 배수 단위 청크 처리

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    let chunk = '';
    let i = offset;
    for (; i + 2 < end; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      chunk +=
        B64_CHARS[(v >> 18) & 63] +
        B64_CHARS[(v >> 12) & 63] +
        B64_CHARS[(v >> 6) & 63] +
        B64_CHARS[v & 63];
    }
    if (i < end) {
      const hasSecond = i + 1 < end;
      const v = (bytes[i] << 16) | (hasSecond ? bytes[i + 1] << 8 : 0);
      chunk +=
        B64_CHARS[(v >> 18) & 63] +
        B64_CHARS[(v >> 12) & 63] +
        (hasSecond ? B64_CHARS[(v >> 6) & 63] : '=') +
        '=';
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof blob.bytes === 'function') {
    try {
      return bytesToBase64(await blob.bytes());
    } catch {
      // 미지원 런타임이면 다음 경로로 폴백
    }
  }

  if (typeof blob.arrayBuffer === 'function') {
    try {
      return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    } catch {
      // 미지원 런타임이면 FileReader로 폴백
    }
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('File/Blob을 Base64로 변환하지 못했습니다.'));
        return;
      }
      const commaIdx = reader.result.indexOf(',');
      resolve(commaIdx >= 0 ? reader.result.slice(commaIdx + 1) : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader 읽기 실패'));
    };
    reader.readAsDataURL(blob);
  });
}

function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      const cp =
        (((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3) - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function extractFileName(path: string): string {
  return path.split(/[/\\]/).pop() || 'file';
}

function createMemoryBlob(bytes: Uint8Array, type = ''): Blob {
  return {
    size: bytes.byteLength,
    type,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return bytes.slice().buffer;
    },
    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      return bytes.slice();
    },
    async text(): Promise<string> {
      return decodeUtf8(bytes);
    },
    slice(start?: number, end?: number, contentType?: string): Blob {
      return createMemoryBlob(bytes.subarray(start, end), contentType ?? '');
    },
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      throw new Error('ReadableStream is not supported on this runtime');
    },
  } as unknown as Blob;
}

function createFileObject(bytes: Uint8Array, name: string, type = ''): File {
  const lastModified = Date.now();

  if (typeof File !== 'undefined') {
    try {
      const nativeFile = new File([bytes as BlobPart], name, {
        type,
        lastModified,
      });
      if (typeof nativeFile.arrayBuffer === 'function') {
        return nativeFile;
      }
    } catch {
      // RN BlobManager가 ArrayBufferView를 거부하면 메모리 폴백 사용
    }
  }

  return Object.assign(createMemoryBlob(bytes, type), {
    name,
    lastModified,
    webkitRelativePath: '',
  }) as unknown as File;
}

function getModule(): NativeFilePickerSpec {
  const mod =
    (TurboModuleRegistry.get('FilePicker') as NativeFilePickerSpec | null) ??
    (NativeModules.FilePicker as NativeFilePickerSpec | undefined);

  if (!mod) {
    throw new Error(
      'FilePicker 네이티브 모듈을 찾을 수 없습니다. 네이티브 앱을 다시 빌드했는지 확인하세요.',
    );
  }
  return mod;
}

export function pickFiles(multiple = false): Promise<string[]> {
  return getModule().pick({ directory: false, multiple });
}

export async function pickFolder(): Promise<string | null> {
  const paths = await getModule().pick({ directory: true, multiple: false });
  return paths[0] ?? null;
}

export async function pickSavePath(defaultFileName = ''): Promise<string | null> {
  const path = await getModule().pickSave(defaultFileName);
  return path || null;
}

export function readFile(path: string): Promise<string>;
export function readFile(path: string, encoding: FileEncoding): Promise<string>;
export function readFile(path: string, encoding: 'File'): Promise<File>;
export async function readFile(
  path: string,
  encoding: ReadFileMode = 'utf8',
): Promise<string | File> {
  if (encoding === 'File') {
    const base64 = await getModule().readFile(path, 'base64');
    const bytes = base64ToBytes(base64);
    return createFileObject(bytes, extractFileName(path));
  }
  return getModule().readFile(path, encoding);
}

export function writeFile(
  path: string,
  data: string,
  encoding?: FileEncoding,
): Promise<boolean>;
export function writeFile(
  path: string,
  data: File | Blob,
  encoding?: 'File',
): Promise<boolean>;
export async function writeFile(
  path: string,
  data: string | File | Blob,
  encoding: ReadFileMode = 'utf8',
): Promise<boolean> {
  if (typeof data !== 'string') {
    const base64 = await blobToBase64(data);
    return getModule().writeFile(path, base64, 'base64');
  }
  const nativeEncoding: FileEncoding = encoding === 'File' ? 'utf8' : encoding;
  return getModule().writeFile(path, data, nativeEncoding);
}

export function readDir(path: string): Promise<DirEntry[]> {
  return getModule().readDir(path);
}

export function copyFile(srcPath: string, destPath: string): Promise<boolean> {
  return getModule().copyFile(srcPath, destPath);
}

export function mkdir(path: string): Promise<boolean> {
  return getModule().mkdir(path);
}

export function remove(path: string): Promise<boolean> {
  return getModule().remove(path);
}

export function exists(path: string): Promise<boolean> {
  return getModule().exists(path);
}