/**
 * Video filter-chain PLANNING (docs/architecture/09) — the pure builder that turns a public
 * {@link VideoTarget} into the ordered GPU {@link FilterSpec} chain the engine composes on a decoded video
 * stream before the encoder (**crop → resize → rotate → flip → colorspace → tonemap**).
 *
 * Why a SEPARATE module (split out of `codec-pipeline.ts`): `videoFilterSpecs` is reached ONLY on the
 * convert-with-video-filter path (a live, browser-only decode→filter→encode). Keeping it here, behind the
 * engine's lazy `import('./video-stream-plan.ts')` rather than the static `codec-pipeline.ts` edge, keeps it
 * OUT of the eager kernel closure (BUILD §2, doc 08 §7 byte budget). The geometry math an eager encode DOES
 * touch — `outputDimensions` (which sizes the `VideoEncoderConfig`) and the {@link SourceGeometry} type —
 * stays in `codec-pipeline.ts`; this module imports the type only (erased). Pure: every spec is a plain
 * object, so the chain is Node-validated; the GPU substrate that runs it is browser-only (BUILD §6.1).
 */

import type { FilterSpec } from '../contracts/driver.ts';
import { InputError } from '../contracts/errors.ts';
import type { SourceGeometry } from './codec-pipeline.ts';
import type { VideoTarget } from './types.ts';

/**
 * Build the ordered GPU {@link FilterSpec} chain for a {@link VideoTarget}: **crop → resize → rotate →
 * flip → colorspace → tonemap**, each emitted only when the target requests it. Order matters — crop
 * selects a source sub-rect first, then resize scales it to the requested output, then orientation, then
 * full-frame colour conversion. A `resize` is emitted when width/height are given (or implied by a
 * non-identity `fit` against known source dims); `rotate`/`flip` pass straight through. Pure: every spec
 * is a plain object, so the whole chain is Node-validated; the GPU substrate that runs it is
 * browser-only. Empty array ⇒ no filters (the decode→encode is direct).
 */
export function videoFilterSpecs(target: VideoTarget, src: SourceGeometry): FilterSpec[] {
  const specs: FilterSpec[] = [];
  if (target.crop) {
    const { x, y, width, height } = target.crop;
    if (width <= 0 || height <= 0) {
      throw new InputError('unsupported-input', `crop ${width}x${height} must be positive`);
    }
    specs.push({ mediaType: 'video', type: 'crop', x, y, width, height });
  }
  if (target.width !== undefined || target.height !== undefined) {
    const width = target.width ?? src.width;
    const height = target.height ?? src.height;
    if (width === undefined || height === undefined) {
      throw new InputError(
        'unsupported-input',
        'resize needs both width and height (source dimensions are unknown; pass both)',
      );
    }
    if (width <= 0 || height <= 0) {
      throw new InputError('unsupported-input', `resize ${width}x${height} must be positive`);
    }
    specs.push({
      mediaType: 'video',
      type: 'resize',
      width,
      height,
      ...(target.fit !== undefined ? { fit: target.fit } : {}),
    });
  }
  if (target.rotate !== undefined && target.rotate !== 0) {
    specs.push({ mediaType: 'video', type: 'rotate', degrees: target.rotate });
  }
  if (target.flip !== undefined) {
    specs.push({ mediaType: 'video', type: 'flip', axis: target.flip });
  }
  if (target.colorspace !== undefined) {
    const to = target.colorspace.to.trim();
    if (to.length === 0) {
      throw new InputError('unsupported-input', 'colorspace target must be a non-empty string');
    }
    specs.push({ mediaType: 'video', type: 'colorspace', to });
  }
  if (target.tonemap !== undefined) {
    const to = (target.tonemap as { to?: unknown }).to;
    if (to !== 'sdr') {
      throw new InputError('unsupported-input', `tonemap target '${String(to)}' is not supported`);
    }
    specs.push({ mediaType: 'video', type: 'tonemap', to: 'sdr' });
  }
  return specs;
}
