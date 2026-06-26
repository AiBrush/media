/**
 * Pure-TS FLAC encoder (native FLAC; RFC 9639) — a genuinely-compressing lossless authoring path. Each
 * block is coded as the cheapest of CONSTANT, FIXED-predictor (orders 0–4) with **partitioned Rice**
 * residuals, or VERBATIM (the always-correct fallback when prediction does not pay). Stereo blocks try
 * the four channel decorrelations (independent L/R, left/side, right/side, mid/side) and keep the
 * smallest. The result is bit-exact lossless: the residual arithmetic is the exact inverse of the
 * decoder's `restoreFixed`/`decorrelate`, so {@link decode.ts} reproduces the source samples and the
 * STREAMINFO MD5 (the self-validation oracle) — verifiable by an independent `flac`/`ffmpeg` decoder.
 *
 * The encoder is exposed three ways: {@link encodeFlac} (whole-buffer, compressing), {@link
 * encodeFlacVerbatim} (whole-buffer, verbatim-only — the compression baseline for oracles), and the
 * streaming {@link FlacFrameEncoder} (one block → one frame, with a STREAMINFO builder finalized at the
 * end), which the codec/muxer drivers use to author from an `AudioData` stream.
 */

import { InputError, MediaError } from '../../contracts/errors.ts';
import { type PcmAudio, type SampleFormat, channelAt, sampleAt } from '../../dsp/pcm.ts';
import type { FlacDecoded } from './decode.ts';

export interface FlacPcm {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  readonly totalSamples: number;
  readonly samples: readonly Int32Array[];
}

export interface FlacEncodeOptions {
  /** Samples per FLAC frame. Defaults to 4096; the final frame may be shorter. */
  readonly blockSize?: number;
}

interface FlacFrame {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly samples: number;
}

const DEFAULT_BLOCK_SIZE = 4096;
const MAX_CHANNELS = 8;
const MAX_SAMPLE_RATE = 0xfffff; // STREAMINFO stores sample rate in 20 bits.
const MAX_TOTAL_SAMPLES = 2 ** 36 - 1; // STREAMINFO stores total samples in 36 bits.
const MAX_BLOCK_SIZE = 65_535; // STREAMINFO min/max block size fields are 16-bit.
const MIN_BITS_PER_SAMPLE = 1;
const MAX_BITS_PER_SAMPLE = 32;

/** FIXED-predictor orders the encoder considers (RFC 9639 §9.2.6). Order 0 = raw residual. */
const MAX_FIXED_ORDER = 4;
/** Cap on the Rice partition order searched (2^8 partitions is plenty for ≤65 535-sample blocks). */
const MAX_PARTITION_ORDER = 8;
/**
 * Residual coding uses the 5-bit-parameter Rice method (residual_coding_method 1, RFC 9639 §9.2.7.1):
 * params 0–30 select the Rice parameter `k`; 31 is the verbatim escape. The 5-bit method (over the 4-bit
 * one) gives headroom for the large residuals 24-bit content produces.
 */
const RICE5_PARAM_BITS = 5;
const RICE5_ESCAPE = 0x1f;
const MAX_RICE5_PARAM = 30;

/** Build encoder input from the existing pure-TS decoder output without copying sample planes. */
export function flacPcmFromDecoded(decoded: FlacDecoded): FlacPcm {
  return {
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    bitsPerSample: decoded.bitsPerSample,
    totalSamples: decoded.totalSamples,
    samples: decoded.samples,
  };
}

/**
 * Quantize canonical planar PCM into signed integer samples for FLAC. Integer PCM formats round-trip
 * exactly through `decodePcm`'s normalized Float64 representation; float sources are intentionally
 * quantized to the requested bit depth.
 */
export function flacPcmFromPcmAudio(
  audio: PcmAudio,
  formatOrBits: SampleFormat | number = 16,
): FlacPcm {
  const bitsPerSample = bitsPerSampleFor(formatOrBits);
  validateLayout(audio.sampleRate, audio.channels, bitsPerSample, audio.frames);
  const samples: Int32Array[] = [];
  for (let ch = 0; ch < audio.channels; ch++) {
    const source = channelAt(audio.planar, ch);
    const out = new Int32Array(audio.frames);
    for (let i = 0; i < audio.frames; i++) {
      out[i] = quantizePcmSample(sampleAt(source, i), bitsPerSample);
    }
    samples.push(out);
  }
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    bitsPerSample,
    totalSamples: audio.frames,
    samples,
  };
}

/** Encode signed integer PCM as a compressed native FLAC byte stream (FIXED + Rice; verbatim fallback). */
export function encodeFlac(pcm: FlacPcm, options: FlacEncodeOptions = {}): Uint8Array<ArrayBuffer> {
  return encodeWith(pcm, options, true);
}

/**
 * Encode signed integer PCM as a VERBATIM-only native FLAC stream — every subframe is verbatim, so the
 * output is the incompressible upper bound. This is the baseline a compression oracle compares against
 * (a real compressor must beat it) and the always-valid reference for the same PCM bytes/MD5.
 */
export function encodeFlacVerbatim(
  pcm: FlacPcm,
  options: FlacEncodeOptions = {},
): Uint8Array<ArrayBuffer> {
  return encodeWith(pcm, options, false);
}

