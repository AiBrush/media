/** Tiny normalized identity for raw live MediaStream sources; processor code stays lazy. */

import { CapabilityError, InputError } from '../contracts/errors.ts';

/** A normalized live source, deliberately distinct from the byte-oriented `Source` contract. */
export interface LiveMediaSource {
  readonly __media: 'live-source';
  readonly kind: 'media-stream';
  readonly mediaStream: MediaStream;
}

interface CaptureCapableElement {
  captureStream?: () => unknown;
}

/** Normalize a caller-owned `MediaStream` without converting it into a byte source. */
export function fromMediaStream(mediaStream: MediaStream): LiveMediaSource {
  if (!isMediaStreamShape(mediaStream)) {
    throw new InputError('invalid MediaStream input');
  }
  return { __media: 'live-source', kind: 'media-stream', mediaStream };
}

/** Explicit `<video>/<audio>` capture mode; never used by the default element-bytes path. */
export function captureElementMediaStream(element: HTMLMediaElement): LiveMediaSource {
  const capture = (element as unknown as CaptureCapableElement).captureStream;
  if (typeof capture !== 'function') {
    throw new CapabilityError('HTMLMediaElement.captureStream is unavailable', {
      op: { kind: 'route', id: 'fromElement(capture)' },
      tried: ['captureStream'],
    });
  }
  let captured: unknown;
  try {
    captured = capture.call(element);
  } catch (error) {
    throw new CapabilityError(
      'HTMLMediaElement.captureStream failed',
      { op: { kind: 'route', id: 'fromElement(capture)' }, tried: ['captureStream'] },
      { cause: error },
    );
  }
  if (!isMediaStreamShape(captured)) {
    throw new CapabilityError('HTMLMediaElement.captureStream returned no MediaStream', {
      op: { kind: 'route', id: 'fromElement(capture)' },
      tried: ['captureStream'],
    });
  }
  return fromMediaStream(captured);
}

/** Type guard for the live source brand. */
export function isLiveMediaSource(value: unknown): value is LiveMediaSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly __media?: unknown }).__media === 'live-source' &&
    (value as { readonly kind?: unknown }).kind === 'media-stream' &&
    isMediaStreamShape((value as { readonly mediaStream?: unknown }).mediaStream)
  );
}

/** Resolve either a normalized live source or a cross-realm structural MediaStream. */
export function mediaStreamOf(value: unknown): MediaStream | undefined {
  if (isLiveMediaSource(value)) return value.mediaStream;
  if (isMediaStreamShape(value)) return value;
  return undefined;
}

/** Internal cross-realm guard shared by normalization and the lazy live processor module. */
export function isMediaStreamShape(value: unknown): value is MediaStream {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly getTracks?: unknown }).getTracks === 'function' &&
    typeof (value as { readonly getVideoTracks?: unknown }).getVideoTracks === 'function' &&
    typeof (value as { readonly getAudioTracks?: unknown }).getAudioTracks === 'function'
  );
}
