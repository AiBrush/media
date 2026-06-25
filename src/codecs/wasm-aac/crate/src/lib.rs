//! Pure-Rust AAC (AAC-LC) decoder compiled to WebAssembly for aibrush-media's miss-only WASM tail
//! (docs/architecture/04 wasm tier, ADR-037). Wraps Symphonia's `symphonia-codec-aac` (no C) behind
//! `wasm-bindgen`, exposing a tiny `AacWasm` object the TS driver drives: construct from the codec
//! `extra_data` (the AudioSpecificConfig — i.e. the WebCodecs `AudioDecoderConfig.description`) plus the
//! container-declared channels/sample-rate, then feed one **raw AAC packet** (no ADTS header — the TS
//! side strips it) at a time and read back **interleaved f32** PCM.
//!
//! Symphonia's AAC decoder is AAC-LC only (it rejects SBR/HE-AAC, > 2 channels, or non-1024-sample
//! frames as "too complex"); that covers the overwhelming-majority AAC-LC streams a fallback serves. No
//! demuxing here — the container (MP4/ADTS) is handled in TS; this is purely codec packets in, samples
//! out. Built with `wasm-pack build --target web` → `aac_wasm_bg.wasm` + glue, vendored into the parent
//! directory as `aac_wasm_bg.wasm` + `aac-core.js` (see ../BUILD.md).

use symphonia_codec_aac::AacDecoder;
use symphonia_core::audio::{Channels, GenericAudioBufferRef};
use symphonia_core::codecs::audio::well_known::CODEC_ID_AAC;
use symphonia_core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions};
use symphonia_core::packet::PacketRef;
use symphonia_core::units::{Duration, Timestamp};
use wasm_bindgen::prelude::*;

/// A live AAC-LC decoder over one logical stream. Holds Symphonia's decoder plus the channel count and
/// sample rate (container-declared, reconciled with the decoded buffer's own spec) so the driver can
/// shape its `AudioData` planes.
#[wasm_bindgen]
pub struct AacWasm {
    decoder: AacDecoder,
    channels: u32,
    sample_rate: u32,
    /// Reused interleaved-output scratch to avoid a fresh allocation per packet.
    scratch: Vec<f32>,
}

#[wasm_bindgen]
impl AacWasm {
    /// Build a decoder from the AAC codec `extra_data` (the AudioSpecificConfig). When `extra_data` is
    /// empty — e.g. an ADTS source has no ASC — Symphonia synthesizes a default AAC-LC ASC from the
    /// `channels`/`sample_rate` arguments (which the TS side reads from the ADTS header / MP4 esds). A
    /// non-AAC-LC stream (SBR/HE/>2ch) is rejected by Symphonia and surfaced here as `Err(message)`.
    #[wasm_bindgen(constructor)]
    pub fn new(extra_data: &[u8], channels: u32, sample_rate: u32) -> Result<AacWasm, String> {
        let mut params = AudioCodecParameters::new();
        params.for_codec(CODEC_ID_AAC);
        if sample_rate > 0 {
            params.with_sample_rate(sample_rate);
        }
        if let Some(ch) = channels_from_count(channels) {
            params.with_channels(ch);
        }
        if extra_data.len() >= 2 {
            params.with_extra_data(extra_data.to_vec().into_boxed_slice());
        }

        let decoder = AacDecoder::try_new(&params, &AudioDecoderOptions::default())
            .map_err(|e| format!("aac init: {e}"))?;

        Ok(AacWasm { decoder, channels, sample_rate, scratch: Vec::new() })
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

    /// Decode one **raw** AAC packet (no ADTS header) into interleaved f32 PCM (`frames × channels`).
    /// AAC-LC yields exactly 1024 samples per channel per frame. Errors are returned as `Err(message)`
    /// for a typed JS error.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<f32>, String> {
        let packet = PacketRef::new(0, Timestamp::from(0i64), Duration::from(0u64), data);
        let decoded: GenericAudioBufferRef<'_> =
            self.decoder.decode_ref(&packet).map_err(|e| format!("aac decode: {e}"))?;

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

    /// Reset decoder state at a discontinuity (seek).
    pub fn reset(&mut self) {
        self.decoder.reset();
    }
}

/// Build the **positioned** AAC channel layout for a channel-configuration index (1 = mono → FRONT_CENTER,
/// 2 = stereo → FRONT_LEFT|FRONT_RIGHT, …) using the exact mapping Symphonia's own ADTS reader uses
/// (`get_mpeg4_audio_channels_by_config_index`). AAC-LC decode indexes channels by position, so a raw
/// `Discrete` layout would panic in the channel-element setup — this returns the canonical layout. A 0
/// count (config "escape", or unknown) yields `None` so Symphonia falls back to the ASC.
fn channels_from_count(count: u32) -> Option<Channels> {
    use symphonia_common::mpeg::audio::{
        get_mpeg4_audio_channels_by_config_index, Mpeg4AudioChannels,
    };
    match get_mpeg4_audio_channels_by_config_index(count) {
        Mpeg4AudioChannels::Channels(channels) => Some(channels),
        _ => None,
    }
}