function encodeWith(
  pcm: FlacPcm,
  options: FlacEncodeOptions,
  compress: boolean,
): Uint8Array<ArrayBuffer> {
  validatePcm(pcm);
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  validateBlockSize(blockSize);

  const enc = new FlacFrameEncoder(
    { sampleRate: pcm.sampleRate, channels: pcm.channels, bitsPerSample: pcm.bitsPerSample },
    { compress },
  );
  const frames: FlacFrame[] = [];
  for (let start = 0; start < pcm.totalSamples; start += blockSize) {
    const samples = Math.min(blockSize, pcm.totalSamples - start);
    const block = pcm.samples.map((plane) => plane.subarray(start, start + samples));
    frames.push(enc.encodeBlock(block, samples));
  }
  if (frames.length === 0) throw new InputError('unsupported-input', 'FLAC encode needs samples');

  const md5 = md5Bytes(interleavedPcmBytes(pcm));
  const streamInfo = enc.finalizeStreamInfo(md5);
  return concatBytes([
    Uint8Array.from([0x66, 0x4c, 0x61, 0x43]), // fLaC
    streamInfo,
    ...frames.map((frame) => frame.data),
  ]);
}

// ============ streaming frame encoder ============

export interface FlacStreamConfig {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

export interface FlacFrameEncoderOptions {
  /** When false, every subframe is verbatim (the incompressible baseline). Defaults to true. */
  readonly compress?: boolean;
}

/**
 * Streaming FLAC frame encoder: one call per block of planar signed samples → one native frame, tracking
 * the running min/max block size, min/max frame size, and total sample count so {@link
 * finalizeStreamInfo} can emit a complete STREAMINFO once the stream ends. The MD5 of the source PCM is
 * supplied at finalize time (the caller hashes the interleaved-LE bytes as it streams them, or passes a
 * precomputed digest). Frame numbers are assigned contiguously from 0 in `fixed-blocksize` framing.
 */
export class FlacFrameEncoder {
  readonly #config: FlacStreamConfig;
  readonly #compress: boolean;
  #frameIndex = 0;
  #totalSamples = 0;
  #maxBlockSize = 0;
  #minFrameSize = 0xffffff;
  #maxFrameSize = 0;

  constructor(config: FlacStreamConfig, options: FlacFrameEncoderOptions = {}) {
    validateLayout(config.sampleRate, config.channels, config.bitsPerSample, 1);
    this.#config = config;
    this.#compress = options.compress ?? true;
  }

  /** The number of audio frames (samples per channel) coded so far. */
  get totalSamples(): number {
    return this.#totalSamples;
  }

  /** The stream's audio layout (sample rate / channels / bit depth). */
  get config(): FlacStreamConfig {
    return this.#config;
  }

  /**
   * Encode one block of `samples` planar signed channels into a native FLAC frame. Each plane must hold
   * at least `samples` entries (extra entries are ignored). Stereo blocks pick the cheapest channel
   * decorrelation; each subframe picks the cheapest of CONSTANT / FIXED / VERBATIM.
   */
  encodeBlock(planes: readonly Int32Array[], samples: number): FlacFrame {
    if (samples < 1) throw new InputError('unsupported-input', 'FLAC frame needs ≥1 sample');
    if (planes.length !== this.#config.channels) {
      throw new MediaError(
        'encode-error',
        `FLAC frame expected ${this.#config.channels} planes, got ${planes.length}`,
      );
    }
    const frame = encodeFrame(this.#config, planes, samples, this.#frameIndex, this.#compress);
    this.#frameIndex++;
    this.#totalSamples += samples;
    // A fixed-blocksize stream declares ONE nominal block size (the size every frame uses except a
    // possibly-shorter final frame). A short last frame must NOT lower the declared block size, else
    // libFLAC treats the stream as variable-blocksize and warns on seek; so track the max only.
    this.#maxBlockSize = Math.max(this.#maxBlockSize, samples);
    this.#minFrameSize = Math.min(this.#minFrameSize, frame.data.byteLength);
    this.#maxFrameSize = Math.max(this.#maxFrameSize, frame.data.byteLength);
    return frame;
  }

  /** Build the final STREAMINFO metadata block from the accumulated framing stats + the PCM MD5. */
  finalizeStreamInfo(md5: Uint8Array): Uint8Array<ArrayBuffer> {
    if (this.#totalSamples === 0) {
      throw new InputError('unsupported-input', 'FLAC encode produced no frames');
    }
    if (md5.byteLength !== 16) throw new MediaError('encode-error', 'FLAC MD5 must be 16 bytes');
    // Declared block size is the nominal (max) for every frame: min == max marks a fixed-blocksize
    // stream. The sole exception — a single frame shorter than the nominal — is itself the max, so
    // `#maxBlockSize` is correct in every case. (`#minBlockSize` is retained only for the all-frames-
    // equal single-frame case, where it equals `#maxBlockSize` anyway.)
    const nominalBlockSize = this.#maxBlockSize;
    return streamInfoBlock(
      this.#config,
      this.#totalSamples,
      nominalBlockSize,
      nominalBlockSize,
      this.#minFrameSize,
      this.#maxFrameSize,
      md5,
    );
  }
}

function bitsPerSampleFor(formatOrBits: SampleFormat | number): number {
  if (typeof formatOrBits === 'number') return formatOrBits;
  switch (formatOrBits) {
    case 'u8':
    case 's8':
      return 8;
    case 's16':
      return 16;
    case 's24':
      return 24;
    case 's32':
      return 32;
    case 'f32':
    case 'f64':
      return 24;
  }
}

function quantizePcmSample(value: number, bitsPerSample: number): number {
  if (!Number.isFinite(value)) {
    throw new InputError(
      'unsupported-input',
      'FLAC encode cannot quantize a non-finite PCM sample',
    );
  }
  const scale = 2 ** (bitsPerSample - 1);
  const min = -scale;
  const max = scale - 1;
  return clampInt(Math.round(value * scale), min, max);
}

function validatePcm(pcm: FlacPcm): void {
  validateLayout(pcm.sampleRate, pcm.channels, pcm.bitsPerSample, pcm.totalSamples);
  if (pcm.samples.length !== pcm.channels) {
    throw new InputError(
      'unsupported-input',
      `FLAC encode expected ${pcm.channels} channel planes, got ${pcm.samples.length}`,
    );
  }
  const min = -(2 ** (pcm.bitsPerSample - 1));
  const max = 2 ** (pcm.bitsPerSample - 1) - 1;
  for (let ch = 0; ch < pcm.channels; ch++) {
    const plane = pcm.samples[ch];
    if (plane === undefined || plane.length !== pcm.totalSamples) {
      throw new InputError(
        'unsupported-input',
        `FLAC encode channel ${ch} length must equal totalSamples (${pcm.totalSamples})`,
      );
    }
    for (const sample of plane) {
      if (!Number.isInteger(sample) || sample < min || sample > max) {
        throw new InputError(
          'unsupported-input',
          `FLAC encode sample ${sample} is outside signed ${pcm.bitsPerSample}-bit range`,
        );
      }
    }
  }
}

function validateLayout(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  totalSamples: number,
): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > MAX_SAMPLE_RATE) {
    throw new InputError('unsupported-input', `FLAC encode sample rate ${sampleRate} is invalid`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS) {
    throw new InputError('unsupported-input', `FLAC encode channel count ${channels} is invalid`);
  }
  if (
    !Number.isInteger(bitsPerSample) ||
    bitsPerSample < MIN_BITS_PER_SAMPLE ||
    bitsPerSample > MAX_BITS_PER_SAMPLE
  ) {
    throw new InputError(
      'unsupported-input',
      `FLAC encode bitsPerSample ${bitsPerSample} is invalid`,
    );
  }
  if (
    !Number.isSafeInteger(totalSamples) ||
    totalSamples <= 0 ||
    totalSamples > MAX_TOTAL_SAMPLES
  ) {
    throw new InputError(
      'unsupported-input',
      `FLAC encode totalSamples ${totalSamples} is invalid`,
    );
  }
}

function validateBlockSize(blockSize: number): void {
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > MAX_BLOCK_SIZE) {
    throw new InputError('unsupported-input', `FLAC encode blockSize ${blockSize} is invalid`);
  }
}

