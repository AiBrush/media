/**
 * Exact ADTS frame walking — the single source of truth for `.aac` framing and duration. The walker is an
 * incremental state machine over sequential byte windows, so the probe path can hop headers through
 * bounded reads (never materializing the file) while demux/packet enumeration feed it one whole buffer.
 * It skips stacked leading ID3v2 tags (footer flag included) without counting them as audio, structurally
 * skips mid-stream ID3v2/ID3v1 metadata blocks (Icecast-style timed tags), resyncs across corruption with
 * a double-syncword confirmation so a stray `0xFFF` inside junk/album art can never mis-frame the stream,
 * and treats unresyncable tails (APE tags, garbage, a truncated final frame) as non-audio. Duration is the
 * exact per-frame sum `rawBlocks × 1024 ÷ sampling_frequency` read from each header — NEVER a byte-density
 * extrapolation (the old estimator turned trailing tag bytes into phantom seconds on VBR streams). For
 * HE-AAC/SBR the header carries the CORE rate, and `frames × 1024 ÷ coreRate` equals ffmpeg's full-decode
 * duration exactly (verified against real afconvert `aach` streams).
 */

import type { ByteSource } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';

/** MPEG-4 sampling-frequency-index table (Hz); indexes 13–15 are reserved/explicit (unsupported here). */
export const ADTS_SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

const SAMPLES_PER_BLOCK = 1024;
const MIN_HEADER_BYTES = 7; // fixed ADTS header; +2 CRC bytes when protection_absent == 0
const ID3V2_HEADER_BYTES = 10;
const ID3V2_FOOTER_BYTES = 10;
const ID3V1_TAG_BYTES = 128;
/**
 * Unconsumed tail kept when a mid-stream scan exhausts a window: long enough that a frame header
 * (7 bytes) or a tag magic + ID3v2 size header (10 bytes) split across the boundary is never lost.
 */
const SCAN_WAIT_TAIL_BYTES = ID3V2_HEADER_BYTES - 1;
/** Default probe window: bounded memory, few range round-trips even on hour-long streams. */
const DEFAULT_PROBE_WINDOW_BYTES = 4 * 1024 * 1024;
const MIN_PROBE_WINDOW_BYTES = 32;

/** A valid ADTS sync: byte0 = 0xFF, byte1 top nibble = 0xF, layer bits (b1 & 6) == 0. */
export function isAdtsSync(b0: number, b1: number): boolean {
  return b0 === 0xff && (b1 & 0xf0) === 0xf0 && (b1 & 0x06) === 0;
}

/** The first ADTS header's stream-level facts (drives codec string, ASC synthesis, channel checks). */
export interface AdtsFirstHeader {
  /** MPEG-4 audio object type from the 2-bit profile field (+1); 2 = AAC-LC. */
  readonly aot: number;
  readonly freqIndex: number;
  readonly sampleRate: number;
  readonly channelConfig: number;
}

/** One walked frame — byte geometry + integer-µs timing (identical math to the legacy enumerator). */
export interface AdtsWalkedFrame {
  /** Absolute byte offset of the frame's first header byte (the 0xFF sync) within the stream. */
  readonly offset: number;
  /** Full frame length in bytes (header + optional CRC + payload) — matches ffprobe packet `size`. */
  readonly size: number;
  /** ADTS header length: 7 bytes, or 9 when a CRC is present (protection_absent == 0). */
  readonly headerBytes: number;
  /** Presentation timestamp in microseconds (cumulative samples ÷ sampleRate, rounded). */
  readonly ptsUs: number;
  /** Frame duration in microseconds (rawBlocks · 1024 ÷ sampleRate, rounded). */
  readonly durationUs: number;
  /** Decoded PCM samples per channel carried by this ADTS frame. */
  readonly samples: number;
}

/** Exact whole-stream totals from the frame walk (never estimated). */
export interface AdtsWalkStats {
  /** Complete, validated ADTS frames (a truncated final frame is excluded — it cannot decode). */
  readonly frames: number;
  /** Exact duration: Σ per-frame samples ÷ that frame's header rate (HE-AAC: the core rate). */
  readonly durationSec: number;
  /** First frame's header facts (codec/rate/channels source). */
  readonly firstHeader: AdtsFirstHeader;
  /** Bytes skipped after the first lock (mid-stream tags/corruption) plus unresyncable tail bytes. */
  readonly junkBytes: number;
  /** True when the stream ends inside a declared frame (a cut-off download). */
  readonly truncated: boolean;
}

