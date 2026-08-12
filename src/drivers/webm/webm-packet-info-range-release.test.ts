import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ByteSource, PacketInfoTable } from '../../contracts/driver.ts';
import { loadFixture } from '../../test-support/corpus.ts';
import { WebmDriver, webmPacketPayloadInfoFromBytes } from './webm-driver.ts';

const MEDIA_TEST = new URL('../../../../media-test/fixtures/media/', import.meta.url).pathname;

interface OwnedRangeSource {
  readonly source: ByteSource;
  readonly outstanding: ReadonlySet<Uint8Array>;
  readonly ranges: readonly (readonly [number, number])[];
  readonly responses: readonly Uint8Array[];
  readonly releases: readonly Uint8Array[];
}

interface OwnedRangeOptions {
  readonly response?: (start: number, end: number, readIndex: number) => Uint8Array;
  readonly afterResponse?: (readIndex: number) => void;
}

function ownedRangeSource(bytes: Uint8Array, options: OwnedRangeOptions = {}): OwnedRangeSource {
  const outstanding = new Set<Uint8Array>();
  const ranges: Array<readonly [number, number]> = [];
  const responses: Uint8Array[] = [];
  const releases: Uint8Array[] = [];
  const source: ByteSource = {
    size: bytes.byteLength,
    range(start, end): Promise<Uint8Array> {
      ranges.push([start, end]);
      const readIndex = responses.length;
      const response =
        options.response?.(start, end, readIndex) ??
        bytes.slice(start, Math.min(end, bytes.byteLength));
      responses.push(response);
      outstanding.add(response);
      options.afterResponse?.(readIndex);
      return Promise.resolve(response);
    },
    releaseRange(response): void {
      if (!outstanding.delete(response)) {
        throw new Error('WebM packet-info released a foreign or already-released range');
      }
      releases.push(response);
      const buffer = response.buffer as ArrayBuffer;
      structuredClone(buffer, { transfer: [buffer] });
    },
    stream(): ReadableStream<Uint8Array> {
      throw new Error('finite WebM packet-info must stay range-backed');
    },
  };
  return { source, outstanding, ranges, responses, releases };
}

function expectExactReleaseOfEveryResponse(owned: OwnedRangeSource): void {
  expect(owned.outstanding.size).toBe(0);
  expect(owned.releases).toHaveLength(owned.responses.length);
  for (let index = 0; index < owned.responses.length; index++) {
    expect(owned.releases[index]).toBe(owned.responses[index]);
    expect(owned.responses[index]?.byteLength).toBe(0);
  }
}

function expectedPacketInfo(bytes: Uint8Array): PacketInfoTable {
  const payload = webmPacketPayloadInfoFromBytes(bytes);
  return {
    tracks: payload.tracks,
    packets: payload.packets.map(({ data: _data, alpha: _alpha, ...packet }) => packet),
  };
}

async function packetInfo(source: ByteSource, signal?: AbortSignal): Promise<PacketInfoTable> {
  const operation = WebmDriver.packetInfo;
  if (operation === undefined) throw new Error('WebmDriver.packetInfo is not registered');
  return operation.call(WebmDriver, source, signal === undefined ? undefined : { signal });
}

describe('WebM packet-info range ownership', () => {
  it('releases and detaches every exact bounded-scan response without invalidating TrackInfo', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const expected = expectedPacketInfo(bytes);
    const owned = ownedRangeSource(bytes);

    const actual = await packetInfo(owned.source);

    expect(actual).toEqual(expected);
    expect(actual.tracks.some((track) => track.config?.description !== undefined)).toBe(true);
    expect(owned.responses.length).toBeGreaterThan(1);
    expectExactReleaseOfEveryResponse(owned);
  });

  it('releases bounded attachment ranges after detaching all escaped side data', async () => {
    const bytes = new Uint8Array(await readFile(`${MEDIA_TEST}scenarios/demux/h264_in_mkv/03.mkv`));
    const expected = expectedPacketInfo(bytes);
    const owned = ownedRangeSource(bytes);

    const actual = await packetInfo(owned.source);

    expect(actual).toEqual(expected);
    expect(actual.tracks.some((track) => track.config?.description !== undefined)).toBe(true);
    expect(actual.tracks.some((track) => track.containerSideData !== undefined)).toBe(true);
    expect(owned.ranges).not.toContainEqual([0, bytes.byteLength]);
    expect(Math.max(...owned.ranges.map(([start, end]) => end - start))).toBeLessThan(
      bytes.byteLength,
    );
    expect(owned.responses.filter((response) => response.byteLength === 0).length).toBeGreaterThan(
      1,
    );
    expectExactReleaseOfEveryResponse(owned);
  });

  it('releases the exact finite prefix response on bootstrap errors', async () => {
    const owned = ownedRangeSource(Uint8Array.of(0, 1, 2, 3));

    await expect(packetInfo(owned.source)).rejects.toThrow();

    expect(owned.responses).toHaveLength(1);
    expectExactReleaseOfEveryResponse(owned);
  });

  it('releases every exact response when a bounded Cluster window rejects', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const owned = ownedRangeSource(bytes, {
      response: (start, end) =>
        start > 0 && end - start > 12
          ? new Uint8Array(end - start)
          : bytes.slice(start, Math.min(end, bytes.byteLength)),
    });

    await expect(packetInfo(owned.source)).rejects.toThrow(
      /invalid EBML element header|no media blocks/,
    );

    expect(owned.responses.length).toBeGreaterThan(1);
    expectExactReleaseOfEveryResponse(owned);
  });

  it('releases a received range when exact-length validation or post-read cancellation rejects', async () => {
    const bytes = await loadFixture('movie_5.webm');
    const short = ownedRangeSource(bytes, {
      response: (start, end) => bytes.slice(start, end - 1),
    });

    await expect(packetInfo(short.source)).rejects.toThrow(/returned .* bytes for range/);
    expectExactReleaseOfEveryResponse(short);

    const controller = new AbortController();
    const cancelled = ownedRangeSource(bytes, {
      afterResponse: () => controller.abort('cancel after range completion'),
    });

    await expect(packetInfo(cancelled.source, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expectExactReleaseOfEveryResponse(cancelled);
  });

  it('never calls releaseRange for stream-owned materialization', async () => {
    const bytes = await loadFixture('white.webm');
    const expected = expectedPacketInfo(bytes);
    let releases = 0;

    const actual = await packetInfo({
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes.slice());
            controller.close();
          },
        }),
      releaseRange(): void {
        releases++;
      },
    });

    expect(actual).toEqual(expected);
    expect(releases).toBe(0);
  });
});
