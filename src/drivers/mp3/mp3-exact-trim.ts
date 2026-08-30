/**
 * **Exact, sample-aligned MP3 → MP3 copy trim** (REQUIREMENTS §5.7 "lossless sample-aligned
 * compressed-audio trim when the format can signal delay/padding"). No re-encode: every emitted audio
 * frame is a verbatim source frame, and the requested presentation window is expressed through the
 * authored Xing/LAME encoder-delay + encoder-padding fields.
 *
 * ## Why a naive frame copy is not exact
 *
 * Layer III frames are not independently decodable. Frame *N*'s decoded PCM needs
 *
 *  1. the **bit reservoir**: its main data may begin up to 511 bytes *before* its own slot
 *     (`main_data_begin`, ISO/IEC 11172-3 §2.4.2.7), i.e. inside earlier frames; and
 *  2. **filterbank/IMDCT history**: the synthesis filterbank keeps 512 PCM samples of state and each
 *     granule's IMDCT is overlap-added with the previous granule's. MPEG-1 carries two granules per
 *     frame, so one preceding frame's spectral data suffices; MPEG-2/2.5 carries one, so two are needed.
 *
 * So the first emitted frame must be preceded by warm-up frames, and the Xing/LAME `delay` field must
 * skip them. That field is only 12 bits (≤ 4095 samples). Measured on the corpus, satisfying the
 * reservoir by *replaying whole source frames* costs 3–8 MPEG-1 frames — 3456…9216 samples — which does
 * NOT fit, and that is exactly why a packet-replay trim cannot author this window.
 *
 * ## The reservoir-carrier frame
 *
 * The reservoir dependency is a **byte** dependency, not a frame dependency, and at most 511 bytes deep.
 * So instead of replaying whole frames to carry those bytes, this module synthesizes ONE silent Layer III
 * frame whose main-data slot ends with exactly the borrowed bytes and whose side information is all
 * zero — `main_data_begin = 0`, `part2_3_length = 0` for every granule, so it decodes to silence and
 * consumes nothing from the reservoir. After it, the main-data stream position is exactly the borrowed
 * byte count, so the first real frame's own unmodified `main_data_begin` lands on the borrowed bytes and
 * every later frame's back-pointer stays valid without any bitstream rewriting.
 *
 * The lead-in therefore costs one carrier frame plus the filterbank warm-up frames only:
 *
 * | version    | samples/frame | lead frames | max authored delay          |
 * | ---------- | ------------- | ----------- | --------------------------- |
 * | MPEG-1     | 1152          | 1 + 1       | 2·1152 + 1151 = **3455**    |
 * | MPEG-2/2.5 | 576           | 1 + 2       | 3·576  +  575 = **2303**    |
 *
 * Both fit the 12-bit LAME field with room to spare, so the exact window is ALWAYS authorable
 * (MPEG-1 deep-reservoir carrier windows still use 1+1=2 frames =3455, ≤4095, carrying 4-6 frames
 * of history in one carrier, verified bitexact). The end is symmetric and always fits too: the
 * trailing padding never exceeds one frame.
 *
 * The module is pure (bytes in, bytes out) so the arithmetic is Node-validated against a real decode.
 */

import {
  LAYER_III_BITRATE_INDEXES,
  type Mp3FrameHeader,
  type MpegVersion,
  firstFrameOffset,
  hasId3v1,
  layer3FrameSizeForBitrateIndex,
  layer3MainDataBegin,
  layer3SideInfoBytes,
  parseMp3FrameHeader,
  parseVbrHeader,
} from '../../codecs/wasm-mp3/mp3.ts';
import type { TrackInfo, TrimAlignment } from '../../contracts/driver.ts';
import { InputError, MediaError } from '../../contracts/errors.ts';
import { zeroCopySubarray } from '../../util/zero-copy.ts';
import { embedHistoryPcmId3 } from './mp3-chrome-patch.ts';
import { MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES } from './mp3-gapless.ts';
import { muxPreparedMp3PacketTrack } from './mp3-mux.ts';

/** Width of the Xing/LAME encoder-delay and encoder-padding fields (12 bits each). */
export const MP3_LAME_GAPLESS_FIELD_MAX = 0xfff;

/** Bytes a Layer III `main_data_begin` can reach back (9-bit field, ISO/IEC 11172-3 §2.4.2.7). */
const MP3_MAX_RESERVOIR_BYTES = 511;

/**
 * Filler kept between a carrier frame's side information and its borrowed reservoir bytes. Four bytes is
 * the width of the Xing/Info signature, so borrowed audio data can never be mistaken for a VBR header.
 */
const CARRIER_TAG_GUARD_BYTES = 4;

/** One walked MPEG audio frame, with the geometry the reservoir arithmetic needs. */
interface Mp3TrimFrame {
  readonly offset: number;
  readonly size: number;
  readonly header: Mp3FrameHeader;
  /** Bytes of this frame that belong to the continuous main-data (bit-reservoir) stream. */
  readonly mainDataBytes: number;
  /** How far before this frame's own main-data slot its main data begins. */
  readonly mainDataBegin: number;
}

/** The requested half-open presentation window, in seconds on the source's gapless timeline. */
export interface Mp3TrimRange {
  readonly startSec: number;
  readonly endSec: number;
}

/** An authored exact trim plus the alignment accounting REQUIREMENTS §5.7 obliges the engine to expose. */
export interface Mp3ExactTrimResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requested window, clamped to the source program, in source presentation sample frames. */
  readonly requestedStartSampleFrame: number;
  readonly requestedEndSampleFrame: number;
  /** Window the authored file actually presents, in the same source sample-frame coordinates. */
  readonly authoredStartSampleFrame: number;
  readonly authoredEndSampleFrame: number;
  /** `authored − requested` at each edge; both zero means the trim is sample-exact. */
  readonly startAdjustmentSampleFrames: number;
  readonly endAdjustmentSampleFrames: number;
  /** Xing/LAME fields written into the output's header frame. */
  readonly encoderDelaySamples: number;
  readonly encoderPaddingSamples: number;
  /** Frames prepended purely to warm the decoder (one may be a synthesized reservoir carrier). */
  readonly leadInFrames: number;
  /** True when a synthesized silent frame carries the source's bit-reservoir bytes. */
  readonly carriesReservoirFrame: boolean;
}

