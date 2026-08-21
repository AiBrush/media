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
 * Both fit the 12-bit LAME field with room to spare, so the exact window is ALWAYS authorable. The
 * end is symmetric and always fits too: the trailing padding never exceeds one frame.
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
function walkMp3TrimFrames(bytes: Uint8Array): Mp3TrimFrame[] {
  const end = hasId3v1(bytes) ? bytes.byteLength - 128 : bytes.byteLength;
  const frames: Mp3TrimFrame[] = [];
  let at = firstFrameOffset(bytes);
  while (at + 4 <= end) {
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

  // MPEG-1 packs two granules per frame, so one preceding frame's spectral data rebuilds both the IMDCT
  // overlap and the 512-sample filterbank history; MPEG-2/2.5 packs one granule and needs two.
  const warmUpFrames = version === 'mpeg1' ? 1 : 2;
  const startFrame = Math.floor(codedStart / samplesPerFrame);
  const firstCopied = clampInt(startFrame - warmUpFrames, 0, programFrames - 1);
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
  const copiedOrigin = cumulative[firstCopied] as number;
  let earliestNeeded = copiedOrigin;
  for (let index = firstCopied; index <= lastCopied; index++) {
    const frame = program[index] as Mp3TrimFrame;
    const start = (cumulative[index] as number) - frame.mainDataBegin;
    if (start < earliestNeeded) earliestNeeded = start;
    if ((cumulative[index] as number) - copiedOrigin > MP3_MAX_RESERVOIR_BYTES) break;
  }
  const reservoirBytes = clampInt(copiedOrigin - earliestNeeded, 0, copiedOrigin);

  const borrowed = new Uint8Array(reservoirBytes);
  for (let index = 0, position = copiedOrigin - reservoirBytes; index < reservoirBytes; index++) {
    borrowed[index] = bytes[mainDataByteOffset(program, cumulative, position + index)] as number;
  }
  const carrierFrames = reservoirBytes > 0 ? 1 : 0;

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
  // source's own padding instead, and is short exactly where the source itself is.
  let lastEmitted = lastCopied;
  let codedOut = (carrierFrames + lastEmitted - firstCopied + 1) * samplesPerFrame;
  if (
    codedOut - encoderDelayOut - windowSamples < MP3_LAYER_III_SYNTHESIS_DELAY_SAMPLES &&
    lastEmitted < programFrames - 1
  ) {
    lastEmitted++;
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
    ...(carrierFrames === 1
      ? [
          buildReservoirCarrierFrame(
            bytes.subarray(first.offset, first.offset + 4),
            version,
            sampleRate,
            channels,
            borrowed,
          ),
        ]
      : []),
    ...program
      .slice(firstCopied, lastEmitted + 1)
      .map((frame) => bytes.subarray(frame.offset, frame.offset + frame.size)),
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
    carriesReservoirFrame: carrierFrames === 1,
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