// ============ frame coding ============

/** Stereo channel decorrelation assignment (RFC 9639 §9.1): independent, left/side, right/side, mid/side. */
type ChannelAssignment = 0 | 8 | 9 | 10;

/**
 * A planned subframe for one channel: the chosen method, its precomputed Rice partitioning (for FIXED),
 * and the exact bit cost. Planning is cost-only (no bit emission), so the four stereo decorrelations are
 * compared cheaply; the winner is serialized once by {@link writeSubframe}. `residual` (for FIXED) is the
 * exact integer the decoder's `restoreFixed` reverses, so the round-trip is lossless.
 */
interface SubframePlan {
  readonly kind: 'constant' | 'verbatim' | 'fixed';
  readonly bps: number;
  readonly order: number;
  readonly residual: Int32Array;
  readonly partition: Partitioning;
  readonly cost: number;
}

function encodeFrame(
  config: FlacStreamConfig,
  planes: readonly Int32Array[],
  samples: number,
  frameIndex: number,
  compress: boolean,
): FlacFrame {
  const { assignment, plans } = planSubframes(config, planes, samples, compress);
  const header = frameHeader(config, assignment, samples, frameIndex);
  const body = new BitWriter();
  for (const plan of plans) writeSubframe(body, plan, plan.source, samples);
  body.alignToByte();
  const withoutFooter = concatBytes([header, body.toUint8Array()]);
  const crc = crc16(withoutFooter);
  return {
    samples,
    data: concatBytes([withoutFooter, Uint8Array.from([(crc >>> 8) & 0xff, crc & 0xff])]),
  };
}

/**
 * Choose the channel decorrelation and plan every subframe (cost-only). Stereo evaluates the four
 * assignments and keeps the cheapest pair; mono/multichannel plan each channel independently. The side
 * channel of a decorrelated pair spans `bps+1` bits (a difference of two `bps`-bit samples), which
 * {@link decodeSubframe} restores symmetrically.
 */
function planSubframes(
  config: FlacStreamConfig,
  planes: readonly Int32Array[],
  samples: number,
  compress: boolean,
): { assignment: ChannelAssignment; plans: PlanWithSource[] } {
  const bps = config.bitsPerSample;
  if (config.channels !== 2) {
    const plans = planes.map((plane) =>
      planChannel(plane.subarray(0, samples), samples, bps, compress),
    );
    return { assignment: 0, plans };
  }
  const left = (planes[0] ?? new Int32Array(samples)).subarray(0, samples);
  const right = (planes[1] ?? new Int32Array(samples)).subarray(0, samples);
  const mid = new Int32Array(samples);
  const side = new Int32Array(samples);
  for (let i = 0; i < samples; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    mid[i] = (l + r) >> 1; // floor((l+r)/2); the dropped LSB is recoverable from side's parity
    side[i] = l - r;
  }
  const planL = planChannel(left, samples, bps, compress);
  const planR = planChannel(right, samples, bps, compress);
  const planM = planChannel(mid, samples, bps, compress);
  const planS = planChannel(side, samples, bps + 1, compress);

  const candidates: ReadonlyArray<{ assignment: ChannelAssignment; plans: PlanWithSource[] }> = [
    { assignment: 0, plans: [planL, planR] }, // independent L/R
    { assignment: 8, plans: [planL, planS] }, // left/side
    { assignment: 9, plans: [planS, planR] }, // right/side
    { assignment: 10, plans: [planM, planS] }, // mid/side
  ];
  let best = candidates[0] as { assignment: ChannelAssignment; plans: PlanWithSource[] };
  let bestCost = subframePairCost(best.plans);
  for (const candidate of candidates) {
    const cost = subframePairCost(candidate.plans);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }
  return best;
}

