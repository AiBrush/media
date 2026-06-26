import { describe, expect, it } from 'vitest';
import type { CodecQuery, ContainerQuery, FilterSpec } from '../contracts/driver.ts';
import { type PreloadHost, runPreload } from './preload.ts';
import type { LogEvent, PreloadSpec } from './types.ts';

interface PreloadRecorder {
  readonly tasks: Map<string, Promise<void>>;
  ensures: number;
  readonly containers: ContainerQuery[];
  readonly codecs: CodecQuery[];
  readonly filters: FilterSpec[];
  readonly logs: LogEvent[];
}

interface RecordingHostOptions {
  readonly failEnsure?: unknown;
  readonly includeLog?: boolean;
  readonly throwContainerExtension?: string;
  readonly throwCodec?: string;
  readonly throwFilter?: boolean;
}

interface PreloadLogDetail {
  readonly error?: unknown;
}

function recordingHost(options: RecordingHostOptions = {}): {
  readonly host: PreloadHost;
  readonly recorder: PreloadRecorder;
} {
  const tasks = new Map<string, Promise<void>>();
  const recorder: PreloadRecorder = {
    tasks,
    ensures: 0,
    containers: [],
    codecs: [],
    filters: [],
    logs: [],
  };
  const base = {
    tasks,
    async ensureDefaultDrivers(): Promise<void> {
      recorder.ensures++;
      if ('failEnsure' in options) throw options.failEnsure;
    },
    pickContainer(q: ContainerQuery): void {
      recorder.containers.push(q);
      if (q.extension === options.throwContainerExtension) {
        throw new Error(`container probe failed: ${q.extension}`);
      }
    },
    async pickCodec(q: CodecQuery): Promise<void> {
      recorder.codecs.push(q);
      if (q.config.codec === options.throwCodec) {
        throw new Error(`codec probe failed: ${q.config.codec}`);
      }
    },
    pickFilter(spec: FilterSpec): void {
      recorder.filters.push(spec);
      if (options.throwFilter === true) throw new Error(`filter probe failed: ${spec.type}`);
    },
  };
  return {
    recorder,
    host:
      options.includeLog === false
        ? base
        : {
            ...base,
            onLog(event: LogEvent): void {
              recorder.logs.push(event);
            },
          },
  };
}

function detailOf(event: LogEvent | undefined): PreloadLogDetail {
  expect(event).toBeDefined();
  const detail = event?.detail;
  expect(typeof detail).toBe('object');
  expect(detail).not.toBeNull();
  return detail as PreloadLogDetail;
}

function hasContainer(
  queries: readonly ContainerQuery[],
  extension: string,
  direction: ContainerQuery['direction'],
): boolean {
  return queries.some((q) => q.extension === extension && q.direction === direction);
}

