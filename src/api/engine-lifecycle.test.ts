/**
 * Engine lifecycle (R-S05.4 dispose / ADR-321) and the resettable bare-function default instance
 * (R-S05.5). Strict oracles: post-dispose ops throw the typed `MediaError('aborted','engine disposed')`
 * synchronously (never resurrect torn-down pools), dispose is idempotent, `Symbol.asyncDispose`
 * delegates to it, and `resetDefaultMedia()` gives the next bare call a *fresh* engine while anything
 * still holding the old one observes typed disposed failures — the SSR no-shared-state guarantee.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MediaError } from '../contracts/errors.ts';
import * as sugar from './create-media.ts';
import { createMedia } from './create-media.ts';

const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media');
const wavBytes = (): Uint8Array =>
  Uint8Array.from(readFileSync(resolve(MEDIA, 'sfx-pcm-s16.wav')));

function expectDisposedError(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable('expected a typed disposed error');
  } catch (e) {
    expect(e).toBeInstanceOf(MediaError);
    expect((e as MediaError).code).toBe('aborted');
    expect((e as MediaError).message).toContain('engine disposed');
  }
}

describe('MediaEngine.dispose (R-S05.4 / ADR-321)', () => {
  it('is idempotent and turns every subsequent op into a typed synchronous MediaError', async () => {
    const engine = createMedia();
    const info = await engine.probe(wavBytes());
    expect(info.container).toBe('wav');

    await engine.dispose();
    await engine.dispose(); // idempotent — never throws on repeat

    const bytes = wavBytes();
    expectDisposedError(() => engine.probe(bytes));
    expectDisposedError(() => engine.demux(bytes));
    expectDisposedError(() => engine.convert(bytes, { to: 'wav' }));
    expectDisposedError(() => engine.trim(bytes, { start: 0, end: 1 }));
    expectDisposedError(() => engine.decode(bytes));
    expectDisposedError(() => engine.seek(bytes, 0));
    expectDisposedError(() => engine.load(bytes));
    expectDisposedError(() => engine.canConvert({ to: 'wav' }));
    await expect(engine.preload()).rejects.toMatchObject({ message: 'engine disposed' });
  });

  it('exposes Symbol.asyncDispose delegating to dispose()', async () => {
    const engine = createMedia();
    await engine[Symbol.asyncDispose]();
    expectDisposedError(() => engine.probe(wavBytes()));
  });

  it('supports `await using` scope-exit disposal', async () => {
    let leaked: ReturnType<typeof createMedia> | undefined;
    {
      await using engine = createMedia();
      leaked = engine;
      const info = await engine.probe(wavBytes());
      expect(info.tracks[0]?.codec).toBe('pcm-s16');
    }
    // Scope exit disposed the engine: the leaked reference now refuses ops with the typed error.
    expectDisposedError(() => (leaked as ReturnType<typeof createMedia>).probe(wavBytes()));
  });

  it('clears the preload task cache so a disposed engine cannot serve stale warmups', async () => {
    const engine = createMedia();
    await engine.preload('probe');
    await engine.dispose();
    await expect(engine.preload('probe')).rejects.toMatchObject({
      message: 'engine disposed',
    });
  });
});

describe('resetDefaultMedia (R-S05.5)', () => {
  it('disposes the old default instance and gives the next bare call a fresh engine', async () => {
    // Request A: populate the default instance and capture a handle bound to it.
    await sugar.preload('probe');
    const oldChain = sugar.load(wavBytes());

    await sugar.resetDefaultMedia();

    // The captured chain still points at the OLD engine — running it surfaces the typed disposed
    // error instead of silently resurrecting the torn-down instance.
    await expect(oldChain.to('wav').blob()).rejects.toMatchObject({
      message: 'engine disposed',
    });

    // Request B: the next bare call works — it constructed a fresh, isolated engine (fresh registry,
    // router, pools). Nothing was shared with the disposed request-A instance.
    const info = await sugar.probe(wavBytes());
    expect(info.container).toBe('wav');
    expect(info.tracks).toHaveLength(1);
  });

  it('is a no-op when no default instance exists', async () => {
    await sugar.resetDefaultMedia();
    await sugar.resetDefaultMedia();
    const info = await sugar.probe(wavBytes());
    expect(info.container).toBe('wav');
  });
});