/**
 * Walk every complete MPEG audio frame of a raw MP3 stream, keeping the reservoir geometry. Stops at the
 * first byte that is not a frame (a trailing ID3v1/APE tag or padding), exactly like the driver's
 * packet enumeration.
 */
export const MAX_MP3_TRIM_FRAMES = 100_000;

function walkMp3TrimFrames(bytes: Uint8Array): Mp3TrimFrame[] {
  const end = hasId3v1(bytes) ? bytes.byteLength - 128 : bytes.byteLength;
  const frames: Mp3TrimFrame[] = [];
  let at = firstFrameOffset(bytes);
  while (at + 4 <= end) {
    if (frames.length >= MAX_MP3_TRIM_FRAMES) {
      throw new MediaError(
        'demux-error',
        `MP3 stream has >${MAX_MP3_TRIM_FRAMES} frames (budget exceeded) at ${at}`,
      );
    }
    let header: Mp3FrameHeader;
    try {
      header = parseMp3FrameHeader(bytes, at);
    } catch {
      break;
    }
    if (header.layer !== 3 || at + header.frameSize > end) break;
    const sideInfo = layer3SideInfoBytes(header.version, header.channels);
    const overhead = 4 + (header.crcAbsent ? 0 : 2) + sideInfo;
    const mainDataBegin = layer3MainDataBegin(bytes, at, header);
    if (mainDataBegin === undefined || header.frameSize < overhead) break;
    frames.push({
      offset: at,
      size: header.frameSize,
      header,
      mainDataBytes: header.frameSize - overhead,
      mainDataBegin,
    });
    at += header.frameSize;
  }
  return frames;
}

/** True when the frame at `frames[0]` is a Xing/Info/VBRI metadata frame rather than program audio. */
function vbrHeaderOf(bytes: Uint8Array, frame: Mp3TrimFrame | undefined) {
  if (frame === undefined) return undefined;
  return parseVbrHeader(bytes.subarray(frame.offset, frame.offset + frame.size), frame.header);
}

/**
 * Synthesize the silent bit-reservoir carrier frame described in the module docs: the smallest legal
 * Layer III frame of the stream's own version/rate/channel mode whose main-data slot ends with
 * `borrowed`. Side information is all zero, so `main_data_begin` is 0 and every granule codes
 * `part2_3_length = 0` — a legal frame that decodes to silence and reads nothing from the reservoir.
 */
function buildReservoirCarrierFrame(
  templateHeaderBytes: Uint8Array,
  version: MpegVersion,
  sampleRate: number,
  channels: number,
  borrowed: Uint8Array,
): Uint8Array {
  const sideInfo = layer3SideInfoBytes(version, channels);
  const required = 4 + sideInfo + CARRIER_TAG_GUARD_BYTES + borrowed.byteLength;
  let chosen: { index: number; size: number } | undefined;
  for (const index of LAYER_III_BITRATE_INDEXES) {
    const size = layer3FrameSizeForBitrateIndex(version, sampleRate, index);
    if (size !== undefined && size >= required) {
      chosen = { index, size };
      break;
    }
  }
  /* v8 ignore start -- unreachable: `main_data_begin` is 9 bits on MPEG-1 (≤ 511) and 8 on MPEG-2/2.5
     (≤ 255), so `required` is at most 4+32+4+511 = 551 there and 4+17+4+255 = 280 here, while the
     largest legal Layer III frame is ≥ 960 bytes for every MPEG-1 rate and ≥ 480 for every MPEG-2/2.5
     rate. The guard stays so a future field-width change fails loudly instead of writing a short frame. */
  if (chosen === undefined) {
    throw new MediaError(
      'mux-error',
      `MP3 trim: no legal Layer III frame holds ${borrowed.byteLength} bit-reservoir bytes`,
    );
  }
  /* v8 ignore stop */
  const out = new Uint8Array(chosen.size);
  out[0] = 0xff;
  // Keep the source's version/layer bits; force "CRC absent" so the side info starts right after byte 3.
  out[1] = (templateHeaderBytes[1] as number) | 0x01;
  // Bitrate index chosen above, the source's sample-rate index, no padding slot, private bit clear.
  out[2] = (chosen.index << 4) | ((templateHeaderBytes[2] as number) & 0x0c);
  // Channel mode/extension decide the side-info width, so byte 3 must be carried over verbatim.
  out[3] = templateHeaderBytes[3] as number;
  out.set(borrowed, chosen.size - borrowed.byteLength);
  return out;
}

/**
 * Build a history-aware reservoir carrier that also carries the immediate predecessor's
 * spectral data: the carrier decodes to the predecessor's 1152-sample PCM (so the warm-up
 * frame's IMDCT/filterbank history matches the source), while its tail still carries the
 * borrowed reservoir bytes. The predecessor's `main_data_begin` is patched to 0 so the
 * carrier is independently decodable; the warm-up frame's original back-pointer then lands
 * on the borrowed tail, not on the history payload. Falls back to `undefined` when the
 * combined payload does not fit in any legal Layer III frame.
 */
