# Video-filter routing by total pixel work

## Design boundary

The fair-harness result exposed a routing bug, not an encoder or GPU-kernel defect: a 0.1-second 4K resize
was treated as tiny because `RouteCost` combined independent metrics with logical OR. That selected the
native CPU filter, whose full-RGBA scaling cost is proportional to every source and destination pixel, even
though duration alone looked small. The correction is deliberately confined to filter planning and routing.

For a video filter chain, the engine now computes:

```text
frames = max(1, ceil(durationSeconds × max(sourceFps, targetFps)))
pixelWork = (sourceWidth × sourceHeight + outputWidth × outputHeight) × frames
```

An unknown frame rate uses the existing 30 fps encoder-planning default; an unknown duration represents at
least one frame. The output geometry is the actual post-crop/resize/rotation geometry. Work is emitted only
when both source and output areas are known, so incomplete geometry cannot understate the source read. A
non-finite multiplication saturates to `Number.MAX_VALUE`, which keeps it on the normal GPU-first route.

The tiny boundary is 245,760 pixel operations: source read plus destination write for an identity 64×64
clip over 30 frames. This preserves the prior tiny boundary in its intended two-dimensional case without
allowing a short duration to classify a large frame as cheap. Video filters use only this compound metric.
Codec selection and audio-filter cost rules remain unchanged, as do force-software substrate removal and
the positive-verdict cache's tiny/normal partition.

## Edge cases and proof

- A 0.1-second 3840×2160 → 1920×1080 transform is 31,104,000 pixel operations and routes GPU-first.
- A single-frame 640×360 → 320×180 transform is 288,000 operations, just above the tiny boundary.
- 1920×1080 → 1280×720 over one second at 30 fps is 89,856,000 operations.
- Frame-rate conversion uses the higher of input and output cadence: both 15→30 and 30→15 account for 30
  frame touches per second rather than understating either duplication or source consumption.
- Duration by itself cannot make a dimensionless colour operation tiny. Missing source geometry keeps the
  normal route. `force-software` still selects Canvas/native after GPU substrates are removed.
- A close-once cancellation test consumes one 30→60 output, then cancels with a pending duplicate and a
  lookahead input; every owned input and output is closed exactly once.
- Audio-frame routing is pinned separately so the modality-specific video rule cannot change audio behavior.

The focused fail-first run failed on the new route-cost and threshold contracts. After implementation,
170 focused tests pass. The updated pure planner benchmark runs 100,000 mixed rate/filter/work plans with
nine measured samples: 112.734 ms median and a 2.69 MiB RSS delta on Bun 1.3.14. Browser performance is
intentionally left to the black-box fair harness; no harness implementation was inspected.

## Rejected alternatives

Duration OR pixel area remains dimensionally invalid. Output area alone misses large-source downscales.
Source area alone misses upscales. Routing every video operation to native would retain the regression;
routing every operation to GPU would discard the measured tiny-work optimization. Fixture names, hashes,
scenario-specific thresholds, encoder changes, GPU-kernel changes, and oracle changes are outside this fix.