type PlanWithSource = SubframePlan & { readonly source: Int32Array };

function subframePairCost(plans: readonly PlanWithSource[]): number {
  return (plans[0]?.cost ?? 0) + (plans[1]?.cost ?? 0);
}

/** FIXED-predictor coefficients (RFC 9639 §9.2.6) — the exact inverse the decoder applies. */
const FIXED_COEF: ReadonlyArray<readonly number[]> = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

const EMPTY_RESIDUAL = new Int32Array(0);
const EMPTY_PARTITION: Partitioning = { partitionOrder: 0, params: [], escapeBits: [], cost: 0 };

/**
 * Plan one channel's subframe (cost-only): the cheapest of CONSTANT, the best FIXED order (0–4) with its
 * partitioned-Rice residual, or VERBATIM. The FIXED order is selected by the classic sum-of-|residual|
 * heuristic (compute residuals for all five orders incrementally — order-k residual is the first
 * difference of order-(k-1) — and keep the order minimizing total magnitude), then the exact Rice
 * partitioning is costed once for that order. Returns the source plane alongside the plan so the writer
 * can emit the warmup samples without recomputing the decorrelation.
 */
function planChannel(
  source: Int32Array,
  samples: number,
  bps: number,
  compress: boolean,
): PlanWithSource {
  const verbatimCost = SUBFRAME_HEADER_BITS + bps * samples;
  if (!compress) {
    return {
      kind: 'verbatim',
      bps,
      order: 0,
      residual: EMPTY_RESIDUAL,
      partition: EMPTY_PARTITION,
      cost: verbatimCost,
      source,
    };
  }
  if (isConstant(source, samples)) {
    return {
      kind: 'constant',
      bps,
      order: 0,
      residual: EMPTY_RESIDUAL,
      partition: EMPTY_PARTITION,
      cost: SUBFRAME_HEADER_BITS + bps,
      source,
    };
  }
  const order = bestFixedOrder(source, samples);
  const residual = fixedResidual(source, samples, order);
  const partition = bestPartitioning(residual, samples, order);
  const fixedCost = SUBFRAME_HEADER_BITS + bps * order + partition.cost;
  if (fixedCost < verbatimCost) {
    return { kind: 'fixed', bps, order, residual, partition, cost: fixedCost, source };
  }
  return {
    kind: 'verbatim',
    bps,
    order: 0,
    residual: EMPTY_RESIDUAL,
    partition: EMPTY_PARTITION,
    cost: verbatimCost,
    source,
  };
}

/** Bits in a subframe header: zero pad bit + 6-bit type + 1 "no wasted bits" flag. */
const SUBFRAME_HEADER_BITS = 8;

function isConstant(plane: Int32Array, samples: number): boolean {
  const v = plane[0] ?? 0;
  for (let i = 1; i < samples; i++) if ((plane[i] ?? 0) !== v) return false;
  return true;
}

/**
 * Pick the FIXED order (0–4) whose residual has the smallest total magnitude — the standard cheap proxy
 * for coded size (FLAC's reference encoder uses the same sum-of-abs heuristic). Residuals are derived
 * incrementally: order n+1 is the first difference of order n, so all five sums come from one pass that
 * differences a working buffer in place.
 */
function bestFixedOrder(plane: Int32Array, samples: number): number {
  const maxOrder = Math.min(MAX_FIXED_ORDER, samples - 1);
  const work = Int32Array.from(plane.subarray(0, samples));
  let bestOrder = 0;
  let bestSum = absSum(work, 0, samples);
  for (let order = 1; order <= maxOrder; order++) {
    // Difference in place: work[i] -= work[i-1] over the still-active suffix.
    for (let i = samples - 1; i >= order; i--) work[i] = (work[i] ?? 0) - (work[i - 1] ?? 0);
    const sum = absSum(work, order, samples);
    if (sum < bestSum) {
      bestSum = sum;
      bestOrder = order;
    }
  }
  return bestOrder;
}

function absSum(arr: Int32Array, start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    const v = arr[i] ?? 0;
    total += v < 0 ? -v : v;
  }
  return total;
}

/** Compute the order-`order` FIXED residual `res[i] = plane[i] - Σ coef[j]·plane[i-1-j]` (exact inverse). */
function fixedResidual(plane: Int32Array, samples: number, order: number): Int32Array {
  const coef = FIXED_COEF[order] ?? [];
  const residual = new Int32Array(samples - order);
  for (let i = order; i < samples; i++) {
    let pred = 0;
    for (let j = 0; j < order; j++) pred += (coef[j] ?? 0) * (plane[i - 1 - j] ?? 0);
    residual[i - order] = (plane[i] ?? 0) - pred;
  }
  return residual;
}

