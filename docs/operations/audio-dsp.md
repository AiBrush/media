# Audio DSP & PCM Convert

> Shard **S17** — owns `src/dsp/*.ts`, `src/filters/audio-dsp.ts`, `src/drivers/pcm-output.ts`,
> `src/drivers/pcm-transform.ts`. Serves the benchmark families **`audio-dsp`** and the PCM half of
> **`convert`**.
>
> This document is the **target spec** (the best design) plus an **honest delta** against today's code.
> Every claim is cited to `path:line` or an external source. Unverifiable claims are marked
> `UNVERIFIED`. Measured numbers are quoted from `docs/measured-evidence.md` (cited `(measured-evidence.md)`).

## 1. Purpose & scope

Audio DSP is the family of **pure-signal transforms on decoded PCM**: sample-format & endianness
conversion, gain, channel up/down-mix, band-limited sample-rate conversion (resample), fade/cross-fade,
peak/RMS normalize + limiter (dynamics), and RBJ-cookbook biquad / parametric EQ. These are the
"cheap-majority" of audio work — kilobytes of TypeScript over a canonical planar Float64 buffer, no
codec involved (`src/dsp/pcm.ts:1`, `src/dsp/index.ts:1`).

It exists as its own shard because of a deliberate architectural finding (ADR-022, `measured-evidence.md`): **PCM
is not a WebCodecs codec** (there is no `AudioDecoder`/`AudioEncoder` for raw LPCM), so PCM containers
(WAV/AIFF/CAF) take a *driver-native* `transformPcm` path — decode bytes → planar Float64 → DSP → encode
bytes — rather than the `decode→filter→encode` codec seam. Of ffmpeg.wasm's audio-dsp wins, essentially
all are this kind of format/gain/mix/fade glue; only lossy **encode** genuinely needs WASM
(`measured-evidence.md`, "Finding 4"). Shipping these in-tier is what lets a WebCodecs+TS engine reclaim them
natively.

Two benchmark families are served:

- **`audio-dsp`** — resample (48k↔44.1k, 48k→16k, one-hour longform), downmix/upmix (stereo↔mono,
  5.1→stereo via ITU-R BS.775, mono→stereo), gain (−6.0206 dB, ×0.5 on f32), fade in/out, and PCM
  format/endianness conversion (s16↔f32, s24→s16/f32, s16be↔s16le byte-swap). These are the cells in
  `../media-test/src/scenarios/audio-dsp/index.ts`.
- **`convert` (PCM)** — the format/rate/channel conversions that re-serialize a PCM container. The DSP
  math lives here; the container framing / fast-paths / caching live in S12 (`pcm-convert-plan`) and the
  RIFF/AIFF/CAF drivers (S27).

The single **filter seam** that carries these kernels onto the browser's decoded-audio stream is the
`AudioData` filter driver (`src/filters/audio-dsp.ts`), which serves the audio `FilterSpec` variants
(`resample`/`remix`/`gain`/`fade`/`biquad`/`dynamics`) the GPU video filter driver does not.

## 2. Spec & references

Governing standards:

- **ITU-R BS.775** — *Multichannel stereophonic sound system with and without accompanying picture*
  (BS.775-4, 12/2022). Defines the reference downmix from 3/2 (5.1) to stereo/mono with the −3 dB
  (`1/√2 ≈ 0.7071`) center and surround coefficients.
  <https://www.itu.int/rec/R-REC-BS.775/en>. (Title verified via the ITU record page; the specific
  `1/√2` coefficient values are the well-known BS.775 convention and are implemented at
  `src/dsp/mix.ts:16` and `src/dsp/mix.ts:51`.)
- **Audio EQ Cookbook (RBJ)** — Robert Bristow-Johnson's biquad coefficient formulae, published as a
  W3C Audio Community Group report. Defines `ω₀ = 2π f₀/Fs`, `α = sin ω₀/(2Q)`, and per-type `b/a`
  coefficients. <https://www.w3.org/TR/audio-eq-cookbook/> (verified: peakingEQ `b₀ = 1 + αA`,
  `a₀ = 1 + α/A` — matches `src/dsp/biquad.ts:132,135`).
- **Digital Audio Resampling** — Julius O. Smith III (CCRMA), the canonical treatment of windowed-sinc
  / polyphase band-limited interpolation. <https://ccrma.stanford.edu/~jos/resample/>. Kaiser window
  design (β↔stopband) per Kaiser & Schafer, as summarized there.
