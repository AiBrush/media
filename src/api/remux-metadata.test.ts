import { describe, expect, it } from 'vitest';
import { CapabilityError, InputError } from '../contracts/errors.ts';
import { parseOgg } from '../drivers/ogg/ogg-driver.ts';
import { readOggVorbisComment } from '../metadata/ogg-vorbis-comment.ts';
import { loadFixture } from '../test-support/corpus.ts';
import {
  createRemuxMetadataProgress,
  planRemuxMetadata,
  rewriteRemuxMetadata,
} from './remux-metadata.ts';

function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const cut = Math.floor(bytes.byteLength / 3);
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes.subarray(0, cut));
      controller.enqueue(bytes.subarray(cut, cut * 2));
      controller.enqueue(bytes.subarray(cut * 2));
      controller.close();
    },
  });
}

describe('remux metadata composition', () => {
  it('snapshots tags and rewrites a real Ogg without changing codec or duration', async () => {
    const input = await loadFixture('sfx-opus.ogg');
    const before = parseOgg(input);
    const tags = { title: 'selected output' };
    const plan = planRemuxMetadata('ogg', tags);
    tags.title = 'mutated too late';
    const progress: Array<{ readonly done: number; readonly stage: string }> = [];

    const output = await rewriteRemuxMetadata(chunked(input), plan, {
      onProgress: ({ done, stage }) => progress.push({ done, stage }),
    });
    const after = parseOgg(output);
    const { title } = readOggVorbisComment(output);
    expect(after.codec).toBe(before.codec);
    expect(after.durationSec).toBe(before.durationSec);
    expect(title).toBe('selected output');
    expect(progress.at(-1)).toEqual({ done: output.byteLength, stage: 'metadata' });
    expect(
      progress.every((entry, index) => {
        const previous = progress[index - 1];
        return previous === undefined || entry.done >= previous.done;
      }),
    ).toBe(true);
  });

  it('rejects unsupported targets and malformed tag records before reading output bytes', () => {
    expect(() => planRemuxMetadata('ts', { title: 'x' })).toThrowError(CapabilityError);
    expect(() => planRemuxMetadata('ogg', null as unknown as Record<string, string>)).toThrowError(
      InputError,
    );
    expect(() =>
      planRemuxMetadata('ogg', { title: 42 } as unknown as Record<string, string>),
    ).toThrowError(InputError);

    const accessorTags = Object.defineProperty({}, 'title', {
      enumerable: true,
      get: () => 'late-bound',
    }) as Record<string, string>;
    expect(() => planRemuxMetadata('ogg', accessorTags)).toThrowError(InputError);

    const symbolTags = { title: 'visible', [Symbol('hidden')]: 'not serializable' } as Record<
      string,
      string
    >;
    expect(() => planRemuxMetadata('ogg', symbolTags)).toThrowError(InputError);

    const inheritedTags = Object.create({ title: 'from prototype' }) as Record<string, string>;
    expect(() => planRemuxMetadata('ogg', inheritedTags)).toThrowError(InputError);
  });

  it('cancels an untouched remux stream when the shared signal is already aborted', async () => {
    let pulls = 0;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls++;
        },
        cancel(): void {
          cancels++;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      rewriteRemuxMetadata(stream, planRemuxMetadata('ogg', { title: 'x' }), {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(pulls).toBe(0);
    expect(cancels).toBe(1);
  });

  it('projects remux and metadata work onto one monotonic two-phase timeline', () => {
    const events: Array<{
      readonly done: number;
      readonly total?: number;
      readonly stage: string;
    }> = [];
    const phases = createRemuxMetadataProgress((event) => events.push(event));
    phases.remux?.({ done: 0, total: 100, stage: 'packet-copy' });
    phases.remux?.({ done: 50, total: 100, stage: 'packet-copy' });
    phases.remux?.({ done: 40, total: 100, stage: 'late-regression' });
    phases.metadata?.({ done: 10, stage: 'metadata-buffer' });
    phases.metadata?.({ done: 20, total: 20, stage: 'metadata' });

    expect(events.map(({ done }) => done)).toEqual([0, 0.5, 1, 2]);
    expect(events.every(({ total }) => total === 2)).toBe(true);
    expect(events.map(({ stage }) => stage)).toEqual([
      'remux:packet-copy',
      'remux:packet-copy',
      'metadata:metadata-buffer',
      'metadata:metadata',
    ]);
  });
});