describe('runPreload', () => {
  it('uses the default probe for empty or malformed specs and memoizes the normalized key', async () => {
    const { host, recorder } = recordingHost();

    await expect(runPreload(host, [])).resolves.toBeUndefined();

    expect(recorder.ensures).toBe(1);
    expect(recorder.containers).toHaveLength(13);
    expect(recorder.containers.every((q) => q.direction === 'demux')).toBe(true);
    expect(recorder.containers.find((q) => q.extension === 'mp4')?.mime).toBe('video/mp4');
    expect(recorder.codecs).toEqual([]);
    expect(recorder.filters).toEqual([]);

    await expect(runPreload(host, [' ', { op: '   ' }])).resolves.toBeUndefined();
    const malformed = [null, false, { op: 42 }] as readonly unknown[] as readonly PreloadSpec[];
    await expect(runPreload(host, malformed)).resolves.toBeUndefined();

    expect(recorder.ensures).toBe(1);
    expect(recorder.containers).toHaveLength(13);
  });

  it('routes representative ops to container, codec, filter, and wasm warmup probes', async () => {
    const { host, recorder } = recordingHost();
    const specs: PreloadSpec[] = [
      { op: 'mux', container: 'mp4' },
      { op: 'encode', container: 'webm', video: 'h264', audio: 'aac', level: 'chunks' },
      { op: 'remux', container: 'm2ts' },
      { op: 'decode', video: 'hevc', audio: 'opus', level: 'chunks' },
      { op: 'seek', video: 'h265', level: 'chunks' },
      { op: 'trim', container: 'unknown', video: 'vp9', audio: 'vorbis', level: 'chunks' },
      { op: 'transcode', container: 'caf', video: 'av1', audio: 'mp3', level: 'chunks' },
      { op: 'custom', container: 'x-custom', video: 'rawv', audio: 'rawa', level: 'chunks' },
      { op: 'convert', container: 'mov', video: 'h265', audio: 'aac' },
    ];

    await expect(runPreload(host, specs)).resolves.toBeUndefined();

    expect(recorder.ensures).toBe(specs.length);
    expect(hasContainer(recorder.containers, 'mp4', 'mux')).toBe(true);
    expect(hasContainer(recorder.containers, 'webm', 'mux')).toBe(true);
    expect(hasContainer(recorder.containers, 'm2ts', 'demux')).toBe(true);
    expect(hasContainer(recorder.containers, 'm2ts', 'mux')).toBe(true);
    expect(hasContainer(recorder.containers, 'unknown', 'demux')).toBe(true);
    expect(hasContainer(recorder.containers, 'x-custom', 'demux')).toBe(true);
    expect(hasContainer(recorder.containers, 'x-custom', 'mux')).toBe(true);
    expect(recorder.containers.find((q) => q.extension === 'm2ts')?.mime).toBe('video/mp2t');
    expect(recorder.containers.find((q) => q.extension === 'x-custom')?.mime).toBeUndefined();

    const codecRoutes = recorder.codecs.map(
      (q) => `${q.mediaType}:${q.direction}:${q.config.codec}`,
    );
    expect(codecRoutes).toContain('video:encode:avc1.42E01E');
    expect(codecRoutes).toContain('audio:encode:mp4a.40.2');
    expect(codecRoutes).toContain('video:decode:hev1.1.6.L93.B0');
    expect(codecRoutes).toContain('video:decode:vp09.00.10.08');
    expect(codecRoutes).toContain('video:encode:vp09.00.10.08');
    expect(codecRoutes).toContain('video:decode:av01.0.04M.08');
    expect(codecRoutes).toContain('video:encode:av01.0.04M.08');
    expect(codecRoutes).toContain('video:decode:rawv');
    expect(codecRoutes).toContain('audio:decode:rawa');

    expect(recorder.filters).toContainEqual({
      mediaType: 'video',
      type: 'resize',
      width: 16,
      height: 16,
      fit: 'contain',
    });
    expect(recorder.filters).toContainEqual({ mediaType: 'audio', type: 'gain', db: 0 });
  });

  it('continues after individual probe failures without surfacing warmup errors', async () => {
    const { host, recorder } = recordingHost({
      throwContainerExtension: 'throw',
      throwCodec: 'throw-codec',
      throwFilter: true,
    });

    await expect(
      runPreload(host, [
        {
          op: 'convert',
          container: 'throw',
          video: 'throw-codec',
          audio: 'throw-codec',
        },
      ]),
    ).resolves.toBeUndefined();

    expect(recorder.containers.length).toBeGreaterThan(0);
    expect(recorder.codecs.length).toBeGreaterThan(0);
    expect(recorder.filters.length).toBeGreaterThan(0);
    expect(recorder.logs).toEqual([]);
  });

  it('logs bootstrap failures with Error and non-Error reasons but still resolves', async () => {
    const stringFailure = recordingHost({ failEnsure: 'warm string failure' });
    await expect(runPreload(stringFailure.host, [{ op: 'probe' }])).resolves.toBeUndefined();
    expect(detailOf(stringFailure.recorder.logs[0]).error).toBe('warm string failure');

    const errorFailure = recordingHost({ failEnsure: new Error('warm error failure') });
    await expect(runPreload(errorFailure.host, [{ op: 'demux' }])).resolves.toBeUndefined();
    expect(detailOf(errorFailure.recorder.logs[0]).error).toBe('warm error failure');

    const quietFailure = recordingHost({
      failEnsure: new Error('quiet failure'),
      includeLog: false,
    });
    await expect(runPreload(quietFailure.host, [{ op: 'decode' }])).resolves.toBeUndefined();
    expect(quietFailure.recorder.logs).toEqual([]);
  });
});
