# HEVC-in-Matroska: valid mux versus Chromium platform playback

The remaining `mux/edge_hevc_decode_mux_mkv` red is not a malformed aibrush-media MKV. The exact
baked `hevc_1080p_10s.mp4` source was sent through the same prepared Matroska writer and independently
checked:

- ffprobe identifies a 1920×1080 HEVC track with 300 packets and the complete 2,421-byte
  `HEVCDecoderConfigurationRecord`, plus the 470-packet AAC track;
- ffmpeg decodes the first 12 video frames at 1920×1080 and emits stable frame hashes;
- the separate fair-harness `remux/hevc_1080p_10s_mp4_to_mkv` cell passes its structural reimport with
  both media tracks and zero duration drift;
- the July 1 exported harness result for the mux cell passed 12/12 frame digests when decode used the
  media engine; the current cell instead fails only when Chromium `<video>` is asked to play HEVC in a
  Matroska container and reports zero intrinsic size.

The current Matroska codec mapping requires `V_MPEGH/ISO/HEVC` Blocks to contain ISO/IEC 14496-15 HEVC
pictures and `CodecPrivate` to contain the `HEVCDecoderConfigurationRecord`; the output does exactly
that. WebCodecs' HEVC registration likewise defines canonical (`hevc`) access units and the out-of-band
decoder configuration used here. Re-encoding or relabeling the stream merely to satisfy an unsupported
HTML-media container/codec combination would violate packet-mux semantics and the no-fake rule. The
platform-playback oracle must gate this cell on Chromium's HEVC-in-Matroska support or decode through
the engine as its previously passing version did.

Authoritative mappings:

- <https://www.ietf.org/archive/id/draft-ietf-cellar-codec-18.html#name-v_mpegh-iso-hevc>
- <https://www.w3.org/TR/webcodecs-hevc-codec-registration/>

