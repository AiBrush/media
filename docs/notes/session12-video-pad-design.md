# Session 12 video pad design

## Truth before change

The binding goals and operation architecture list video `pad`, but `VideoTarget`, `FilterSpec`, filter
planning, output geometry, and every substrate omit it. The API therefore cannot express the documented
feature. The architecture does not define a colour grammar, so adding a CSS parser or an unbounded colour
surface would invent unrelated scope.

## Contract and order

Add `video.pad: { width, height, x?, y? }`. Padding runs **crop → resize → pad → rotate → flip → colour**.
`width`/`height` are the padded canvas dimensions. `x`/`y` place the current frame's top-left corner and
default to centered integer placement. The untouched area is transparent RGBA zero; codecs without alpha
encode the zero RGB background as black, while VPx alpha-preserving targets retain transparency. Padding
never scales or crops: the canvas must be at least as large as the current frame and placement must keep the
complete frame in bounds.

## Edge cases and ownership

- Dimensions and offsets must be positive/non-negative safe integers; odd dimensions and asymmetric
  one-pixel remainders use floor-centering deterministically.
- Unknown source dimensions can still be planned at the public target level, but concrete per-frame
  planning validates the actual decoded dimensions before allocation.
- A no-op pad equal to the current dimensions is omitted by the target planner, avoiding a pixel round trip.
- Rotation 90/270 swaps the padded dimensions after placement. VFR timestamps, B-frame presentation order,
  seek semantics, and frame durations are unchanged.
- The existing filter stream owns and closes each input `VideoFrame` once in `finally`; pad creates exactly
  one output frame and inherits cancellation/backpressure without buffering additional frames.
- CPU exact blit, Canvas2D clear canvas, and WebGPU clear render target must agree byte-for-byte on the
  transparent border and copied source pixels.

## Implementation and proof

Represent pad as the existing `Blit` shape: a larger output `dims`, the full source rect, and an equal-size
destination rect at the resolved offset. Add the spec to all geometric type guards and dispatchers, include
pad in transcode/alpha-bypass decisions, and update encoder output dimensions. Fail-first pure tests assert
exact recipes, source-pixel preservation, transparent borders, invalid placements, ordering, and dimension
swaps. Browser filter tests cover the shared renderer seam; a fresh multi-sample CPU recipe benchmark guards
the new path. ADR-234 records the additive public/driver-contract decision.

The fresh command `bun run bench-session12-video-pad` uses three warmups and 21 measured samples over a
640x360 RGBA source centered into a 720x480 transparent canvas. The current median is **1.373 ms**, or
**251.6 MPix/s**; a border-alpha sink guard prevents dead-code elimination.