- **W3C Web Audio API** — `BiquadFilterNode`, the `OfflineAudioContext` resampler, and the equal-power
  cross-fade convention. <https://www.w3.org/TR/webaudio/>.
- **W3C WebCodecs — `AudioData`** — the raw-frame seam this family filters over (`copyTo`, the
  `f32-planar` / `f32` layouts, frame `close()` lifetime).
  <https://www.w3.org/TR/webcodecs/#audiodata-interface>.

OSS exemplars to study & beat:

- **FFmpeg `libswresample`** — the reference audio conversion engine.
  - Resampling: <https://github.com/FFmpeg/FFmpeg/tree/master/libswresample> (internal polyphase FIR,
    or `soxr` when built with it). The `aresample` filter is a thin wrapper:
    <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_aresample.c>.
  - Channel rematrix / BS.775 downmix:
    <https://github.com/FFmpeg/FFmpeg/blob/master/libswresample/rematrix.c>.
  - Sample-format convert / `aformat`:
    <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_aformat.c> +
    `libswresample/audioconvert.c`.
  - Biquad (RBJ): <https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/af_biquads.c>.
  - Gain/fade/loudness: `af_volume.c`, `af_afade.c`, `af_loudnorm.c` (EBU R128), `af_alimiter.c`.
- **libsamplerate (SRC)** — Erik de Castro Lopo's windowed-sinc resampler (our lineage).
  <http://libsndfile.github.io/libsamplerate/>. **SoX resampler (soxr)**:
  <https://sourceforge.net/projects/soxr/>.
- **Web Audio API** as the in-browser baseline (`BiquadFilterNode`, `OfflineAudioContext` resample,
  equal-power fades).

**Where the SOTA design must match or beat the exemplar:** we match `aformat`'s conversions but with a
higher-precision Float64 canonical (every integer width *and* f32 round-trips bit-exact,
`src/dsp/pcm.ts:6`); we match `rematrix`'s BS.775 downmix (`src/dsp/mix.ts:51`); we match the RBJ
cookbook exactly (`src/dsp/biquad.ts:70`); our resampler is a Kaiser windowed-sinc in the
libsamplerate/soxr lineage (`src/dsp/resample.ts:1`). We **beat** ffmpeg.wasm on the two axes that matter
in-browser: **bundle** (kilobytes of TS, zero WASM download on the common path) and **determinism**
(runs in Node, force-software-safe). We currently **lag** the exemplar on: dither on integer
downconversion, true EBU-R128 LUFS / true-peak dynamics, and arbitrary channel-layout rematrixing — see
the delta.

## 3. Target design

### 3.1 Data model — one canonical buffer

Everything DSP operates on `PcmAudio`: de-interleaved, `[-1,1]`-normalized **Float64** planes
(`src/dsp/pcm.ts:20`):

```ts
export interface PcmAudio {           // src/dsp/pcm.ts:21
  readonly sampleRate: number;
  readonly channels: number;          // === planar.length
  readonly frames: number;            // samples per channel === planar[i].length
  readonly planar: readonly Float64Array[];
}
```

Float64 is the working precision **on purpose**: a 32-bit mantissa needs 53 bits of headroom to survive
`int → x/2ⁿ → round(x·2ⁿ)` bit-exactly, so every width u8…s32 *and* f32 round-trips losslessly
(`src/dsp/pcm.ts:6`). Every kernel is **pure**: it returns *new* audio and leaves the input untouched
(`gain` `src/dsp/gain.ts:16`; `biquad` `src/dsp/biquad.ts:238`; `remix` `src/dsp/mix.ts:91`), so the
graph is referentially transparent and a chunk stream can be validated against the whole-signal result.

Clipping is **deferred to the integer encode boundary** (`encodePcm`, `src/dsp/pcm.ts:207`): the float
domain is unbounded, so a +gain / boost / downmix that overshoots `±1` only clamps when it hits an
integer wire format (`src/dsp/gain.ts:4`, `src/dsp/mix.ts:7`, `src/dsp/biquad.ts:19`). This keeps any
`…→f32` path lossless in spirit.

A second, egress-only model exists for the browser-frame fast path: `InterleavedPcmF32` — exact-owned
interleaved Float32 that transfers zero-copy into `AudioData` (`src/dsp/pcm.ts:29`,
`src/dsp/audio-data.ts:196`). It intentionally drops Float64 working precision because it is the last hop
before the platform frame (`src/dsp/pcm.ts:168`).