/** Serialize a planned subframe (header + warmup + residual) into the frame body. */
function writeSubframe(
  bits: BitWriter,
  plan: SubframePlan,
  source: Int32Array,
  samples: number,
): void {
  if (plan.kind === 'constant') {
    writeSubframeHeader(bits, 0); // CONSTANT
    bits.writeSigned(source[0] ?? 0, plan.bps);
    return;
  }
  if (plan.kind === 'verbatim') {
    writeSubframeHeader(bits, 1); // VERBATIM
    for (let i = 0; i < samples; i++) bits.writeSigned(source[i] ?? 0, plan.bps);
    return;
  }
  writeSubframeHeader(bits, 8 + plan.order); // FIXED order 0..4
  for (let i = 0; i < plan.order; i++) bits.writeSigned(source[i] ?? 0, plan.bps);
  writeResidual(bits, plan.residual, samples, plan.order, plan.partition);
}

/** Write a subframe header: zero pad bit, 6-bit type, and a 0 "no wasted bits" flag. */
function writeSubframeHeader(bits: BitWriter, type: number): void {
  bits.writeBit(0); // mandatory zero padding bit
  bits.writeBits(type, 6); // subframe type
  bits.writeBit(0); // no wasted bits (we never shift)
}

// ============ partitioned Rice residual ============

/**
 * Write the residual as a partitioned-Rice block (RFC 9639 §9.2.7) using a precomputed {@link
 * Partitioning} from {@link bestPartitioning}. The 5-bit-parameter method (residual_coding_method 1 →
 * params 0–30, 31 = escape) is used; a partition whose optimal Rice cost exceeds storing it verbatim
 * uses the escape (fixed bit width) instead.
 */
function writeResidual(
  bits: BitWriter,
  residual: Int32Array,
  blockSize: number,
  predictorOrder: number,
  partitioning: Partitioning,
): void {
  const { partitionOrder, params, escapeBits } = partitioning;
  bits.writeBits(1, 2); // residual coding method 1 (5-bit Rice parameters)
  bits.writeBits(partitionOrder, 4);
  const partitions = 1 << partitionOrder;
  const partitionSamples = blockSize >> partitionOrder;
  let index = 0;
  for (let p = 0; p < partitions; p++) {
    const count = p === 0 ? partitionSamples - predictorOrder : partitionSamples;
    const param = params[p] ?? 0;
    if (param === RICE5_ESCAPE) {
      const width = escapeBits[p] ?? 0;
      bits.writeBits(RICE5_ESCAPE, RICE5_PARAM_BITS);
      bits.writeBits(width, 5);
      for (let j = 0; j < count; j++) {
        if (width > 0) bits.writeSigned(residual[index] ?? 0, width);
        index++;
      }
    } else {
      bits.writeBits(param, RICE5_PARAM_BITS);
      for (let j = 0; j < count; j++) {
        bits.writeRice(residual[index] ?? 0, param);
        index++;
      }
    }
  }
}

interface Partitioning {
  partitionOrder: number;
  params: number[];
  escapeBits: number[];
  /** Total residual bit cost INCLUDING the 2-bit method tag + 4-bit order field + all parameter fields. */
  cost: number;
}

/** Search partition orders dividing the block and return the cheapest Rice partitioning. */
function bestPartitioning(
  residual: Int32Array,
  blockSize: number,
  predictorOrder: number,
): Partitioning {
  let best: Partitioning | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  const maxOrder = maxPartitionOrder(blockSize, predictorOrder);
  for (let po = 0; po <= maxOrder; po++) {
    const partitions = 1 << po;
    const partitionSamples = blockSize >> po;
    const params = new Array<number>(partitions);
    const escapeBits = new Array<number>(partitions);
    let cost = 2 + 4; // 2-bit method tag + 4-bit partition order field
    let index = 0;
    for (let p = 0; p < partitions; p++) {
      const count = p === 0 ? partitionSamples - predictorOrder : partitionSamples;
      const choice = bestRiceForPartition(residual, index, count);
      params[p] = choice.param;
      escapeBits[p] = choice.escapeWidth;
      cost += choice.cost;
      index += count;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = { partitionOrder: po, params, escapeBits, cost };
    }
  }
  // `maxOrder >= 0` always yields a candidate; the fallback keeps the types total.
  return best ?? { partitionOrder: 0, params: [0], escapeBits: [0], cost: bestCost };
}

/** The largest partition order such that every partition divides the block and the first one is non-empty. */
function maxPartitionOrder(blockSize: number, predictorOrder: number): number {
  let order = 0;
  while (
    order < MAX_PARTITION_ORDER &&
    blockSize % (1 << (order + 1)) === 0 &&
    blockSize >> (order + 1) > predictorOrder
  ) {
    order++;
  }
  return order;
}

interface RiceChoice {
  /** The chosen 5-bit parameter, or {@link RICE5_ESCAPE} when verbatim-escape is cheaper. */
  param: number;
  /** When escaping, the fixed bit width per residual (0 when the partition is all-zero). */
  escapeWidth: number;
  /** Total bits for this partition INCLUDING the 5-bit parameter field. */
  cost: number;
}