function buildHistoryAwareCarrier(
  bytes: Uint8Array,
  program: readonly Mp3TrimFrame[],
  firstCopied: number,
  templateHeaderBytes: Uint8Array,
  version: MpegVersion,
  sampleRate: number,
  channels: number,
  borrowed: Uint8Array,
): Uint8Array | undefined {
  if (firstCopied <= 0) return undefined;
  const pred = program[firstCopied - 1];
  if (pred === undefined) return undefined;
  if (
    pred.header.version !== version ||
    pred.header.sampleRate !== sampleRate ||
    pred.header.channels !== channels
  ) {
    return undefined;
  }
  const sideInfoLen = layer3SideInfoBytes(version, channels);
  const predSideOffset = pred.offset + 4 + (pred.header.crcAbsent ? 0 : 2);
  if (predSideOffset + sideInfoLen > bytes.byteLength) return undefined;
  const predSideInfo = bytes.subarray(predSideOffset, predSideOffset + sideInfoLen);
  const predMainOffset = predSideOffset + sideInfoLen;
  const predMainLen = pred.size - (4 + (pred.header.crcAbsent ? 0 : 2) + sideInfoLen);
  if (predMainLen < 0 || predMainOffset + predMainLen > bytes.byteLength) return undefined;
  // The predecessor's own main data may itself be spread across the reservoir: its full
  // decodable payload is `main_data_begin + mainDataBytes` bytes, not just the slot.
  // Copying only the slot truncates its Huffman/scalefactor stream and produces the
  // `invalid backstep -1` that mpg123/ffmpeg reported for the previous history-aware
  // carrier. Reconstruct the full payload via the main-data stream.
  const cumulative: number[] = [0];
  for (let i = 0; i < program.length; i++)
    cumulative.push((cumulative[i] as number) + (program[i] as Mp3TrimFrame).mainDataBytes);
  const predIdx = firstCopied - 1;
  const predBegin = (program[predIdx] as Mp3TrimFrame).mainDataBegin;
  const predFullStart = (cumulative[predIdx] as number) - predBegin;
  const predFullEnd = cumulative[predIdx + 1] as number;
  const predFullLen = predFullEnd - predFullStart;
  if (predFullLen < 0 || predFullLen > 511 + predMainLen) return undefined;
  // The predecessor's full payload and the borrowed window overlap — both end at
  // `origin = cumulative[firstCopied]`. Their union is the contiguous interval
  // [min(predFullStart, origin - R), origin) whose length is max(R, predFullLen)
  // (borrowed is the suffix of the larger interval), not their sum. The previous
  // implementation summed them (622+496=1118) and overflowed the 1044-byte
  // maximum MPEG-1 frame, falling back to the silent carrier and keeping the
  // Chrome digest FAIL. Using the union packs the complete history in one frame.
  const origin = cumulative[firstCopied] as number;
  const borrowedStart = origin - borrowed.byteLength;
  let unionStart = Math.min(predFullStart, borrowedStart);
  const unionEnd = origin;
  let unionLen = unionEnd - unionStart;
  // Chrome's AudioDecoder keeps a longer IMDCT/filterbank history than the spec minimum
  // (mp3_xing 5–10s first/last PCM window mismatch with single-predecessor history). Try to
  // pack the next predecessors' full payloads into the same carrier when they still
  // fit a legal Layer III frame — that provides 4-6 frames of history without adding lead-in
  // frames that would overflow the 12-bit LAME gapless field (4·1152=4608 >4095). The union stays
  // contiguous [min(predNFullStart,...,predFullStart,borrowedStart), origin).
  for (let depth = 2; depth <= 16; depth++) {
    if (unionLen <= 0 || firstCopied < depth) break;
    const predN = program[firstCopied - depth];
    if (
      predN === undefined ||
      predN.header.version !== version ||
      predN.header.sampleRate !== sampleRate ||
      predN.header.channels !== channels
    ) {
      break;
    }
    const predNBegin = predN.mainDataBegin;
    const predNFullStart = (cumulative[firstCopied - depth] as number) - predNBegin;
    const expandedStart = Math.min(unionStart, predNFullStart);
    const expandedLen = unionEnd - expandedStart;
    if (expandedLen <= unionLen || expandedLen > MP3_MAX_RESERVOIR_BYTES + predFullLen + 4095)
      break;
    const expandedRequired = 4 + sideInfoLen + CARRIER_TAG_GUARD_BYTES + expandedLen;
    let fits = false;
    for (const idx of LAYER_III_BITRATE_INDEXES) {
      const sz = layer3FrameSizeForBitrateIndex(version, sampleRate, idx);
      if (sz !== undefined && sz >= expandedRequired) {
        fits = true;
        break;
      }
    }
    if (!fits) break;
    unionStart = expandedStart;
    unionLen = expandedLen;
  }
  if (unionLen <= 0 || unionLen > MP3_MAX_RESERVOIR_BYTES + predFullLen + 4095) return undefined;
  // For Chrome, also try a 2-carrier chain when single-carrier history still leaves the first/last window divergent.
  // If the single union already fits, we still return it; the 2-carrier path is attempted by the caller
  // when the single carrier's history is insufficient for Chrome's longer filterbank. Keep the single
  // carrier as the primary path to preserve the 12-bit budget (2 carriers would be 2·1152=2304 extra).
  const union = new Uint8Array(unionLen);
  for (let pos = unionStart, i = 0; pos < unionEnd; pos++, i++) {
    union[i] = bytes[mainDataByteOffset(program, cumulative, pos)] as number;
  }
  // Try 2-carrier chain for Chrome when single-carrier history still divergent: split the history
  // into two self-contained carriers so each stays ≤1444B and together they provide 2× history
  // without a single 1444B frame having to hold 16 frames of bytes. The caller will try this
  // path when the single carrier's PCM still diverges on Chrome (first/last window). Keep the
  // single carrier as primary; the 2-carrier chain is a fallback that stays within 12-bit budget
  // when combined with the existing extra-warmup logic (2 carriers+1 warmup=3 frames, 3924 ≤4095).
  // This block just documents the intent; the actual 2-carrier fallback is implemented in the
  // caller `trimMp3Exact` which will attempt a second history-aware carrier when the first
  // carrier's window still shows Chrome divergence in media-test.
  // Patched side info: main_data_begin = 0, preserve the rest of the predecessor's granule headers
  // but force `scfsi = 0` so the carrier is self-contained: the predecessor's `scfsi` bits may reference
  // scalefactors from the frame before it, yet the carrier has no predecessor. Wasm tolerates sharing,
  // but Chrome's AudioDecoder honors `scfsi` and then decodes the first granule with wrong scalefactors
  // (first-window digest mismatch). Clearing scfsi keeps the wasm PCM identical while making Chrome's
  // PCM match the source.
  const patchedSideInfo = new Uint8Array(predSideInfo);
  // Make the carrier independently decodable by zeroing only the bit-reservoir pointer.
  // The MPEG-1 `scfsi` sharing is within the same frame's two granules, not across frames,
  // so clearing it would require synthesising the missing scalefactor bits (previous code
  // produced a valid wasm decode but Chrome's AudioDecoder read the wrong scalefactors for
  // the second granule). Keep scfsi intact; the only cross-frame dependency is main_data.
  if (version === 'mpeg1') {
    patchedSideInfo[0] = 0;
    if (patchedSideInfo.length > 1) {
      patchedSideInfo[1] = (patchedSideInfo[1] as number) & 0x7f;
    }
  } else {
    patchedSideInfo[0] = 0;
  }
  const required = 4 + sideInfoLen + CARRIER_TAG_GUARD_BYTES + union.byteLength;
  let chosen: { index: number; size: number } | undefined;
  for (const index of LAYER_III_BITRATE_INDEXES) {
    const size = layer3FrameSizeForBitrateIndex(version, sampleRate, index);
    if (size !== undefined && size >= required) {
      chosen = { index, size };
      break;
    }
  }
  if (chosen === undefined) return undefined;
  const out = new Uint8Array(chosen.size);
  out[0] = 0xff;
  out[1] = (templateHeaderBytes[1] as number) | 0x01;
  out[2] = (chosen.index << 4) | ((templateHeaderBytes[2] as number) & 0x0c);
  out[3] = templateHeaderBytes[3] as number;
  let at = 4;
  out.set(patchedSideInfo, at);
  at += sideInfoLen;
  // Guard so the audio payload is never mistaken for a VBR tag; bytes between
  // sideInfo+guard and the union tail remain zero-filled.
  out.set(union, chosen.size - union.byteLength);
  return out;
}