### 3.2 Seams & layering (target)

```
bytes ─decodePcm→ PcmAudio ─(gain·fade·remix·resample·biquad·dynamics)→ PcmAudio ─encodePcm→ bytes
  │                                                                                        │
  └── PCM container path (transformPcm): pcm-transform.ts orchestrates, pcm-output.ts serializes
  │
AudioData ─audioDataToPcm→ PcmAudio ─(kernel/stage)→ pcm*Init→ AudioData      ← codec/filter seam
```

- **`src/dsp/*.ts`** — the pure kernels + their streaming twins. No `AudioData`, no container, no I/O.
  Node-testable.
- **`src/dsp/audio-data.ts`** — the only place `AudioData ⇄ PcmAudio` framing lives; imported by the
  engine, codec drivers, and the filter driver so none of them re-implements framing
  (`src/dsp/audio-data.ts:1`).
- **`src/filters/audio-dsp.ts`** — the `FilterDriver` that wraps the kernels as
  `TransformStream<AudioData, AudioData>` for the codec seam (`src/filters/audio-dsp.ts:276`).
- **`src/drivers/pcm-transform.ts`** — the PCM-container orchestrator: parses `PcmTransform` options and
  applies the fixed pipeline order trim → gain → fade → remix → resample → biquad → dynamics
  (`src/drivers/pcm-transform.ts:184`).
- **`src/drivers/pcm-output.ts`** — container-aware PCM serialization + the 8-bit sign policy
  (`src/drivers/pcm-output.ts:44`).

### 3.3 Capability routing (WebCodecs → GPU → WASM, miss-only)

The routing philosophy has a specific, honest shape here:

- **There is no WebCodecs or GPU tier for the DSP math itself.** PCM is not a WebCodecs codec, so no
  hardware decoder/encoder applies; the transforms are pure CPU. The filter driver therefore declares
  `substrate: 'native'` (`src/filters/audio-dsp.ts:280`) — ranked webgpu→webgl→canvas2d→**native**→wasm,
  so GPU *video* filters stay first and a *future* compiled filter core (WASM) would sit below (ADR-076,
  `measured-evidence.md`). Declaring `'native'` (not the older least-wrong `'wasm'`) is load-bearing: it stops the
  driver lying about what executes.
- **The "miss-only WASM" rule applies to the surrounding codec, not to DSP.** For a *compressed* audio
  `convert` (e.g. AAC→…+gain), the codec pipeline (S13) decodes via hardware WebCodecs → falls back to
  the WASM codec tail *only on a hardware miss* → produces `AudioData` → this family filters it → the
  encoder re-encodes. The DSP kernels are always the pure-TS native tier in that chain.
- **For PCM containers there is no codec at all:** `transformPcm` (`src/drivers/pcm-transform.ts:184`)
  runs the kernels directly on decoded bytes and re-serializes (ADR-022).
- **A true miss fails loudly, typed.** An unsupported channel remix
  (`CapabilityError('capability-miss', …)`, `src/dsp/mix.ts:105`), an invalid/irrational target rate
  (`src/dsp/resample.ts:347`), an out-of-band biquad frequency (`InputError`,
  `src/dsp/biquad.ts:72`), or an absent `AudioData` seam (`src/filters/audio-dsp.ts:291`) all raise a
  typed error — the developer never names a backend.

### 3.4 Edge cases

- **B-frames — N/A.** Audio has no bidirectional prediction, so there is no reorder buffer; output goes
  straight to the readable (`src/filters/audio-dsp.ts:16`).
- **VFR — N/A for the sample stream.** PCM is a constant-rate sample sequence, not frame-timed video, so
  there is no variable frame duration to honor. Output timestamps are *derived* deterministically from a
  running frame cursor and the sample rate (`round(cursor/sampleRate · 1e6)` µs,
  `src/dsp/audio-data.ts:142` and `:285`), so re-framing is gapless regardless of chunk sizes. The one
  wrinkle: on the stateful filter seam, timestamps are carried through a **parallel FIFO** aligned to the
  stage's 1:1 framing, and a FIFO under/over-run is asserted as a typed `MediaError` rather than emitting
  a wrong timestamp (`src/filters/audio-dsp.ts:204,211`).