/** Pick the cheapest Rice parameter (or escape) for `count` residuals starting at `start`. */
function bestRiceForPartition(residual: Int32Array, start: number, count: number): RiceChoice {
  if (count <= 0) return { param: 0, escapeWidth: 0, cost: RICE5_PARAM_BITS };
  // Sum of zigzag-mapped magnitudes drives the optimal k ≈ log2(mean); search a window for the exact min.
  let sum = 0;
  let maxBits = 0;
  for (let i = 0; i < count; i++) {
    const u = zigzag(residual[start + i] ?? 0);
    sum += u;
    const needed = 32 - Math.clz32(u); // bits to store u unsigned (0 for u=0)
    if (needed > maxBits) maxBits = needed;
  }
  const mean = sum / count;
  const guess = mean < 1 ? 0 : Math.floor(Math.log2(mean));
  let bestParam = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  const lo = Math.max(0, guess - 1);
  const hi = Math.min(MAX_RICE5_PARAM, guess + 2);
  for (let k = lo; k <= hi; k++) {
    const cost = riceCost(residual, start, count, k);
    if (cost < bestCost) {
      bestCost = cost;
      bestParam = k;
    }
  }
  // Escape (store each residual in a fixed signed width) when Rice does not pay. Width is the magnitude
  // width plus the sign bit; 0 only when every residual is zero. Escape payload = the 5-bit width field
  // plus width·count; the caller adds the 5-bit Rice-parameter field once via {@link cost}.
  const escapeWidth = maxBits === 0 ? 0 : Math.min(32, maxBits + 1);
  const escapePayload = 5 + escapeWidth * count;
  if (escapePayload < bestCost) {
    return { param: RICE5_ESCAPE, escapeWidth, cost: RICE5_PARAM_BITS + escapePayload };
  }
  return { param: bestParam, escapeWidth: 0, cost: RICE5_PARAM_BITS + bestCost };
}

/** Total payload bits (excluding the parameter field) for `count` residuals at Rice parameter `k`. */
function riceCost(residual: Int32Array, start: number, count: number, k: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    const u = zigzag(residual[start + i] ?? 0);
    total += (u >>> k) + 1 + k; // quotient (unary) + stop bit + k remainder bits
  }
  return total;
}

/** Zigzag-map a signed residual to the unsigned code the decoder reverses (`(u>>>1) ^ -(u&1)`). */
function zigzag(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

// ============ frame header + STREAMINFO ============

/**
 * Standard FLAC block-size codes (RFC 9639 §9.1.1, the "BLOCK_SIZE_TABLE" the decoder reads): a block of
 * one of these sizes encodes its size as a 4-bit table code with no trailing size byte(s). Real encoders
 * use the table code for the common (4096) block; a non-standard size (the final short frame) falls back
 * to an explicit 8- or 16-bit size. Using the table code for full frames also avoids libFLAC's
 * fixed-blocksize seektable warning, which fires on explicit-size frames in a fixed-blocksize stream.
 */
const BLOCK_SIZE_CODE: ReadonlyMap<number, number> = new Map([
  [192, 1],
  [576, 2],
  [1152, 3],
  [2304, 4],
  [4608, 5],
  [256, 8],
  [512, 9],
  [1024, 10],
  [2048, 11],
  [4096, 12],
  [8192, 13],
  [16384, 14],
  [32768, 15],
]);

function frameHeader(
  config: FlacStreamConfig,
  assignment: ChannelAssignment,
  samples: number,
  frameIndex: number,
): Uint8Array<ArrayBuffer> {
  const bits = new BitWriter();
  // Block-size encoding: a standard size → its table code (no trailing byte); else an explicit 8-bit
  // size (code 6) for ≤256, or a 16-bit size (code 7) otherwise. `samples-1` is stored explicitly.
  const tableCode = BLOCK_SIZE_CODE.get(samples);
  const explicitBits = tableCode !== undefined ? 0 : samples <= 256 ? 8 : 16;
  const blockSizeCode = tableCode ?? (explicitBits === 8 ? 6 : 7);

  bits.writeBits(0x3ffe, 14); // sync
  bits.writeBit(0); // reserved
  bits.writeBit(0); // fixed-blocksize stream; frame number follows
  bits.writeBits(blockSizeCode, 4);
  bits.writeBits(0, 4); // sample rate from STREAMINFO
  bits.writeBits(channelAssignmentCode(config.channels, assignment), 4);
  bits.writeBits(0, 3); // sample size from STREAMINFO
  bits.writeBit(0); // reserved
  bits.writeBytes(utf8Uint(frameIndex));
  if (explicitBits > 0) bits.writeBits(samples - 1, explicitBits);
  const withoutCrc = bits.toUint8Array();
  return concatBytes([withoutCrc, Uint8Array.from([crc8(withoutCrc)])]);
}

/** The 4-bit channel assignment nibble: independent channels are `count-1`; stereo modes are 8/9/10. */
function channelAssignmentCode(channels: number, assignment: ChannelAssignment): number {
  if (assignment === 0) return channels - 1;
  return assignment;
}

function streamInfoBlock(
  config: FlacStreamConfig,
  totalSamples: number,
  minBlockSize: number,
  maxBlockSize: number,
  minFrameSize: number,
  maxFrameSize: number,
  md5: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(34);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, minBlockSize, false);
  dv.setUint16(2, maxBlockSize, false);
  writeU24(body, 4, minFrameSize === 0xffffff ? 0 : minFrameSize);
  writeU24(body, 7, maxFrameSize);
  const totalHigh = Math.floor(totalSamples / 2 ** 32);
  const packed =
    config.sampleRate * 2 ** 12 +
    (config.channels - 1) * 2 ** 9 +
    (config.bitsPerSample - 1) * 2 ** 4 +
    totalHigh;
  dv.setUint32(10, packed, false);
  dv.setUint32(14, totalSamples >>> 0, false);
  body.set(md5, 18);

  return concatBytes([
    Uint8Array.from([0x80, 0x00, 0x00, body.byteLength]), // last metadata block, STREAMINFO, length 34
    body,
  ]);
}

/**
 * Build the native FLAC prelude (`fLaC` + a STREAMINFO block) the streaming codec encoder publishes to
 * the muxer before any frame: it carries the audio layout (sample rate / channels / bit depth) but leaves
 * total samples and the PCM MD5 as the spec's "unknown" 0 — the muxer backfills total samples + frame
 * sizes from the buffered frames at finalize. A valid header for a single-shot decoder regardless.
 */