/** Where a resync scan landed: on a candidate header, a tag magic, a wait point, or end-of-junk. */
interface ScanOutcome {
  readonly kind: 'candidate' | 'tag' | 'wait' | 'end';
  readonly at: number;
}

interface FrameHeader {
  readonly frameLen: number;
  readonly headerBytes: number;
  readonly freqIndex: number;
  readonly sampleRate: number;
  readonly rawBlocks: number;
}

/** Parse + sanity-check the 7-byte header at `i` (needs 7 readable bytes); undefined when invalid. */
function readFrameHeader(dv: DataView, i: number): FrameHeader | undefined {
  if (!isAdtsSync(dv.getUint8(i), dv.getUint8(i + 1))) return undefined;
  const b2 = dv.getUint8(i + 2);
  const freqIndex = (b2 >> 2) & 0xf;
  const sampleRate = ADTS_SAMPLE_RATES[freqIndex];
  if (sampleRate === undefined) return undefined;
  const headerBytes = (dv.getUint8(i + 1) & 0x1) === 0 ? 9 : MIN_HEADER_BYTES;
  const frameLen =
    ((dv.getUint8(i + 3) & 0x3) << 11) | (dv.getUint8(i + 4) << 3) | (dv.getUint8(i + 5) >> 5);
  if (frameLen < headerBytes) return undefined;
  return {
    frameLen,
    headerBytes,
    freqIndex,
    sampleRate,
    rawBlocks: (dv.getUint8(i + 6) & 0x3) + 1,
  };
}

/** Whether a full `ID3` (v2) or `TAG` (v1) magic sits at `s` (given the bytes available). */
function looksLikeTagStart(dv: DataView, s: number, len: number): boolean {
  if (s + 3 > len) return false;
  const b0 = dv.getUint8(s);
  if (b0 === 0x49) return dv.getUint8(s + 1) === 0x44 && dv.getUint8(s + 2) === 0x33;
  if (b0 === 0x54) return dv.getUint8(s + 1) === 0x41 && dv.getUint8(s + 2) === 0x47;
  return false;
}

/**
 * Incremental exact ADTS walker. Feed sequential windows with {@link push}; range-capable callers may
 * fast-forward a pending tag skip via {@link pendingSkipBytes}/{@link noteSkipped} instead of reading
 * tag bytes. {@link finish} flushes end-of-stream handling and returns the totals, throwing the same
 * typed errors the legacy parser threw: {@link InputError} when no frame ever locks, and
 * {@link MediaError} when the stream's first syncword carries a reserved sampling-frequency index.
 */
export class AdtsFrameWalker {
  readonly #onFrame: ((frame: AdtsWalkedFrame) => void) | undefined;
  /** Unconsumed tail carried between windows — bounded by one frame + confirmation lookahead. */
  #carry: Uint8Array | undefined;
  /** Absolute stream offset of the next unconsumed byte (`#carry[0]` when a carry exists). */
  #base = 0;
  /** Bytes the caller may drop without reading (a leading/mid-stream tag's remaining body). */
  #skipBytes = 0;
  /** Whether the byte at the first post-leading-tag position was checked (error-shape parity). */
  #startChecked = false;
  #sawSyncAtStart = false;
  #lockedOnce = false;
  /** A resync is in progress: the next lock needs a double-syncword confirmation. */
  #confirmPending = false;
  #atEnd = false;
  #finished = false;
  #frames = 0;
  #junkBytes = 0;
  #truncated = false;
  #firstHeader: AdtsFirstHeader | undefined;
  /** Exact-duration accumulator: seconds/µs of completed constant-rate runs + the open run. */
  #baseSec = 0;
  #baseUs = 0;
  #runRate = 0;
  #runSamples = 0;

  constructor(onFrame?: (frame: AdtsWalkedFrame) => void) {
    this.#onFrame = onFrame;
  }

  /** Pending tag-skip a range-capable reader may seek over instead of reading. */
  get pendingSkipBytes(): number {
    return this.#skipBytes;
  }

