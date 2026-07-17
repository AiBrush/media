/**
 * Browser runtime capability detection for the tier layer (docs/architecture/04). These predicates
 * gate which filter substrates are even offered to the router — cheap, synchronous, and honest in
 * Node (everything reports `false` where the platform objects are absent). UA sniffing lives only
 * here, never in driver/registration modules, so a capability rule changes in exactly one place.
 */

function userAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

/** True for a Firefox UA — WebGPU `VideoFrame` import and canvas HDR tonemap are not usable there. */
export function isFirefoxUa(): boolean {
  return /\bFirefox\//.test(userAgent());
}

/** True for a Chromium-family UA (Chrome, Chromium, iOS Chrome, Edge) and not Firefox. */
export function isChromiumUa(): boolean {
  return /\b(?:Chrome|Chromium|CriOS|Edg)\//.test(userAgent()) && !isFirefoxUa();
}

/** True when the WebGPU video-filter substrate can run: `navigator.gpu` + canvas + `VideoFrame`. */
export function webgpuAvailable(): boolean {
  if (isFirefoxUa()) return false;
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoFrame !== 'undefined'
  );
}

/** True when the Canvas2D video-filter substrate can run (`OffscreenCanvas` + `VideoFrame`). */
export function canvas2dAvailable(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/** True where canvas drawImage tonemaps HDR frames natively (Chromium-family engines only). */
export function chromiumCanvasTonemapAvailable(): boolean {
  return isChromiumUa();
}