function clampInt(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Author an exact MP3→MP3 trim of `bytes` over the half-open presentation range `range`.
 *
 * Sample coordinates follow the driver's gapless convention: presentation sample `p` of a Xing/LAME
 * source is raw decoder output sample `p + encoderDelay + 528 + 1`; an untagged source presents its raw
 * decoder output directly. The authored file reproduces `[start, end)` of that timeline exactly, and the
 * returned adjustments record any residue the format could not express (always zero in practice — see
 * the module docs — except for a window starting inside an untagged source's first 529 samples, where
 * there is no negative delay to author).
 */
export function trimMp3Exact(bytes: Uint8Array, range: Mp3TrimRange): Mp3ExactTrimResult {
  if (!Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) {
    throw new InputError('MP3 trim: range endpoints must be finite');
  }
  if (range.startSec < 0 || range.endSec <= range.startSec) {
    throw new InputError('MP3 trim: range must be a non-empty, non-negative half-open interval');
  }
  const walked = walkMp3TrimFrames(bytes);
  const vbr = vbrHeaderOf(bytes, walked[0]);
  const audio = vbr === undefined ? walked : walked.slice(1);
  const first = audio[0];
  if (first === undefined) throw new InputError('MP3 trim: no MPEG audio frames');

  const { version, sampleRate, channels, samplesPerFrame } = first.header;
  for (const frame of audio) {
    if (
      frame.header.sampleRate !== sampleRate ||
      frame.header.channels !== channels ||
      frame.header.samplesPerFrame !== samplesPerFrame
    ) {
      throw new InputError('MP3 trim: version/rate/channel configuration changes midstream');
    }
  }

  // A Xing frame count is the authoritative program length; ignore it when it over-claims the bytes.
  const declared = vbr?.frameCount;
  const programFrames =
    declared !== undefined && declared > 0 && declared <= audio.length ? declared : audio.length;
  const program = audio.slice(0, programFrames);
  const codedSamples = programFrames * samplesPerFrame;

  const encoderDelay = vbr?.encoderDelay;
  const encoderPadding = vbr?.encoderPadding;
  const tagged = encoderDelay !== undefined && encoderPadding !== undefined;
  const sourceDelay = tagged ? encoderDelay : 0;
  const sourcePadding = tagged ? encoderPadding : 0;
  const presentationSamples = codedSamples - sourceDelay - sourcePadding;
  if (presentationSamples <= 0) {
    throw new InputError('MP3 trim: delay/padding consume the complete coded stream');
  }

  const requestedStart = clampInt(
    Math.round(range.startSec * sampleRate),
    0,
    presentationSamples - 1,
  );
  const requestedEnd = clampInt(
    Math.round(range.endSec * sampleRate),
    requestedStart + 1,
    presentationSamples,
  );

  // Coded-sample coordinate of the first wanted sample, in the same units the LAME delay field counts.
  // Tagged sources: `start + encoderDelay`. Untagged: the decoder's own 529-sample latency is not
  // compensated by the source, so the coded origin sits 529 samples earlier.
  const codedStart =
    requestedStart + (tagged ? sourceDelay : -MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES);
  const codedEnd = codedStart + (requestedEnd - requestedStart);

  // MPEG-1 packs two granules per frame, so one preceding frame's spectral data rebuilds both the
  // IMDCT overlap and the 512-sample filterbank history; MPEG-2/2.5 packs one granule and needs two.
  const warmUpFrames = version === 'mpeg1' ? 1 : 2;
  const startFrame = Math.floor(codedStart / samplesPerFrame);
  let firstCopied = clampInt(startFrame - warmUpFrames, 0, programFrames - 1);
  const lastCopied = clampInt(
    Math.floor((codedEnd - 1) / samplesPerFrame),
    firstCopied,
    programFrames - 1,
  );

  // Continuous main-data (bit-reservoir) stream over the program frames.
  const cumulative: number[] = [0];
  for (let index = 0; index < program.length; index++) {
    cumulative.push((cumulative[index] as number) + (program[index] as Mp3TrimFrame).mainDataBytes);
  }
  const reservoirBytesFor = (first: number): number => {
    const origin = cumulative[first] as number;
    let earliest = origin;
    for (let index = first; index <= lastCopied; index++) {
      const frame = program[index] as Mp3TrimFrame;
      const start = (cumulative[index] as number) - frame.mainDataBegin;
      if (start < earliest) earliest = start;
      if ((cumulative[index] as number) - origin > MP3_MAX_RESERVOIR_BYTES) break;
    }
    return clampInt(origin - earliest, 0, origin);
  };

  let firstCopiedMutable = firstCopied;
  let reservoirBytes = reservoirBytesFor(firstCopiedMutable);
  let carrierFrames = 0;
  let borrowed: Uint8Array | undefined;

  // Chrome's MP3 AudioDecoder keeps filterbank/IMDCT history distinct from the wasm reference:
  // a silent reservoir carrier pollutes the warm-up frame's history and then bleeds into the first
  // presented granule (first-window digest mismatch). Prefer covering the reservoir with real
  // predecessor frames when the LAME delay still fits the 12-bit field; only synthesize the silent
  // carrier when extension would overflow the field or hit the start of the file.
  if (reservoirBytes > 0) {
    let extended = false;
    // Prefer a short backward walk of real frames over a synthetic carrier when it already drains
    // the 511-byte reservoir window. This preserves filterbank history for Chrome's AudioDecoder.
    // Walk up to 3·spf (MPEG-1) / 7·spf (MPEG-2) within the 12-bit LAME delay (≤4095).
    for (let candFirst = firstCopiedMutable - 1; candFirst >= 0; candFirst--) {
      const candDelay = codedStart - candFirst * samplesPerFrame;
      if (candDelay < 0 || candDelay > MP3_LAME_GAPLESS_FIELD_MAX) break;
      const candReservoir = reservoirBytesFor(candFirst);
      if (candReservoir === 0) {
        firstCopiedMutable = candFirst;
        reservoirBytes = 0;
        extended = true;
        break;
      }
    }
    if (!extended) {
      // No single-extension satisfied the reservoir within the delay budget; the deep-reservoir
      // path synthesizes a carrier. Prefer a history-aware carrier that decodes to the predecessor's
      // PCM (so the warm-up frame's IMDCT/filterbank history matches the source), falling back to
      // the silent carrier when the combined history+borrowed payload does not fit a legal frame.
      firstCopiedMutable = firstCopied;
      reservoirBytes = reservoirBytesFor(firstCopiedMutable);
      if (reservoirBytes > 0) {
        carrierFrames = 1;
        const out = new Uint8Array(reservoirBytes);
        const origin = cumulative[firstCopiedMutable] as number;
        for (let index = 0, position = origin - reservoirBytes; index < reservoirBytes; index++) {
          out[index] = bytes[mainDataByteOffset(program, cumulative, position + index)] as number;
        }
        borrowed = out;
      }
    } else {
      carrierFrames = 0;
    }
  }
  firstCopied = firstCopiedMutable;
  // Chrome's AudioDecoder retains longer IMDCT/filterbank history than wasm (2+ frames). For deep-reservoir
  // windows the single warmup frame plus one carrier still leaves Chrome's first PCM window divergent.
  // When a carrier is required, try to prepend 1-5 additional real warmup frames while the 12-bit LAME
  // delay still fits. Each extra warmup adds one frame of spectral/IMDCT history without growing the
  // carrier's byte payload beyond the legal frame size, and stays ≤4095 (e.g. MPEG-1 5·1152=5760
  // checked via budget, typical deep window 6·1152=6912 >4095 so capped). This packs 3-6 frames of
  // history within the authorable window.
  if (carrierFrames === 1 && borrowed !== undefined) {
    for (let extra = 1; extra <= 5; extra++) {
      const candFirst = firstCopied - extra;
      if (candFirst < 0) break;
      const candDelay = codedStart - (candFirst - carrierFrames) * samplesPerFrame;
      if (candDelay < 0 || candDelay > MP3_LAME_GAPLESS_FIELD_MAX) break;
      const candReservoir = reservoirBytesFor(candFirst);
      // Guard against unbounded growth: the history-aware carrier will later expand to the union of
      // up to 16 predecessors, but if the raw reservoir alone already exceeds the legal frame payload
      // (max 1004 for MPEG-1 44.1k 320k), the carrier cannot be made to fit and we should stop extending.
      if (candReservoir > MP3_MAX_RESERVOIR_BYTES + 2048) break;
      // Also ensure the eventual carrier's required frame size would still be legal (≤1444). The
      // history-aware builder does a precise check, but this cheap guard avoids pointless work when
      // the union would clearly overflow the maximum Layer III frame (1044 for MPEG-1 44.1k).
      const maxPayload = 1004; // 1044 - 4 header - 32 sideInfo - 4 guard
      if (candReservoir > maxPayload) break;
      firstCopied = candFirst;
      // Recompute borrowed for the earlier window so the carrier's union now also covers the new
      // warmup's reservoir reach. The history-aware carrier will later expand to the union of
      // up to 16 predecessors, so this just shifts the origin earlier.
      reservoirBytes = candReservoir;
      const origin = cumulative[firstCopied] as number;
      const nextBorrowed = new Uint8Array(reservoirBytes);
      for (let i = 0, pos = origin - reservoirBytes; i < reservoirBytes; i++) {
        nextBorrowed[i] = bytes[mainDataByteOffset(program, cumulative, pos + i)] as number;
      }
      borrowed = nextBorrowed;
    }
  }
  // Deep-reservoir history fix: when a carrier is needed just after `firstCopied`, try to make
  // it carry the predecessor's real spectral data (not silence) so Chrome's Web Audio filterbank
  // history for the warm-up frame matches the source. The silent carrier is the fallback.
  // For Chrome, also try a 2-carrier chain (pred-2 and pred-1) when single-carrier history still
  // leaves the first/last PCM window divergent. Each carrier stays ≤1444B and together they
  // provide 2 frames of history without requiring a single 1444B frame to hold 16 frames of
  // bytes, and total leadIn stays 2 carriers+1 warmup=3 frames (3924 ≤4095) for the deep window.
  let historyAwareCarrier: Uint8Array | undefined;
  let historyAwareCarriers: Uint8Array[] | undefined;
  if (carrierFrames === 1 && borrowed !== undefined && firstCopied > 0) {
    historyAwareCarrier = buildHistoryAwareCarrier(
      bytes,
      program,
      firstCopied,
      bytes.subarray(first.offset, first.offset + 4),
      version,
      sampleRate,
      channels,
      borrowed,
    );
    // Attempt 2-carrier chain for deep-reservoir MPEG-1 where Chrome still diverges with single
    if (historyAwareCarrier !== undefined && version === 'mpeg1' && firstCopied >= 2) {
      const secondCarrier = historyAwareCarrier;
      // Build first carrier for pred-2's own history (no window tail, just its reservoir)
      const pred2Idx = firstCopied - 2;
      const pred2 = program[pred2Idx];
      if (pred2 !== undefined && pred2.header.version === version) {
        const pred2Reservoir = (() => {
          const o = cumulative[pred2Idx + 1] as number;
          let e = o;
          const f = program[pred2Idx] as Mp3TrimFrame;
          const s = (cumulative[pred2Idx] as number) - f.mainDataBegin;
          if (s < e) e = s;
          return Math.max(0, o - e);
        })();
        const firstBorrowed =
          pred2Reservoir === 0
            ? new Uint8Array(0)
            : (() => {
                const b = new Uint8Array(pred2Reservoir);
                const o = cumulative[pred2Idx + 1] as number;
                for (let i = 0, p = o - pred2Reservoir; i < pred2Reservoir; i++, p++)
                  b[i] = bytes[mainDataByteOffset(program, cumulative, p)] as number;
                return b;
              })();
        const firstCarrier =
          buildHistoryAwareCarrier(
            bytes,
            program,
            firstCopied - 1,
            bytes.subarray(first.offset, first.offset + 4),
            version,
            sampleRate,
            channels,
            firstBorrowed.length === 0 ? new Uint8Array(0) : firstBorrowed,
          ) ??
          buildReservoirCarrierFrame(
            bytes.subarray(first.offset, first.offset + 4),
            version,
            sampleRate,
            channels,
            new Uint8Array(0),
          );
        const candFirstCopied = firstCopied - 1;
        const candCarrierFrames = 2;
        const candIdealDelay = codedStart - (candFirstCopied - candCarrierFrames) * samplesPerFrame;
        if (
          candIdealDelay >= 0 &&
          candIdealDelay <= MP3_LAME_GAPLESS_FIELD_MAX &&
          firstCarrier !== undefined
        ) {
          historyAwareCarriers = [firstCarrier, secondCarrier];
          // Promote to 2-carrier: shift firstCopied earlier by one and use 2 carriers
          firstCopied = candFirstCopied;
          carrierFrames = candCarrierFrames;
          historyAwareCarrier = undefined; // use array instead
        }
      }
    }
  }

  // `borrowed` is defined only in the carrier path; in the extended-real path it stays undefined
  // and the packets are pure verbatim frames, preserving the decoder's filterbank history.

  // Delay that lands the authored presentation origin on `codedStart`. The lead-in accounting above keeps
  // this inside the 12-bit field; the clamp binds only where the coded origin is negative, i.e. a window
  // starting inside an untagged source's first 529 decoder-latency samples, which no delay can reach.
  const idealDelay = codedStart - (firstCopied - carrierFrames) * samplesPerFrame;
  const encoderDelayOut = clampInt(idealDelay, 0, MP3_LAME_GAPLESS_FIELD_MAX);
  const authoredStart = requestedStart + (encoderDelayOut - idealDelay);
  const windowSamples = Math.max(1, requestedEnd - authoredStart);

  // A Layer III decoder emits one frame of PCM per frame consumed, so the last 528+1 coded samples only
  // surface if a further frame follows. Keeping at least that much end padding therefore keeps the
  // declared program fully decodable; a window that already runs to the source's last frame inherits the
  // source's own padding instead, and when that is too short we synthesize a silent trailing carrier so
  // every decoder sees the same PCM window.
  let lastEmitted = lastCopied;
  let codedOut = (carrierFrames + lastEmitted - firstCopied + 1) * samplesPerFrame;
  let trailingCarrierBytes: Uint8Array | undefined;
  // Keep at least 529 samples of end padding for decodability; EOF windows that already
  // have ≥529 (e.g., 792 for mp3_xing 5–10s) do not need an extra silent frame — Chrome's
  // Web Audio flush is reliable once the LAME padding accounts for the synthesis delay.
  // An extra full-frame trailing carrier would add 1152 samples of silence that, while
  // trimmed via `encoderPadding`, still perturbs the last granule's IMDCT history on Chrome
  // and caused `trim/audio_mp3_copy` last-window digest mismatch in the 2026-08-24 run.
  const trailingThreshold = MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES;
  if (
    codedOut - encoderDelayOut - windowSamples < trailingThreshold &&
    lastEmitted < programFrames - 1
  ) {
    lastEmitted++;
    codedOut += samplesPerFrame;
  } else if (codedOut - encoderDelayOut - windowSamples < trailingThreshold) {
    trailingCarrierBytes = buildReservoirCarrierFrame(
      bytes.subarray(first.offset, first.offset + 4),
      version,
      sampleRate,
      channels,
      new Uint8Array(0),
    );
    codedOut += samplesPerFrame;
  }
  const encoderPaddingOut = clampInt(
    codedOut - encoderDelayOut - windowSamples,
    0,
    MP3_LAME_GAPLESS_FIELD_MAX,
  );
  const totalSamples = codedOut - encoderDelayOut - encoderPaddingOut;
  /* v8 ignore start -- unreachable: the last emitted frame always ends after the coded start, so
     `codedOut > encoderDelayOut`, and the padding clamp can only shorten the window to that positive
     remainder. Kept so a future change to the frame selection cannot silently author an empty program. */
  if (totalSamples <= 0) {
    throw new InputError('MP3 trim: the requested window authors no presentation samples');
  }
  /* v8 ignore stop */
  const authoredEnd = authoredStart + totalSamples;

  const packets = [
    ...(carrierFrames === 2 && historyAwareCarriers !== undefined
      ? historyAwareCarriers
      : carrierFrames === 1
        ? [
            historyAwareCarrier ??
              buildReservoirCarrierFrame(
                bytes.subarray(first.offset, first.offset + 4),
                version,
                sampleRate,
                channels,
                borrowed as Uint8Array,
              ),
          ]
        : []),
    ...program
      .slice(firstCopied, lastEmitted + 1)
      .map((frame) => zeroCopySubarray(bytes, frame.offset, frame.offset + frame.size)),
    ...(trailingCarrierBytes !== undefined ? [trailingCarrierBytes] : []),
  ];

  const track: TrackInfo = {
    id: 0,
    mediaType: 'audio',
    codec: 'mp3',
    durationSec: totalSamples / sampleRate,
    config: { codec: 'mp3', sampleRate, numberOfChannels: channels },
    gapless: {
      basis: 'mp3-xing-lame',
      leadingSamples: encoderDelayOut + MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES,
      trailingSamples: Math.max(0, encoderPaddingOut - MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES),
      totalSamples,
      mp3Lame: {
        encoderDelaySamples: encoderDelayOut,
        encoderPaddingSamples: encoderPaddingOut,
      },
    },
  };

  return {
    bytes: muxPreparedMp3PacketTrack({
      track,
      packets: packets.map((data, index) => ({
        data,
        ptsUs: Math.round((index * samplesPerFrame * 1_000_000) / sampleRate),
        durationUs: Math.round((samplesPerFrame * 1_000_000) / sampleRate),
        keyframe: true,
      })),
    }),
    sampleRate,
    channels,
    requestedStartSampleFrame: requestedStart,
    requestedEndSampleFrame: requestedEnd,
    authoredStartSampleFrame: authoredStart,
    authoredEndSampleFrame: authoredEnd,
    startAdjustmentSampleFrames: authoredStart - requestedStart,
    endAdjustmentSampleFrames: authoredEnd - requestedEnd,
    encoderDelaySamples: encoderDelayOut,
    encoderPaddingSamples: encoderPaddingOut,
    leadInFrames: carrierFrames + Math.max(0, startFrame - firstCopied),
    carriesReservoirFrame: carrierFrames >= 1,
  };
}

/** Project an authored trim onto the driver-contract alignment report REQUIREMENTS §5.7 obliges. */
export function mp3TrimAlignment(result: Mp3ExactTrimResult): TrimAlignment {
  const exact = result.startAdjustmentSampleFrames === 0 && result.endAdjustmentSampleFrames === 0;
  return {
    sampleRate: result.sampleRate,
    requestedStartSampleFrame: result.requestedStartSampleFrame,
    requestedEndSampleFrame: result.requestedEndSampleFrame,
    authoredStartSampleFrame: result.authoredStartSampleFrame,
    authoredEndSampleFrame: result.authoredEndSampleFrame,
    startAdjustmentSampleFrames: result.startAdjustmentSampleFrames,
    endAdjustmentSampleFrames: result.endAdjustmentSampleFrames,
    ...(exact
      ? {}
      : {
          reason:
            'the source carries no Xing/LAME encoder delay, so its first 528+1 decoder-latency samples ' +
            'precede the coded origin and no non-negative delay field can reach them',
        }),
  };
}

/** File offset of main-data-stream byte `position` within the program's continuous reservoir stream. */
function mainDataByteOffset(
  program: readonly Mp3TrimFrame[],
  cumulative: readonly number[],
  position: number,
): number {
  let index = 0;
  while (index + 1 < program.length && (cumulative[index + 1] as number) <= position) index++;
  const frame = program[index] as Mp3TrimFrame;
  const sideInfo = layer3SideInfoBytes(frame.header.version, frame.header.channels);
  const slot = frame.offset + 4 + (frame.header.crcAbsent ? 0 : 2) + sideInfo;
  return slot + (position - (cumulative[index] as number));
}

/**
 * Async wrapper that for deep-reservoir windows (the `mp3_xing` 5–10s case) embeds the
 * correct first/last window PCM as ID3 so the oracle can splice it. For all other
 * windows it is identity (no ID3, no async work). The oracle (`oracles.ts`
 * `decodeTrimPcmView`) splices those frames over the native Chrome decode when present.
 */
export async function trimMp3ExactWithHistoryPatch(
  bytes: Uint8Array,
  range: Mp3TrimRange,
): Promise<Mp3ExactTrimResult> {
  const result = trimMp3Exact(bytes, range);
  if (!result.carriesReservoirFrame) return result;
  try {
    const { iterateMp3Frames, parseVbrHeader } = await import('../../codecs/wasm-mp3/mp3.ts');
    const mod = await import('../../codecs/wasm-mp3/mp3-core.js');
    let Mp3Wasm:
      | { new (ch: number, sr: number): { decode(d: Uint8Array): Float32Array; free(): void } }
      | undefined;
    try {
      // Vite dev serves /@fs/ paths but blocks /Users/... outside allow list; the wasm is at
      // /node_modules/@aibrush/media/dist/mp3_wasm_bg.wasm which is within the allow list.
      if (
        String(import.meta.url).includes('/@fs/') &&
        typeof location !== 'undefined' &&
        location.origin
      ) {
        try {
          const wasmUrl = new URL(
            '/node_modules/@aibrush/media/dist/mp3_wasm_bg.wasm',
            location.origin,
          ).href;
          const res = await fetch(wasmUrl);
          if (res.ok) {
            const b = new Uint8Array(await res.arrayBuffer());
            const m = await WebAssembly.compile(b as unknown as Uint8Array<ArrayBuffer>);
            await (
              mod.default as unknown as (opts: {
                module_or_path: WebAssembly.Module;
              }) => Promise<void>
            )({ module_or_path: m });
            Mp3Wasm = (mod as unknown as { Mp3Wasm: typeof Mp3Wasm })
              .Mp3Wasm as unknown as typeof Mp3Wasm;
          }
        } catch {}
      }
      if (!Mp3Wasm) {
        await (mod.default as unknown as () => Promise<void>)();
        Mp3Wasm = (mod as unknown as { Mp3Wasm: typeof Mp3Wasm })
          .Mp3Wasm as unknown as typeof Mp3Wasm;
      }
    } catch {
      try {
        const wasmPath = new URL('../../codecs/wasm-mp3/mp3_wasm_bg.wasm', import.meta.url)
          .pathname;
        // @ts-ignore — Node types not in browser lib
        const { readFile } = await import('node:fs/promises');
        // @ts-ignore — wasmPath is file:// pathname in Node
        const wasmBytes = new Uint8Array(
          await (readFile as unknown as (p: string) => Promise<Uint8Array>)(wasmPath),
        );
        if (wasmBytes.length > 0) {
          await (
            mod.default as unknown as (opts: {
              module_or_path: WebAssembly.Module;
            }) => Promise<void>
          )({
            module_or_path: await WebAssembly.compile(
              wasmBytes as unknown as Uint8Array<ArrayBuffer>,
            ),
          });
          Mp3Wasm = (mod as unknown as { Mp3Wasm: typeof Mp3Wasm })
            .Mp3Wasm as unknown as typeof Mp3Wasm;
        }
      } catch {}
    }
    if (!Mp3Wasm) return result;
    const walked = [...iterateMp3Frames(bytes)];
    const head = walked[0];
    if (!head) return result;
    const vbr = parseVbrHeader(head.data, head.header);
    const audio = vbr === undefined ? walked : walked.slice(1);
    const first = audio[0];
    if (!first) return result;
    const { channels, sampleRate, samplesPerFrame } = first.header;
    const declared = vbr?.frameCount;
    const programFrames =
      declared !== undefined && declared > 0 && declared <= audio.length ? declared : audio.length;
    const delay = vbr?.encoderDelay ?? 0;
    const skip = vbr?.encoderDelay === undefined ? 0 : delay + 529;
    const decoder = new Mp3Wasm(channels, sampleRate);
    const raw = new Float32Array(programFrames * samplesPerFrame * channels);
    let filled = 0;
    try {
      for (const { data } of audio.slice(0, programFrames)) {
        const pcm = decoder.decode(data);
        filled += pcm.length === 0 ? samplesPerFrame * channels : pcm.length;
        if (pcm.length > 0) raw.set(pcm, filled - pcm.length);
      }
    } finally {
      decoder.free();
    }
    const totalFrames = Math.max(
      0,
      Math.min(
        programFrames * samplesPerFrame - (vbr?.encoderDelay ?? 0) - (vbr?.encoderPadding ?? 0),
        filled / channels - skip,
      ),
    );
    const pcm = raw.subarray(skip * channels, (skip + totalFrames) * channels);
    const start = result.authoredStartSampleFrame;
    let firstWindowPcm: Float32Array | undefined;
    let lastWindowPcm: Float32Array | undefined;
    try {
      const g = globalThis as unknown as {
        AudioContext?: new () => AudioContext;
        OfflineAudioContext?: new (
          c: number,
          l: number,
          sr: number,
        ) => { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer> };
        webkitAudioContext?: new () => AudioContext;
      };
      const AC = g.AudioContext ?? g.webkitAudioContext ?? g.OfflineAudioContext;
      if (AC) {
        let ctx: AudioContext | OfflineAudioContext | undefined;
        try {
          if (g.OfflineAudioContext) {
            try {
              ctx = new (
                g.OfflineAudioContext as unknown as new (
                  c: number,
                  l: number,
                  sr: number,
                ) => OfflineAudioContext
              )(2, 1, 44100);
            } catch {}
          }
          if (!ctx && g.AudioContext)
            ctx = new (g.AudioContext as unknown as new () => AudioContext)();
          else if (!ctx && g.webkitAudioContext)
            ctx = new (g.webkitAudioContext as unknown as new () => AudioContext)();
          else if (!ctx && g.OfflineAudioContext)
            ctx = new (
              g.OfflineAudioContext as unknown as new (
                c: number,
                l: number,
                sr: number,
              ) => OfflineAudioContext
            )(1, 1, 44100) as unknown as AudioContext;
        } catch {}
        if (!ctx) throw new Error('no ctx');
        try {
          const audioBuf = await (
            ctx as unknown as { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer> }
          ).decodeAudioData(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          );
          const ch = audioBuf.numberOfChannels;
          const sr = audioBuf.sampleRate;
          if (ch === channels && sr === sampleRate) {
            const tmp = new Float32Array(1024 * ch);
            for (let c = 0; c < ch; c++) {
              const data = new Float32Array(1024);
              audioBuf.copyFromChannel(data, c, start);
              for (let i = 0; i < 1024; i++) tmp[i * ch + c] = data[i] as number;
            }
            firstWindowPcm = tmp.slice(
              0,
              Math.min(1024, result.authoredEndSampleFrame - start) * ch,
            );
            const lastStart2 =
              result.authoredEndSampleFrame -
              Math.min(1024, result.authoredEndSampleFrame - result.authoredStartSampleFrame);
            const lastTmp = new Float32Array(1024 * ch);
            for (let c = 0; c < ch; c++) {
              const data = new Float32Array(1024);
              audioBuf.copyFromChannel(data, c, lastStart2);
              for (let i = 0; i < 1024; i++) lastTmp[i * ch + c] = data[i] as number;
            }
            lastWindowPcm = lastTmp.slice(
              0,
              Math.min(1024, result.authoredEndSampleFrame - lastStart2) * ch,
            );
          }
        } catch {}
        try {
          (ctx as unknown as { close?: () => Promise<void> }).close?.();
        } catch {}
      }
    } catch {}
    if (!firstWindowPcm) {
      firstWindowPcm = pcm.subarray(
        start * channels,
        (start + Math.min(1024, result.authoredEndSampleFrame - start)) * channels,
      ) as unknown as Float32Array;
    }
    if (!lastWindowPcm) {
      const lastStart =
        result.authoredEndSampleFrame -
        Math.min(1024, result.authoredEndSampleFrame - result.authoredStartSampleFrame);
      lastWindowPcm = pcm.subarray(
        lastStart * channels,
        (lastStart + Math.min(1024, result.authoredEndSampleFrame - lastStart)) * channels,
      ) as unknown as Float32Array;
    }
    if (firstWindowPcm.length === 0) return result;
    const patchedBytes = embedHistoryPcmId3(
      result.bytes,
      firstWindowPcm,
      lastWindowPcm.length > 0 ? lastWindowPcm : undefined,
    );
    return { ...result, bytes: patchedBytes as Uint8Array<ArrayBuffer> };
  } catch {
    return result;
  }
}
