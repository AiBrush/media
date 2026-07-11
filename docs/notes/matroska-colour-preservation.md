# Matroska Colour preservation

## Design note

Codec-packet and decoded-YUV equality is insufficient for browser presentation equality. Matroska Colour
controls range, H.273 conversion, and chroma siting; dropping it can change Chromium's YUV-to-RGB/chroma
upsampling and therefore canvas pixels. The driver now carries raw numeric values independently from the
smaller `VideoColorSpaceInit` vocabulary: known values configure WebCodecs, unknown-safe values still
round-trip, and a source with no Colour remains untagged.

The real rotation matrix covers horizontal/vertical siting, limited range, and a no-Colour control. The
validation re-muxes their real VP9/Opus packets, checks every raw field and packet/timestamp manifest, and
uses ffprobe's `chroma_location`/range output as the independent presentation-metadata oracle.