- **Seek — mostly N/A; time-window trim applies.** DSP whole-signal kernels do not seek. The one
  time-addressed op is trim, done *first* as a lossless frame-exact slice in the source rate before any
  gain/fade/resample so a fade-out lands at the new end (`slicePcmFrames`,
  `src/drivers/pcm-transform.ts:168`, ADR-021 PCM-native trim).
- **Cancel — cooperative `AbortSignal`, checked on a bounded interval.** The resampler checks abort every
  `ABORT_CHECK_INTERVAL = 4096` output frames (`src/dsp/resample.ts:35,208,260`) so a multi-minute
  longform resample cancels promptly; `applyPcmTransform` checks at entry and exit
  (`src/drivers/pcm-transform.ts:189,218`); the `AudioData` streams check `stage.signal?.aborted` in
  `pull` and propagate cancel upstream (`src/dsp/audio-data.ts:136,267,309`); the filter transforms
  listen on the abort signal and throw `MediaError('aborted', …)` (`src/filters/audio-dsp.ts:166`).
- **Frame lifetime — every `AudioData` `close()`d exactly once.** Each *input* frame is closed
  synchronously in a `finally` right after `copyTo` fully reads it — nothing is buffered across an
  `await` (`src/filters/audio-dsp.ts:169` stateless, `:235` stateful). Emitted *output* frames are owned
  by the readable consumer; this driver never closes a frame it emitted (`src/filters/audio-dsp.ts:14`).
  On the PCM egress stream, a frame that loses an enqueue/cancel race is closed exactly once at the seam
  (`src/dsp/audio-data.ts:149`). `audioDataToPcm` explicitly does **not** close its argument — the caller
  owns lifetime (`src/dsp/audio-data.ts:18`).
- **Backpressure — pull-driven, `highWaterMark: 0`.** The `AudioData` `ReadableStream`s use
  `{ highWaterMark: 0 }` so at most one canonical chunk and one browser frame are in flight; the upstream
  reader stays locked and a `pull` produces exactly one frame (`src/dsp/audio-data.ts:169,313`,
  `:176`). The filter's `TransformStream` inherits the WHATWG-Streams backpressure of its
  writable/readable pair.

### 3.5 The kernels (target behavior, as built)

- **Format convert** (`src/dsp/pcm.ts`): `readSample`/`writeSample` cover u8 (offset-128), s8, s16, s24
  (hand-packed 3-byte, both endians), s32, f32, f64 (`src/dsp/pcm.ts:70,101`). Integer *narrowing*
  rounds then clamps: e.g. s16 is `clampInt(Math.round(x*32768), -32768, 32767)`
  (`src/dsp/pcm.ts:116`). `decodePcm` drops trailing partial frames (`src/dsp/pcm.ts:154`).
- **Gain** — `factor = 10^(dB/20)`, multiply; `0 dB` is bit-exact identity (`src/dsp/gain.ts:11,16`).
- **Remix** — supported pairs `1↔2`, `2↔6`, `6→2`, `6→1`, and `N→N` identity; 5.1 order is
  `L,R,C,LFE,Ls,Rs` (WAV/SMPTE). BS.775: `Lo = L + (1/√2)C + (1/√2)Ls`, `Ro = R + (1/√2)C + (1/√2)Rs`,
  LFE dropped (`src/dsp/mix.ts:51`); `6→1` fuses the downmix and the L/R average in one pass with no
  temporary planes (`src/dsp/mix.ts:71`, ADR-223). Anything else → typed `CapabilityError`
  (`src/dsp/mix.ts:105`).
- **Resample** — a Kaiser-windowed sinc (`ZERO_CROSSINGS = 32`, `SAMPLES_PER_ZERO_CROSSING = 512`,
  `KAISER_BETA = 9.42` ≈ 80 dB stopband, `src/dsp/resample.ts:31-33`) sampled once into a dense prototype
  table (`buildFilterTable`, `src/dsp/resample.ts:67`), evaluated as a **rational polyphase bank** when
  `phaseCount = outRate/gcd ≤ MAX_POLYPHASE_PHASES (4096)` (`src/dsp/resample.ts:162,171`) with a
  4-wide-unrolled MAC hot loop (`src/dsp/resample.ts:218`), a stereo specialization sharing the phase
  schedule across both channels (`src/dsp/resample.ts:244`, ADR-224), and a general per-output-sample
  fallback for irrational/huge-phase ratios (`src/dsp/resample.ts:308`). Cutoff drops to the *lower*
  Nyquist `min(in,out)/2` on downsampling (anti-alias) via `cutoff = min(1, ratio)`
  (`src/dsp/resample.ts:177,316`); DC-normalized; zero-extended edges; equal rates return a bit-exact
  copy (`src/dsp/resample.ts:355`).