  /** Record that `n` source bytes (≤ {@link pendingSkipBytes}) were seeked over without reading. */
  noteSkipped(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > this.#skipBytes) {
      throw new MediaError('demux-error', `ADTS walker: invalid skip of ${n} bytes`);
    }
    this.#skipBytes -= n;
    this.#base += n;
  }

  /** Feed the next sequential window; the walker consumes what it can and carries the rest. */
  push(chunk: Uint8Array): void {
    this.#assertLive();
    const carry = this.#carry;
    if (carry === undefined || carry.byteLength === 0) {
      this.#walk(chunk);
      return;
    }
    const joined = new Uint8Array(carry.byteLength + chunk.byteLength);
    joined.set(carry, 0);
    joined.set(chunk, carry.byteLength);
    this.#carry = undefined;
    this.#walk(joined);
  }

  /** Flush end-of-stream handling and return the exact totals (throws when nothing ever locked). */
  finish(): AdtsWalkStats {
    this.#assertLive();
    this.#atEnd = true;
    this.#walk(this.#carry ?? new Uint8Array(0));
    this.#carry = undefined;
    this.#finished = true;
    const firstHeader = this.#firstHeader;
    if (firstHeader === undefined || this.#frames === 0) {
      throw this.#sawSyncAtStart
        ? new InputError('unsupported-input', 'ADTS: no decodable frames')
        : new InputError('unsupported-input', 'not an ADTS/AAC stream (no 0xFFF syncword)');
    }
    return {
      frames: this.#frames,
      durationSec: this.#baseSec + (this.#runRate === 0 ? 0 : this.#runSamples / this.#runRate),
      firstHeader,
      junkBytes: this.#junkBytes,
      truncated: this.#truncated,
    };
  }

  #assertLive(): void {
    if (this.#finished) throw new MediaError('demux-error', 'ADTS walker already finished');
  }

  /** Close the open constant-rate run (called when the per-frame header rate changes). */
  #closeRun(): void {
    if (this.#runRate === 0) return;
    this.#baseSec += this.#runSamples / this.#runRate;
    this.#baseUs += Math.round((this.#runSamples * 1_000_000) / this.#runRate);
    this.#runRate = 0;
    this.#runSamples = 0;
  }

  /**
   * Walk as much of `w` as possible. Consumed bytes advance `#base`; the unconsumed tail (bounded by
   * one declared frame + its 2-byte confirmation lookahead) becomes the next carry. Every iteration
   * either consumes bytes, emits a frame, or breaks to wait for more input — the walk is total.
   */
  #walk(w: Uint8Array): void {
    const dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
    const len = w.byteLength;
    let i = 0;
    while (true) {
      // 1) Consume a pending tag skip.
      if (this.#skipBytes > 0) {
        const n = Math.min(this.#skipBytes, len - i);
        this.#skipBytes -= n;
        i += n;
        if (this.#skipBytes > 0) break; // the tag continues beyond this window (or past EOF)
      }
      const avail = len - i;
      if (avail === 0) break;

      // 2) Structural metadata skips. Tag magics start with 'I'/'T', never a frame's 0xFF, so these
      //    only fire where a frame sync would fail anyway; declared sizes are honored so frame-like
      //    bytes inside album art are never scanned.
      if (dv.getUint8(i) === 0x49 /* 'I' */) {
        if (avail < ID3V2_HEADER_BYTES && !this.#atEnd) break; // may become a full ID3v2 header
        if (looksLikeTagStart(dv, i, len) && avail >= ID3V2_HEADER_BYTES) {
          const size =
            ((dv.getUint8(i + 6) & 0x7f) << 21) |
            ((dv.getUint8(i + 7) & 0x7f) << 14) |
            ((dv.getUint8(i + 8) & 0x7f) << 7) |
            (dv.getUint8(i + 9) & 0x7f);
          const footer = (dv.getUint8(i + 5) & 0x10) !== 0 ? ID3V2_FOOTER_BYTES : 0;
          const skip = ID3V2_HEADER_BYTES + size + footer;
          if (this.#lockedOnce) this.#junkBytes += skip; // mid-stream metadata block
          this.#skipBytes = skip;
          continue;
        }
      } else if (dv.getUint8(i) === 0x54 /* 'T' */ && looksLikeTagStart(dv, i, len)) {
        if (avail < ID3V1_TAG_BYTES && !this.#atEnd) break; // the 128-byte block spans the boundary
        const skip = Math.min(ID3V1_TAG_BYTES, avail);
        if (this.#lockedOnce) this.#junkBytes += skip;
        this.#skipBytes = skip;
        continue;
      }

      // 3) One-time first-position bookkeeping (legacy error-shape parity: a reserved
      //    sampling-frequency index on the stream's first syncword is a typed MediaError).
      if (!this.#startChecked) {
        if (avail < 3 && !this.#atEnd) break;
        if (avail < 3) {
          this.#junkBytes += avail; // an EOF preamble too short to ever hold a frame
          i = len;
          break;
        }
        this.#startChecked = true;
        if (isAdtsSync(dv.getUint8(i), dv.getUint8(i + 1))) {
          this.#sawSyncAtStart = true;
          const freqIndex = (dv.getUint8(i + 2) >> 2) & 0xf;
          if (ADTS_SAMPLE_RATES[freqIndex] === undefined) {
            throw new MediaError(
              'demux-error',
              `ADTS: reserved sampling-frequency index ${freqIndex}`,
            );
          }
        }
      }

      // 4) Frame attempt at `i`.
      if (avail < MIN_HEADER_BYTES) {
        if (!this.#atEnd) break; // a header may complete with the next window
        this.#junkBytes += avail;
        i = len;
        break;
      }
      const header = readFrameHeader(dv, i);
      if (header === undefined) {
        // Sync/header sanity failed: junk begins — scan forward for the next plausible position.
        const outcome = this.#scan(dv, len, i);
        i = outcome.at;
        if (outcome.kind === 'candidate' || outcome.kind === 'tag') continue;
        break; // 'wait' (tail carried for the next window) or 'end' (tail junked at EOF)
      }
      const frameEnd = i + header.frameLen;
      if (this.#confirmPending) {
        // A post-junk lock needs proof: the next syncword, or an exact end-of-stream fit.
        const confirmed =
          frameEnd + 2 <= len
            ? isAdtsSync(dv.getUint8(frameEnd), dv.getUint8(frameEnd + 1))
            : this.#atEnd && frameEnd === len;
        if (!confirmed) {
          if (!this.#atEnd && frameEnd + 2 > len) break; // confirmation bytes not here yet
          const outcome = this.#scan(dv, len, i); // disproven candidate: it is junk after all
          i = outcome.at;
          if (outcome.kind === 'candidate' || outcome.kind === 'tag') continue;
          break;
        }
      }
      if (frameEnd > len) {
        if (!this.#atEnd) break; // wait for the frame body
        this.#truncated = true; // a cut-off final frame never decodes: excluded from the duration
        i = len;
        break;
      }
      this.#emit(dv, i, header);
      i = frameEnd;
    }

    this.#base += i;
    this.#carry = i < len ? w.slice(i) : undefined;
  }

  /**
   * Scan forward from the failed position `from` for the next plausible lock point, counting the
   * skipped bytes as junk and arming the double-sync confirmation. Lands on a candidate header
   * (`candidate`), a tag magic the main loop will skip structurally (`tag`), a bounded wait point when
   * the window ran out (`wait`), or consumes the tail as junk at end-of-stream (`end`).
   */
  #scan(dv: DataView, len: number, from: number): ScanOutcome {
    this.#confirmPending = true;
    let s = from + 1;
    while (s + MIN_HEADER_BYTES <= len) {
      const b0 = dv.getUint8(s);
      if (b0 === 0xff && readFrameHeader(dv, s) !== undefined) {
        this.#junkBytes += s - from;
        return { kind: 'candidate', at: s };
      }
      if ((b0 === 0x49 || b0 === 0x54) && looksLikeTagStart(dv, s, len)) {
        this.#junkBytes += s - from;
        return { kind: 'tag', at: s };
      }
      s++;
    }
    if (this.#atEnd) {
      this.#junkBytes += len - from;
      return { kind: 'end', at: len };
    }
    // Keep a tail that may still become a header or tag magic once more bytes arrive; everything
    // before it is definitively junk. `at` never regresses, so the walk stays total.
    const keep = Math.min(len - from, SCAN_WAIT_TAIL_BYTES);
    const at = len - keep;
    this.#junkBytes += at - from;
    return { kind: 'wait', at };
  }

  #emit(dv: DataView, i: number, header: FrameHeader): void {
    const { frameLen, headerBytes, freqIndex, sampleRate, rawBlocks } = header;
    if (this.#firstHeader === undefined) {
      const b2 = dv.getUint8(i + 2);
      const b3 = dv.getUint8(i + 3);
      this.#firstHeader = {
        aot: ((b2 >> 6) & 0x3) + 1,
        freqIndex,
        sampleRate,
        channelConfig: ((b2 & 0x1) << 2) | ((b3 >> 6) & 0x3),
      };
    }
    if (sampleRate !== this.#runRate) this.#closeRun();
    if (this.#runRate === 0) this.#runRate = sampleRate;
    const samples = rawBlocks * SAMPLES_PER_BLOCK;
    const ptsUs = this.#baseUs + Math.round((this.#runSamples * 1_000_000) / this.#runRate);
    const durationUs = Math.round((samples * 1_000_000) / sampleRate);
    this.#onFrame?.({
      offset: this.#base + i,
      size: frameLen,
      headerBytes,
      ptsUs,
      durationUs,
      samples,
    });
    this.#runSamples += samples;
    this.#frames++;
    this.#lockedOnce = true;
    this.#confirmPending = false;
  }
}

/**
 * Byte offset of the expected first ADTS frame within a sniffed head, skipping every fully-visible
 * leading ID3v2 tag (stacked tags and the footer flag included). `undefined` when a tag extends past
 * the head — the audio start is not visible, so magic-based detection cannot confirm ADTS.
 */
export function adtsHeadOffset(head: Uint8Array): number | undefined {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const len = head.byteLength;
  let off = 0;
  while (
    off + ID3V2_HEADER_BYTES <= len &&
    dv.getUint8(off) === 0x49 &&
    looksLikeTagStart(dv, off, len)
  ) {
    const size =
      ((dv.getUint8(off + 6) & 0x7f) << 21) |
      ((dv.getUint8(off + 7) & 0x7f) << 14) |
      ((dv.getUint8(off + 8) & 0x7f) << 7) |
      (dv.getUint8(off + 9) & 0x7f);
    const footer = (dv.getUint8(off + 5) & 0x10) !== 0 ? ID3V2_FOOTER_BYTES : 0;
    off += ID3V2_HEADER_BYTES + size + footer;
  }
  return off <= len ? off : undefined;
}

/** One-shot exact walk over a complete in-memory stream (demux/packet-enumeration path). */
export function walkAdtsBuffer(
  bytes: Uint8Array,
  onFrame?: (frame: AdtsWalkedFrame) => void,
): AdtsWalkStats {
  const walker = new AdtsFrameWalker(onFrame);
  walker.push(bytes);
  return walker.finish();
}

export interface ProbeAdtsStreamOptions {
  /** Bytes per bounded read on range-capable sources (default 4 MiB; clamped to ≥ 32). */
  readonly windowBytes?: number;
  readonly signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaError('aborted', 'operation aborted');
}

/**
 * Bounded-read exact probe: walk every ADTS header of `src` through fixed-size windows (seeking over
 * tag bodies on range-capable sources instead of reading them) or through the plain stream when the
 * source has no random access. Memory never exceeds one window plus the walker's bounded carry.
 */
export async function probeAdtsStream(
  src: ByteSource,
  opts?: ProbeAdtsStreamOptions,
): Promise<AdtsWalkStats> {
  const windowBytes = Math.max(
    MIN_PROBE_WINDOW_BYTES,
    opts?.windowBytes ?? DEFAULT_PROBE_WINDOW_BYTES,
  );
  const signal = opts?.signal;
  throwIfAborted(signal);
  const walker = new AdtsFrameWalker();
  const range = src.range;
  const size = src.size;
  if (range !== undefined && size !== undefined) {
    let pos = 0;
    while (pos < size) {
      throwIfAborted(signal);
      const pendingSkip = walker.pendingSkipBytes;
      if (pendingSkip > 0) {
        const n = Math.min(pendingSkip, size - pos);
        walker.noteSkipped(n);
        pos += n;
        continue;
      }
      const end = Math.min(pos + windowBytes, size);
      walker.push(await range.call(src, pos, end));
      pos = end;
    }
    throwIfAborted(signal);
    return walker.finish();
  }
  const reader = src.stream().getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      walker.push(value);
    }
  } catch (e) {
    await reader.cancel(e).catch(() => {});
    throw e;
  }
  return walker.finish();
}
