# WebM Opus gapless preservation

## Design note

The rotated VP9/Opus corpus proved a container-level loss: packet bytes survived demux/mux, but
`CodecDelay` and terminal `DiscardPadding` did not. Opus packets remain predictive codec input and must
not be cut; the correct seam is metadata. The implementation parses signed Matroska nanoseconds, converts
them on Opus' fixed 48 kHz clock, derives coded duration from each packet TOC, and carries exact
leading/trailing/total sample facts through `TrackInfo`. Writers restore the raw Block clock only for
timestamps a WebM demux had delay-adjusted, emit OpusHead + CodecDelay + SeekPreRoll, and attach terminal
DiscardPadding without changing payloads or buffering the streaming path.

Independent oracle command shape:

```sh
ffprobe -select_streams a:0 -show_packets -show_entries packet=side_data_list input.webm
ffmpeg -i input.webm -map 0:a:0 -f s16le - | wc -c
```

At stereo s16, decoded samples are `bytes / 4`. All four source/output pairs match exactly.