- **Fade / cross-fade** — `linear` (`t`, `1−t`) and `equal-power` (`sin`, `cos`, the default cross-fade
  curve so `sin²+cos²=1` has no midpoint hole) (`src/dsp/fade.ts:30`); endpoints exact via
  `t = i/(N−1)` (`src/dsp/fade.ts:18`).
- **Dynamics** — `normalizePeak` (linked peak across all channels, preserves stereo image),
  `normalizeRms` (cheap loudness proxy, can exceed ±1 → follow with `limit`), and `limit`
  (`hard` brick-wall / `soft` C¹ slope-matched knee) (`src/dsp/dynamics.ts:87,102,135`). Silence is a
  fixed point (guards the divide, `src/dsp/dynamics.ts:90`).
- **Biquad** — RBJ cookbook coefficients (`designBiquad`, `src/dsp/biquad.ts:70`) in
  **Direct-Form-II-transposed** (best-conditioned for float; recurrence
  `y=b0·x+z1; z1=b1·x−a1·y+z2; z2=b2·x−a2·y`, `src/dsp/biquad.ts:212`), with an analytic
  `magnitudeResponse` (`src/dsp/biquad.ts:175`) and an exact Jury stability check
  (`polesInsideUnitCircle`, `src/dsp/biquad.ts:196`) — the two oracles a response test asserts against.

### 3.6 Streaming twins (the codec seam)

Whole-signal kernels can't run as-is on a *stream of chunks*; each has a `StatefulAudioStage`
(`push`/`flush`, `src/dsp/stream.ts:50`) that is **bit-exactly equal** to the whole-signal result for any
chunk split:

- **Causal, O(1) latency:** `biquad` carries DF2T registers per channel across chunks
  (`src/dsp/biquad.ts:255`); `limit` is per-sample. Framing is preserved 1:1.
- **Bounded look-ahead:** `fade` holds back `H = max(inFrames, outFrames)` frames so a fade-out's tail
  position is known without trusting duration metadata (`src/dsp/fade.ts:231`).
- **Inherently non-causal:** `normalize` (peak/RMS) needs a global stat, so it buffers all decoded chunks
  and runs the exact whole-signal kernels on `flush`, then re-splits to the original framing — the
  correct cost, paid only when normalize is requested (`src/dsp/dynamics.ts:240`,
  `src/dsp/stream.ts:20`).

### 3.7 Validation & benchmark oracle (target)

- **Structural byte-exact oracle:** `pcm-corpus.test.ts` re-encodes decoded PCM against an *independent*
  `data`-chunk locator on the real WAV corpus (`src/dsp/pcm-corpus.test.ts:6`).
- **Baked goldens:** `golden.test.ts` pins recomputed per-fixture PCM digests to committed goldens under
  `fixtures/golden/dsp/` for every WAV fixture (`src/dsp/golden.test.ts:9`).
- **Streaming parity:** `stream.test.ts` feeds arbitrary chunk splits and asserts bit-exact equality with
  the whole-signal kernel.
- **Benchmark family:** the cells in `../media-test/src/scenarios/audio-dsp/index.ts` (resample /
  downmix / gain / fade / format-convert), multi-sample, fresh.

## 4. Current state (what exists today)

The kernels are implemented and validated; the layering is mostly clean (`substrate:'native'` honest,
frames closed once, typed errors). The following are the **precise** current-code facts and smells.

**Owned files (all present):** `src/dsp/{pcm,gain,mix,resample,fade,dynamics,biquad,stream,audio-data,index}.ts`,
`src/filters/audio-dsp.ts`, `src/drivers/pcm-output.ts`, `src/drivers/pcm-transform.ts`.

**Module-global mutable state (resample):**
- `let FILTER_TABLE: Float64Array | undefined` — a lazily-built memoized *constant* (deterministic, fine
  as a cache but is module-global) (`src/dsp/resample.ts:81`).
