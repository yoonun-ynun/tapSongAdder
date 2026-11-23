/**
 * Pure TypeScript LZO1X-1 compressor and decompressor (zero dependencies, Browser & Node compatible).
 */

class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(Math.max(64, initialCapacity));
  }

  private ensure(extra: number): void {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < needed) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
  }

  get length(): number {
    return this.pos;
  }

  push(byte: number): void {
    this.ensure(1);
    this.buf[this.pos++] = byte & 0xff;
  }

  orAtOffsetFromEnd(offsetFromEnd: number, mask: number): void {
    this.buf[this.pos - offsetFromEnd] |= mask & 0xff;
  }

  appendSlice(src: Uint8Array, start: number, end: number): void {
    const len = end - start;
    if (len <= 0) return;
    this.ensure(len);
    this.buf.set(src.subarray(start, end), this.pos);
    this.pos += len;
  }

  copyBack(dist: number, len: number): void {
    if (dist > this.pos) {
      throw new Error(`LZO1X lookbehind overrun: dist=${dist} > out=${this.pos}`);
    }
    this.ensure(len);
    const start = this.pos - dist;
    if (len <= dist) {
      this.buf.copyWithin(this.pos, start, start + len);
      this.pos += len;
    } else {
      for (let i = 0; i < len; i++) {
        this.buf[this.pos] = this.buf[this.pos - dist];
        this.pos++;
      }
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function readExtLen(src: Uint8Array, ip: number, base: number): [number, number] {
  let t = 0;
  while (src[ip] === 0) {
    t += 255;
    ip++;
  }
  return [t + base + src[ip], ip + 1];
}

/**
 * Decompress a single LZO1X stream up to its EOF marker (11 00 00).
 */
export function lzo1xDecompress(src: Uint8Array): Uint8Array {
  if (src.length === 0) return new Uint8Array(0);
  const out = new ByteWriter(src.length * 2);
  let ip = 0;
  let state = 0;

  let t = src[ip];
  if (t > 17) {
    ip++;
    const cnt = t - 17;
    out.appendSlice(src, ip, ip + cnt);
    ip += cnt;
    state = cnt >= 4 ? 4 : cnt;
  }

  while (true) {
    t = src[ip++];
    let dist: number;
    let ln: number;
    let trail: number;

    if (t < 16) {
      if (state === 0) {
        if (t === 0) {
          [t, ip] = readExtLen(src, ip, 15);
        }
        const cnt = t + 3;
        out.appendSlice(src, ip, ip + cnt);
        ip += cnt;
        state = 4;
        continue;
      } else if (state < 4) {
        dist = 1 + (t >> 2) + (src[ip++] << 2);
        ln = 2;
      } else {
        dist = 2049 + (t >> 2) + (src[ip++] << 2);
        ln = 3;
      }
      trail = t & 3;
    } else if (t >= 64) {
      ln = (t >> 5) + 1;
      dist = ((t >> 2) & 7) + (src[ip++] << 3) + 1;
      trail = t & 3;
    } else if (t >= 32) {
      ln = t & 31;
      if (ln === 0) {
        [ln, ip] = readExtLen(src, ip, 31);
      }
      ln += 2;
      const v = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      dist = (v >> 2) + 1;
      trail = v & 3;
    } else {
      ln = t & 7;
      if (ln === 0) {
        [ln, ip] = readExtLen(src, ip, 7);
      }
      ln += 2;
      const v = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      dist = ((t & 8) << 11) + (v >> 2);
      trail = v & 3;
      if (dist === 0) {
        return out.toUint8Array();
      }
      dist += 16384;
    }

    out.copyBack(dist, ln);
    if (trail > 0) {
      out.appendSlice(src, ip, ip + trail);
      ip += trail;
    }
    state = trail;
  }
}

function writeExtLen(out: ByteWriter, val: number): void {
  while (val > 255) {
    out.push(0);
    val -= 255;
  }
  out.push(val);
}

function emitLiteralRun(
  out: ByteWriter,
  src: Uint8Array,
  litStart: number,
  litLen: number,
  firstOp: boolean,
): void {
  if (litLen <= 0) return;
  if (firstOp && litLen <= 238) {
    out.push(17 + litLen);
  } else if (litLen <= 3) {
    out.orAtOffsetFromEnd(2, litLen);
  } else if (litLen <= 18) {
    out.push(litLen - 3);
  } else {
    out.push(0);
    writeExtLen(out, litLen - 18);
  }
  out.appendSlice(src, litStart, litStart + litLen);
}

function emitMatch(out: ByteWriter, mLen: number, dist: number): void {
  if (dist <= 2048 && mLen <= 8) {
    const d = dist - 1;
    out.push(((mLen - 1) << 5) | ((d & 7) << 2));
    out.push(d >> 3);
  } else if (dist <= 16384) {
    if (mLen <= 33) {
      out.push(32 | (mLen - 2));
    } else {
      out.push(32);
      writeExtLen(out, mLen - 33);
    }
    const d = (dist - 1) << 2;
    out.push(d & 0xff);
    out.push(d >> 8);
  } else {
    const d = dist - 16384;
    const hi = (d >> 11) & 8;
    if (mLen <= 9) {
      out.push(16 | hi | (mLen - 2));
    } else {
      out.push(16 | hi);
      writeExtLen(out, mLen - 9);
    }
    const lo = (d & 0x3fff) << 2;
    out.push(lo & 0xff);
    out.push(lo >> 8);
  }
}

/**
 * Compress bytes into a standard LZO1X-1 stream terminated by 11 00 00.
 */
export function lzo1xCompress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new ByteWriter(Math.max(64, n));
  if (n === 0) {
    out.push(0x11);
    out.push(0x00);
    out.push(0x00);
    return out.toUint8Array();
  }

  if (n < 13) {
    emitLiteralRun(out, src, 0, n, true);
    out.push(0x11);
    out.push(0x00);
    out.push(0x00);
    return out.toUint8Array();
  }

  const htable = new Int32Array(1 << 14).fill(-1);
  let ip = 0;
  let litStart = 0;
  let firstOp = true;
  const limit = n - 4;

  while (ip < limit) {
    const key32 = src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24);
    const slot = Math.imul(key32, 0x1e35a7bd) >>> 18;
    const ref = htable[slot];
    htable[slot] = ip;

    if (ref >= 0) {
      const dist = ip - ref;
      if (
        dist >= 1 &&
        dist <= 49151 &&
        src[ref] === src[ip] &&
        src[ref + 1] === src[ip + 1] &&
        src[ref + 2] === src[ip + 2] &&
        src[ref + 3] === src[ip + 3]
      ) {
        let mLen = 4;
        const maxLen = n - ip;
        while (mLen < maxLen && src[ref + mLen] === src[ip + mLen]) {
          mLen++;
        }

        const litLen = ip - litStart;
        if (!(firstOp && litLen === 0)) {
          if (litLen > 0) {
            emitLiteralRun(out, src, litStart, litLen, firstOp);
            firstOp = false;
          }
          emitMatch(out, mLen, dist);
          firstOp = false;
          ip += mLen;
          litStart = ip;
          continue;
        }
      }
    }
    ip++;
  }

  const rem = n - litStart;
  if (rem > 0) {
    emitLiteralRun(out, src, litStart, rem, firstOp);
  }
  out.push(0x11);
  out.push(0x00);
  out.push(0x00);
  return out.toUint8Array();
}

const lzo1x = {
  compress: lzo1xCompress,
  decompress: lzo1xDecompress,
  lzo1xCompress,
  lzo1xDecompress,
};

export default lzo1x;
