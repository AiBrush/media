//! Pure-Rust Vorbis decoder compiled to WebAssembly for aibrush-media's miss-only WASM tail
//! (docs/architecture/04 wasm tier, ADR-032). Wraps Symphonia's `symphonia-codec-vorbis` (no C) behind
//! `wasm-bindgen`, exposing a tiny `VorbisWasm` object the TS driver drives: construct from the codec
//! `extra_data` (the Vorbis identification + setup headers — i.e. the WebCodecs
//! `AudioDecoderConfig.description`, xiph-laced or concatenated), then feed one Ogg/WebM audio packet at
//! a time and read back **interleaved f32** PCM. No Ogg demuxing here — the container is handled in TS;
//! this is purely codec packets in, samples out.
//!
//! Built with `wasm-pack build --target web` → `vorbis_wasm_bg.wasm` + `vorbis_wasm.js` glue, vendored
//! into the parent directory as `vorbis_wasm_bg.wasm` + `vorbis-core.js` (see ../BUILD.md).

use symphonia_codec_vorbis::VorbisDecoder;
use symphonia_core::audio::GenericAudioBufferRef;
use symphonia_core::codecs::audio::well_known::CODEC_ID_VORBIS;
use symphonia_core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions};
use symphonia_core::packet::PacketRef;
use symphonia_core::units::{Duration, Timestamp};
use wasm_bindgen::prelude::*;

/// A live Vorbis decoder over one logical stream. Holds Symphonia's stateful decoder (Vorbis carries
/// inter-packet state via the previous block flag / overlap-add), plus the channel count read from the
/// identification header so the driver can shape its `AudioData` planes.
#[wasm_bindgen]
pub struct VorbisWasm {
    decoder: VorbisDecoder,
    channels: u32,
    sample_rate: u32,
    /// Reused interleaved-output scratch to avoid a fresh allocation per packet.
    scratch: Vec<f32>,
}

#[wasm_bindgen]
impl VorbisWasm {
    /// Build a decoder from the Vorbis codec `extra_data` (the identification + setup headers, as the
    /// container exposed them — Symphonia accepts both the xiph-laced `0x02`-led blob and a plain
    /// `ident‖setup` concatenation). Channel count and sample rate are parsed from the identification
    /// header by Symphonia; we surface them via `channels()` / `sample_rate()`. Returns `Err(message)`
    /// on malformed headers so the JS side raises a typed `MediaError`.
    ///
    /// `channels`/`sample_rate` are the container-declared geometry (from the WebCodecs
    /// `AudioDecoderConfig`); they seed `channels()`/`sampleRate()` so the driver can shape its output
    /// before the first block, and are reconciled with the decoded buffer's own spec on each `decode`
    /// (the decoded spec always wins if it differs, so the values are authoritative either way).
    #[wasm_bindgen(constructor)]
    pub fn new(extra_data: &[u8], channels: u32, sample_rate: u32) -> Result<VorbisWasm, String> {
        if extra_data.is_empty() {
            return Err("vorbis: empty extra_data (no identification/setup headers)".to_string());
        }
        let mut params = AudioCodecParameters::new();
        params
            .for_codec(CODEC_ID_VORBIS)
            .with_extra_data(extra_data.to_vec().into_boxed_slice());

        let decoder = VorbisDecoder::try_new(&params, &AudioDecoderOptions::default())
            .map_err(|e| format!("vorbis init: {e}"))?;

        Ok(VorbisWasm { decoder, channels, sample_rate, scratch: Vec::new() })
    }

    /// Channel count of the decoded PCM (container-declared, reconciled with the decoded spec).
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    /// Sample rate in Hz of the decoded PCM (container-declared, reconciled with the decoded spec).
    #[wasm_bindgen(getter, js_name = sampleRate)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Decode one Vorbis audio packet into interleaved f32 PCM (`frames × channels` values). An audio
    /// packet (the first 1–3 setup packets are consumed during `new`) yields one block of overlap-added
    /// samples; the very first audio packet may legitimately decode to zero frames (overlap priming),
    /// which is returned as an empty slice. Errors are returned as `Err(message)` for a typed JS error.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<f32>, String> {
        let packet = PacketRef::new(0, Timestamp::from(0i64), Duration::from(0u64), data);
        let decoded: GenericAudioBufferRef<'_> =
            self.decoder.decode_ref(&packet).map_err(|e| format!("vorbis decode: {e}"))?;

        let frames = decoded.frames();
        let spec = decoded.spec();
        let channels = spec.channels().count();
        // The decoded buffer's spec is the authoritative geometry — reconcile our reported values.
        if channels > 0 {
            self.channels = channels as u32;
        }
        if spec.rate() > 0 {
            self.sample_rate = spec.rate();
        }
        self.scratch.clear();
        self.scratch.reserve(frames * channels);
        // Symphonia converts its internal sample format to f32 and interleaves L,R,L,R… for us.
        decoded.copy_to_vec_interleaved::<f32>(&mut self.scratch);
        Ok(self.scratch.clone())
    }

    /// Reset decoder state at a discontinuity (seek). After a reset the next packet primes overlap-add
    /// afresh, exactly as at stream start.
    pub fn reset(&mut self) {
        self.decoder.reset();
    }
}