- `const POLYPHASE_CACHE = new Map<string, PolyphaseBank>()` — keyed by `"inRate:outRate"`, **never
  evicted, no size cap** (`src/dsp/resample.ts:112,185`). Each entry is bounded (≤4096 phases) and the
  set of rate pairs is small in practice, but this is exactly the "module-global mutable cache with
  unbounded growth" smell the target design should bound. It also survives across otherwise-independent
  engine instances / jobs, so it is shared global process state.

**Duplication / DRY smells:**
- `clonePlanar` is re-defined three times — `src/dsp/mix.ts:22`, `src/dsp/fade.ts:46`,
  `src/dsp/dynamics.ts:76` — plus an equivalent `.planar.map(ch => ch.slice())` inline in
  `src/dsp/resample.ts:360` and `src/dsp/biquad.ts` / `gain.ts` output construction. One shared
  `clonePlanar`/`mapSamples`/`buildAudio` helper belongs in `pcm.ts`.
- **s24 decode is implemented twice, differently:** the slow per-sample `DataView.getUint8×3` path in
  `readSample` (`src/dsp/pcm.ts:78`) used by `decodePcm`, and the fast raw-byte path in
  `decodePcmToInterleavedF32` (`src/dsp/pcm.ts:189`). This is both duplication and the source of the perf
  loss below.

**Layering observations (mild):**
- The streaming twins live *inside* the per-effect files (`biquadStage` in `biquad.ts:255`,
  `dynamicsStage` in `dynamics.ts:240`, `fadeStage` in `fade.ts:231`) while `stream.ts` is only a
  re-export barrel that *owns the `StatefulAudioStage` interface* (`src/dsp/stream.ts:50`) but none of
  its implementations. The interface and its implementations are split across files — acceptable, but the
  ownership is inverted from what the barrel implies.
- `src/filters/audio-dsp.ts` (322 lines) mixes three concerns: pure spec dispatch
  (`applyAudioFilter`/`createStatefulStage`, `:77`/`:98`), browser stream wiring
  (`createStateless/StatefulFilterStream`, `:147`/`:192`), and driver+module registration (`:276`/`:314`).
  Not a god-file, but the largest file in the shard and a candidate to split pure-dispatch from
  stream-wiring.

**Capability-message smell:**
- When resample is *policy-disallowed* on the stream-copy path, `applyPcmTransform` throws
  `capability-miss` with the message *"audio resample X→Y Hz needs the WASM/WebAudio tail"*
  (`src/drivers/pcm-transform.ts:207`). This is misleading: resample is pure-TS and never needs
  WASM/WebAudio — the real reason is the caller passed `resample: 'reject'`. The message names backends
  that do not participate (a capability-leak-flavored wording bug).

**Known performance gap (measured, `measured-evidence.md`):**
- `audio-dsp/throughput_decode_s24` on `rotated:03.wav` — **aibrush 58.3 ms vs mediabunny 27.7 ms
  (2.11×), the only active wall-time loss** (`measured-evidence.md`, performance-deficits). Peak memory 33.7 MB
  vs mediabunny 24.0 MB (`measured-evidence.md`, session13 speed-ledger). Root cause: the Float64 `decodePcm` s24
  path is per-sample `DataView` reads (`src/dsp/pcm.ts:78`) while the fast path
  (`decodePcmToInterleavedF32`, `src/dsp/pcm.ts:189`) is raw bytes.

**Measured wins to preserve (regression guards, `measured-evidence.md`):**
- longform 1-hour 44.1k→16k resample closed at **3610.68 ms** (from 12415.14 ms) with peak 462 MB, via
  the direct polyphase FIR (`measured-evidence.md`); bench-dsp resample aggregate **~730× realtime**, worst
  ~401×, checksum 439301100 over the 8-file WAV corpus (`measured-evidence.md`, ADR-058).
- `gain_half_f32` **10.235 ms** (488.5× realtime) vs ffmpeg 14.185 / mediabunny 21.895 (`measured-evidence.md`).
- BS.775 5.1→mono fused kernel **1.084 → 0.477 ms (2.27×)**, 16 temp bytes/frame removed (`measured-evidence.md`,
  ADR-223); stereo polyphase resample **1.570 → 1.105 ms (1.42×)**, bit-exact vs two mono resamples,
  checksum 8.887679169 (`measured-evidence.md`, ADR-224).