export function streamInfoPrelude(config: FlacStreamConfig): Uint8Array<ArrayBuffer> {
  validateLayout(config.sampleRate, config.channels, config.bitsPerSample, 1);
  const streamInfo = streamInfoBlock(config, 0, 0, 0, 0, 0, new Uint8Array(16));
  return concatBytes([Uint8Array.from([0x66, 0x4c, 0x61, 0x43]), streamInfo]); // fLaC + STREAMINFO
}

function writeU24(bytes: Uint8Array, offset: number, value: number): void {
  if (value < 0 || value > 0xffffff) {
    throw new MediaError('encode-error', `FLAC frame size ${value} cannot fit in STREAMINFO`);
  }
  bytes[offset] = (value >>> 16) & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = value & 0xff;
}

/** Serialize PCM the way STREAMINFO MD5 is defined: interleaved, little-endian, sample-width bytes. */
export function interleavedPcmBytes(pcm: FlacPcm): Uint8Array<ArrayBuffer> {
  const bytesPerSample = Math.ceil(pcm.bitsPerSample / 8);
  const out = new Uint8Array(pcm.totalSamples * pcm.channels * bytesPerSample);
  let offset = 0;
  for (let i = 0; i < pcm.totalSamples; i++) {
    for (let ch = 0; ch < pcm.channels; ch++) {
      let value = pcm.samples[ch]?.[i] ?? 0;
      for (let b = 0; b < bytesPerSample; b++) {
        out[offset++] = value & 0xff;
        value = Math.floor(value / 256);
      }
    }
  }
  return out;
}

// ============ BitWriter ============

/**
 * MSB-first bit writer over a growable `Uint8Array`. Bits accumulate in a ≤32-bit register that flushes
 * whole bytes as it fills — far faster than a per-bit `number[]` for the multi-megabyte frame bodies a
 * 24-bit/96 kHz stream produces. {@link writeRice} emits a Rice code (long unary run + remainder) as bulk
 * byte writes rather than one `writeBit` per zero, the dominant cost in residual coding.
 */
class BitWriter {
  #bytes: Uint8Array;
  #length = 0; // bytes committed
  #acc = 0; // pending bits, MSB-aligned in the low `#accBits`
  #accBits = 0;

  constructor(capacity = 256) {
    this.#bytes = new Uint8Array(capacity);
  }

  #ensure(extraBytes: number): void {
    const need = this.#length + extraBytes;
    if (need <= this.#bytes.length) return;
    let cap = this.#bytes.length * 2;
    while (cap < need) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }

  #flushBytes(): void {
    while (this.#accBits >= 8) {
      this.#accBits -= 8;
      this.#ensure(1);
      this.#bytes[this.#length++] = (this.#acc >>> this.#accBits) & 0xff;
    }
    // Keep only the residual low bits so `#acc` never overflows 32 bits.
    this.#acc &= (1 << this.#accBits) - 1;
  }

  writeBit(bit: number): void {
    this.#acc = (this.#acc << 1) | (bit & 1);
    this.#accBits++;
    if (this.#accBits === 8) this.#flushBytes();
  }

  writeBits(value: number, bits: number): void {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new MediaError('encode-error', `invalid bit count ${bits}`);
    }
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
      throw new MediaError('encode-error', `value ${value} does not fit in ${bits} bits`);
    }
    // Emit in ≤16-bit chunks so the accumulator stays within 32 bits regardless of `bits`.
    let remaining = bits;
    while (remaining > 16) {
      remaining -= 16;
      this.#appendChunk(Math.floor(value / 2 ** remaining) & 0xffff, 16);
    }
    if (remaining > 0) this.#appendChunk(value & (2 ** remaining - 1), remaining);
  }

  #appendChunk(value: number, bits: number): void {
    this.#acc = (this.#acc << bits) | value;
    this.#accBits += bits;
    this.#flushBytes();
  }

  writeSigned(value: number, bits: number): void {
    const unsigned = value < 0 ? 2 ** bits + value : value;
    this.writeBits(unsigned, bits);
  }

  /** Write one Rice code: `quotient` zero bits, a 1 stop bit, then `k` remainder bits (RFC 9639 §9.2.7.1). */
  writeRice(value: number, k: number): void {
    const u = zigzag(value);
    let quotient = u >>> k;
    // Bulk-emit the unary run a byte at a time (zeros), then the stop bit + remainder.
    while (quotient >= 8) {
      this.#appendChunk(0, 8);
      quotient -= 8;
    }
    // The stop bit terminates the unary run: `quotient` zeros then a single 1.
    this.#appendChunk(1, quotient + 1);
    if (k > 0) this.writeBits(u & ((1 << k) - 1), k);
  }

  writeBytes(bytes: Uint8Array): void {
    if (this.#accBits !== 0) throw new MediaError('encode-error', 'BitWriter is not byte-aligned');
    this.#ensure(bytes.byteLength);
    this.#bytes.set(bytes, this.#length);
    this.#length += bytes.byteLength;
  }

  alignToByte(): void {
    if (this.#accBits === 0) return;
    this.#appendChunk(0, 8 - this.#accBits); // pad the final partial byte with zeros
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    if (this.#accBits !== 0) {
      throw new MediaError('encode-error', 'BitWriter ended on a non-byte boundary');
    }
    return this.#bytes.slice(0, this.#length);
  }
}

function utf8Uint(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TOTAL_SAMPLES) {
    throw new MediaError('encode-error', `FLAC frame number ${value} is invalid`);
  }
  if (value <= 0x7f) return Uint8Array.from([value]);

  let length = 2;
  while (length < 7 && value >= 2 ** (5 * length + 1)) length++;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i > 0; i--) {
    out[i] = 0x80 | (rest & 0x3f);
    rest = Math.floor(rest / 64);
  }
  const prefix = (0xff << (8 - length)) & 0xff;
  out[0] = prefix | rest;
  return out;
}

