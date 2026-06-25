//! Pure-Rust MP3 decoder compiled to WebAssembly for aibrush-media's miss-only WASM tail
//! (docs/architecture/04 wasm tier, ADR-032 — the Vorbis sibling's decision applies verbatim to MP3).
//! Wraps Symphonia's `symphonia-bundle-mp3` (`MpaDecoder`, pure Rust, no C) behind `wasm-bindgen`,
//! exposing a tiny `Mp3Wasm` object the TS driver drives: construct it (MP3 is self-describing — no codec
//! `extra_data`/`description` is needed, unlike Vorbis), then feed one MP3 frame at a time and read back
//! **interleaved f32** PCM. No container demuxing here — the bit reservoir carries inter-frame state
//! inside the single decoder instance, so the driver simply feeds frames in order.
//!
//! Built with `wasm-pack build --target web` → `mp3_wasm_bg.wasm` + `mp3_wasm.js` glue, vendored into the
//! parent directory as `mp3_wasm_bg.wasm` + `mp3-core.js` (see ../BUILD.md).

use symphonia_bundle_mp3::MpaDecoder;
use symphonia_core::audio::GenericAudioBufferRef;
use symphonia_core::codecs::audio::well_known::CODEC_ID_MP3;
use symphonia_core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions};
use symphonia_core::packet::PacketRef;
use symphonia_core::units::{Duration, Timestamp};
use wasm_bindgen::prelude::*;

/// A live MP3 decoder over one logical stream. Holds Symphonia's stateful `MpaDecoder` (MP3's bit
/// reservoir means a frame's main-data can reference up to ~511 bytes of the *previous* frame, so the
/// decoder must persist across packets), plus the channel count / sample rate so the driver can shape its
/// `AudioData` planes. The decoded buffer's own spec is authoritative and is reconciled on each `decode`.
#[wasm_bindgen]
pub struct Mp3Wasm {
    decoder: MpaDecoder,
    channels: u32,
    sample_rate: u32,
    /// Reused interleaved-output scratch to avoid a fresh allocation per frame.
    scratch: Vec<f32>,
}

#[wasm_bindgen]
impl Mp3Wasm {
    /// Build an MP3 (Layer III) decoder. MP3 carries no codec-private headers — every frame's header
    /// declares its own bitrate / sample rate / channel mode — so construction needs only the
    /// container-declared geometry hints (`channels`/`sample_rate`, from the WebCodecs
    /// `AudioDecoderConfig`) to seed `channels()`/`sampleRate()` before the first decoded frame. Those
    /// values are reconciled with the decoded buffer's own spec on every `decode` (the decoded spec wins
    /// if it differs), so they are authoritative either way. Returns `Err(message)` if Symphonia rejects
    /// the codec, so the JS side raises a typed `MediaError`.
    #[wasm_bindgen(constructor)]
    pub fn new(channels: u32, sample_rate: u32) -> Result<Mp3Wasm, String> {
        let mut params = AudioCodecParameters::new();
        params.for_codec(CODEC_ID_MP3);

        let decoder = MpaDecoder::try_new(&params, &AudioDecoderOptions::default())
            .map_err(|e| format!("mp3 init: {e}"))?;

        Ok(Mp3Wasm { decoder, channels, sample_rate, scratch: Vec::new() })
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

    /// Decode one MP3 frame into interleaved f32 PCM (`frames × channels` values — 1152 frames for
    /// MPEG-1 Layer III, 576 for MPEG-2/2.5). Symphonia converts its internal sample format to f32 and
    /// interleaves L,R,L,R… for us. A frame that decodes to zero samples (rare, e.g. a stray empty frame)
    /// is returned as an empty slice. Errors are returned as `Err(message)` for a typed JS error.
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<f32>, String> {
        let packet = PacketRef::new(0, Timestamp::from(0i64), Duration::from(0u64), data);
        let decoded: GenericAudioBufferRef<'_> =
            self.decoder.decode_ref(&packet).map_err(|e| format!("mp3 decode: {e}"))?;

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
        decoded.copy_to_vec_interleaved::<f32>(&mut self.scratch);
        Ok(self.scratch.clone())
    }

    /// Reset decoder state at a discontinuity (seek). After a reset the bit reservoir is cleared, exactly
    /// as at stream start; the next frame decodes self-contained.
    pub fn reset(&mut self) {
        self.decoder.reset();
    }
}