- pure-TS baseline (bun, 8 WAV files): remix mono→stereo ~85,800×, stereo→mono ~33,700×, biquad
  highpass ~5,350×, gain −6 dB ~2,850×, encode planar→s16 ~1,660×, resample ~270× geomean / ~146× worst
  (`measured-evidence.md`).

## 5. Delta / punch-list (ordered, actionable)

1. **Fix the s24 decode perf loss.** Give `decodePcm` (Float64) the same raw-byte s24 (and s16/s32) fast
   path already in `decodePcmToInterleavedF32` (`src/dsp/pcm.ts:189`), replacing the per-sample
   `DataView.getUint8×3` in `readSample` (`src/dsp/pcm.ts:78`) — or route both through one shared
   byte-level reader.
   **Acceptance:** re-run `audio-dsp/throughput_decode_s24` on `rotated:03.wav`; assert aibrush median
   ≤ mediabunny (currently 58.3 ms vs 27.7 ms, `measured-evidence.md`) and peak memory within the rival's;
   `pcm-corpus.test.ts` + `golden.test.ts` stay bit-exact.

2. **Bound `POLYPHASE_CACHE`.** Replace the unbounded module-global `Map` (`src/dsp/resample.ts:112`)
   with a bounded LRU (small `N`, e.g. 8–16 rate pairs) *or* make it engine-instance-scoped so it is not
   shared global process state.
   **Acceptance:** a unit test builds >N distinct rate pairs and asserts `cache.size ≤ N` (eviction
   happens); the longform 44.1k→16k resample still returns checksum 439301100 (`measured-evidence.md`, ADR-058)
   proving warm-path correctness is unchanged.

3. **Fix the misleading resample-reject message.** In `applyPcmTransform` (`src/drivers/pcm-transform.ts:207`)
   the `resample:'reject'` path must not claim resample "needs the WASM/WebAudio tail." Reword to state
   the real cause (stream-copy policy disallows a rate change), keeping the `capability-miss` code and
   `op`/`tried`.
   **Acceptance:** a unit test asserts the thrown `CapabilityError.message` does not contain "WASM" or
   "WebAudio" and does name the disallowed rate change; the copy-path routing test still rejects.

4. **De-duplicate `clonePlanar` / audio construction.** Hoist one `clonePlanar`, `mapSamples`, and a
   `buildAudio({sampleRate,channels,frames,planar})` helper into `pcm.ts`; delete the three copies
   (`src/dsp/mix.ts:22`, `src/dsp/fade.ts:46`, `src/dsp/dynamics.ts:76`) and the inline slices
   (`src/dsp/resample.ts:360`).
   **Acceptance:** `grep -c "function clonePlanar" src/dsp/*.ts` returns 1 (in `pcm.ts`); the full
   `src/dsp/*.test.ts` suite stays green with no behavioral change.

5. **Decide & make explicit the integer-rounding policy.** The benchmark oracle notes state
   round-**half-to-even** at the LSB for `gain_minus6db_s16` / `pcm_f32_to_s16`
   (`../media-test/src/scenarios/audio-dsp/index.ts`), but `writeSample` uses `Math.round` (half-away-
   from-zero for positives, toward +∞) (`src/dsp/pcm.ts:110-130`). These differ on exact halves. Either
   switch `writeSample` to round-half-to-even, or bake goldens under the documented policy and record the
   choice.
   **Acceptance:** a table-driven unit test asserts the rounding of exact-half inputs (e.g. ±0.5 LSB) for
   u8/s8/s16/s24/s32 matches the chosen policy; `pcm_f32_to_s16` golden regenerated to match; ADR logged.

6. **Add optional dither for integer downconversion (beat `aformat`).** ffmpeg offers
   triangular/rectangular/high-pass dither on narrowing; today `writeSample` is plain round (no dither,
   `src/dsp/pcm.ts:101`). Add an opt-in TPDF dither at the s24→s16 / f32→s16 boundary, off by default
   (goldens require deterministic output).
   **Acceptance:** with dither off, `golden.test.ts` is unchanged (bit-exact); with dither on (fixed
   seed), a unit test asserts the quantization-noise spectrum is whitened (no correlated distortion at a
   test-tone harmonic) and output is deterministic for the seed.