function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ============ MD5 (RFC 1321, little-endian words) — streaming + one-shot ============

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const MD5_K: Uint32Array = (() => {
  const out = new Uint32Array(64);
  for (let i = 0; i < 64; i++) out[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  return out;
})();

/** Streaming MD5 state: the four chaining words, a 64-byte residual buffer, and the running byte length. */
export interface Md5State {
  a: number;
  b: number;
  c: number;
  d: number;
  readonly buffer: Uint8Array; // 64 bytes; `bufLen` are valid
  bufLen: number;
  length: number; // total bytes absorbed
}

/** A fresh MD5 state (RFC 1321 initial chaining words). */
export function newMd5State(): Md5State {
  return {
    a: 0x67452301,
    b: 0xefcdab89,
    c: 0x98badcfe,
    d: 0x10325476,
    buffer: new Uint8Array(64),
    bufLen: 0,
    length: 0,
  };
}

const MD5_WORDS = new Uint32Array(16);

/** Process one 64-byte block at `bytes[offset..]` into the chaining state. */
function md5Block(state: Md5State, bytes: Uint8Array, offset: number): void {
  const words = MD5_WORDS;
  for (let i = 0; i < 16; i++) {
    const at = offset + i * 4;
    words[i] =
      (bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24);
  }
  let a = state.a;
  let b = state.b;
  let c = state.c;
  let d = state.d;
  for (let i = 0; i < 64; i++) {
    let f: number;
    let g: number;
    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) % 16;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) % 16;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) % 16;
    }
    const sum = (a + f + (MD5_K[i] ?? 0) + (words[g] ?? 0)) >>> 0;
    a = d;
    d = c;
    c = b;
    b = (b + leftRotate(sum, MD5_SHIFT[i] ?? 0)) >>> 0;
  }
  state.a = (state.a + a) >>> 0;
  state.b = (state.b + b) >>> 0;
  state.c = (state.c + c) >>> 0;
  state.d = (state.d + d) >>> 0;
}

/** Absorb `input` into the MD5 state, processing full 64-byte blocks and buffering the remainder. */
export function updateMd5(state: Md5State, input: Uint8Array): void {
  state.length += input.byteLength;
  let i = 0;
  // Top up a partially-filled residual buffer first.
  if (state.bufLen > 0) {
    const need = 64 - state.bufLen;
    const take = Math.min(need, input.byteLength);
    state.buffer.set(input.subarray(0, take), state.bufLen);
    state.bufLen += take;
    i = take;
    if (state.bufLen === 64) {
      md5Block(state, state.buffer, 0);
      state.bufLen = 0;
    }
  }
  // Process whole blocks straight from the input.
  for (; i + 64 <= input.byteLength; i += 64) md5Block(state, input, i);
  // Buffer the trailing partial block.
  if (i < input.byteLength) {
    const rest = input.byteLength - i;
    state.buffer.set(input.subarray(i, i + rest), 0);
    state.bufLen = rest;
  }
}

/**
 * Absorb one decoded block's samples in STREAMINFO MD5 order (interleaved, little-endian, `bits`→bytes
 * width). Used by the streaming codec encoder so the published STREAMINFO can carry a valid PCM digest.
 */
export function updateMd5WithBlock(
  state: Md5State,
  planes: readonly Int32Array[],
  frames: number,
  bits: number,
  channels: number,
): void {
  const bytesPerSample = Math.ceil(bits / 8);
  const block = new Uint8Array(frames * channels * bytesPerSample);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      let value = planes[ch]?.[i] ?? 0;
      for (let b = 0; b < bytesPerSample; b++) {
        block[o++] = value & 0xff;
        value = Math.floor(value / 256);
      }
    }
  }
  updateMd5(state, block);
}

/** Finalize the MD5: apply RFC 1321 padding + the 64-bit length, returning the 16-byte digest. */
export function finalizeMd5(state: Md5State): Uint8Array<ArrayBuffer> {
  const bitLength = state.length * 8;
  // Padding: a 0x80 byte, then zeros, then the 64-bit little-endian bit length, to a 64-byte boundary.
  const padLen = state.bufLen < 56 ? 56 - state.bufLen : 120 - state.bufLen;
  const tail = new Uint8Array(padLen + 8);
  tail[0] = 0x80;
  writeU32Le(tail, padLen, bitLength >>> 0);
  writeU32Le(tail, padLen + 4, Math.floor(bitLength / 2 ** 32) >>> 0);
  // Absorb the tail WITHOUT re-counting it into `length` (already accounted for via `bitLength`).
  const saved = state.length;
  updateMd5(state, tail);
  state.length = saved;

  const out = new Uint8Array(16);
  writeU32Le(out, 0, state.a);
  writeU32Le(out, 4, state.b);
  writeU32Le(out, 8, state.c);
  writeU32Le(out, 12, state.d);
  return out;
}

/** One-shot MD5 of `input` (the whole-buffer encode path), via the streaming core. */
function md5Bytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const state = newMd5State();
  updateMd5(state, input);
  return finalizeMd5(state);
}

function leftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function writeU32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