7. **Generalize `remix` toward a channel matrix (beat `rematrix`).** Today `remix` is a hardcoded switch
   of 5 pairs (`src/dsp/mix.ts:91`); ffmpeg rematrixes arbitrary layouts. Introduce a coefficient-matrix
   remixer (BS.775 for the standard down/upmixes, identity/duplicate for trivial cases) so e.g. 5.1→mono,
   quad, or 7.1 are first-class; keep the typed `CapabilityError` for genuinely undefined layouts.
   **Acceptance:** new cells `downmix_5_1_to_mono` and one unsupported layout: the first matches a
   BS.775-derived golden; the second raises `CapabilityError('capability-miss', …)`; existing 5 pairs
   stay bit-exact.

8. **Split `filters/audio-dsp.ts` pure-dispatch from stream-wiring.** Move `applyAudioFilter` /
   `createStatefulStage` (`src/filters/audio-dsp.ts:77,98`) into a `src/dsp`-side pure module and keep
   only the `TransformStream` wiring + driver registration in `filters/`.
   **Acceptance:** the pure dispatch has Node unit tests with no `v8 ignore` blocks; `filters/audio-dsp.ts`
   shrinks to stream+registration; the eager-bundle budget guard (≤50 kB kernel, `measured-evidence.md`) is not
   regressed.

9. **True-peak / LUFS follow-up (beat `loudnorm`).** `normalizeRms` is a cheap RMS proxy and `limit` is
   sample-peak, not inter-sample (ISP) — documented at `src/dsp/dynamics.ts:11,17`. Add an oversampled
   true-peak limiter (reuse the resampler for 4× analysis) and a K-weighted LUFS normalize, opt-in.
   **Acceptance:** a unit test on a signal whose reconstructed peak exceeds its sample peak asserts the
   true-peak limiter holds the 4×-oversampled peak ≤ ceiling (the sample-peak limiter does not);
   ADR logged.

10. **Guard resample abort latency & irrational-ratio fallback.** The fallback path
    (`src/dsp/resample.ts:308`) is O(outFrames·tapCount) and used when `phaseCount > 4096` or `inRate`
    non-integer; ensure the abort check (`src/dsp/resample.ts:321`) bounds latency there too.
    **Acceptance:** a test resamples a coprime pair (e.g. 44100→44101, forcing the fallback) under an
    `AbortSignal` aborted mid-run and asserts it throws `MediaError('aborted')` within one
    `ABORT_CHECK_INTERVAL` window; output for a completed run matches a golden.

## 6. Open questions (seed `docs/decisions/`)

1. **Integer-rounding policy** — round-half-to-even (matches the benchmark oracle notes) vs the current
   `Math.round` half-away (`src/dsp/pcm.ts:110`)? Decide the canonical policy for all integer widths and
   whether goldens follow the code or vice-versa. (Blocks delta #5.)

2. **Dither** — should integer downconversion dither by default, or stay deterministic-by-default with
   dither opt-in? Deterministic output is required by the byte-exact goldens; dither improves perceptual
   quality but breaks bit-reproducibility. (Blocks delta #6.)

3. **`POLYPHASE_CACHE` scope & lifetime** — process-global (current), engine-instance-scoped, or
   bounded-LRU? Global sharing helps repeated same-rate jobs but is hidden cross-job state. (Blocks
   delta #2.)

4. **Resample quality tier** — is the fixed 80 dB Kaiser kernel (`β=9.42`, 32 zero-crossings, 512 phases,
   `src/dsp/resample.ts:31`) the only tier, or should we expose a fast/HQ/VHQ knob (soxr-style) for the
   longform path where ~270× realtime is the floor (`measured-evidence.md`)? Fixed = reproducible; a knob = better
   worst-case throughput.

5. **Channel-order assumption** — `remix` hardcodes 5.1 as `L,R,C,LFE,Ls,Rs` (`src/dsp/mix.ts:53`). Do we
   need to honor a source's declared channel-layout (WAV `dwChannelMask`, ffmpeg `SL/SR` vs `BL/BR`)
   before rematrix, or is the SMPTE/WAV default sufficient for the corpus? (Informs delta #7.)

6. **Loudness normalization semantics** — is `normalizeRms` (RMS proxy) enough, or do we commit to
   EBU R128 LUFS + true-peak as the public "normalize"? Affects API naming and the dynamics contract.
   (Blocks delta #9.)

7. **Cross-fade / extra fade curves** — we ship only `linear` + `equal-power` (`src/dsp/fade.ts:27`);
   ffmpeg `afade` offers ~15 curves. Do any benchmark/real cells need them, or is two the SOTA-minimal
   set? (Low priority.)
