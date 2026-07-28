import { describe, expect, it } from 'vitest';
import type { Packet, TrackInfo } from '../contracts/driver.ts';
import { MediaError } from '../contracts/errors.ts';
import { nativePacketSource, registerNativePacketSource } from '../internal/packet-provenance.ts';
import { muxNativeFirstPartyPacketStreams } from './native-packet-mux.ts';

const track: TrackInfo = {
  id: 1,
  mediaType: 'audio',
  codec: 'aac',
  config: { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 },
};

function emptyStream(): ReadableStream<Packet> {
  return new ReadableStream<Packet>(
    { start: (controller) => controller.close() },
    { highWaterMark: 0 },
  );
}

describe('transactional native packet provenance', () => {
  it('accepts only semantically exact shallow and structured TrackInfo clones', () => {
    const description = new Uint8Array([0x12, 0x10]);
    const sourceTrack: TrackInfo = {
      id: 7,
      mediaType: 'video',
      codec: 'avc1.64001f',
      language: 'eng',
      durationSec: 2.5,
      fps: 24,
      rotation: 90,
      encrypted: true,
      alpha: true,
      codecDelayNs: 80_000_000,
      seekPreRollNs: 80_000_000,
      containerSideData: [
        {
          kind: 'matroska-attachments',
          attachedFilePayloads: [new Uint8Array([0xa1, 0x81, 0x00])],
        },
      ],
      containerProjection: {
        kind: 'matroska-attachment',
        sideDataIndex: 0,
        attachmentIndex: 0,
      },
      color: {
        matrixCoefficients: 1,
        bitsPerChannel: 8,
        chromaSubsamplingHorz: 1,
        chromaSubsamplingVert: 1,
        cbSubsamplingHorz: 1,
        cbSubsamplingVert: 1,
        chromaSitingHorz: 0,
        chromaSitingVert: 0,
        range: 2,
        transferCharacteristics: 1,
        primaries: 1,
        maxCll: 1_000,
        maxFall: 400,
      },
      gapless: {
        basis: 'mp4-edit-list',
        leadingSamples: 1_024,
        trailingSamples: 512,
        totalSamples: 118_464,
      },
      config: {
        codec: 'avc1.64001f',
        codedWidth: 1_920,
        codedHeight: 1_080,
        displayAspectWidth: 16,
        displayAspectHeight: 9,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: false,
        colorSpace: {
          fullRange: false,
          matrix: 'bt709',
          primaries: 'bt709',
          transfer: 'bt709',
        },
        description,
      },
    };
    const stream = emptyStream();
    const source = {
      track: sourceTrack,
      isClaimable: () => true,
      claim: () => Promise.resolve([]),
    };
    registerNativePacketSource(stream, source);

    expect(nativePacketSource(stream, { ...sourceTrack })).toBe(source);
    expect(nativePacketSource(stream, structuredClone(sourceTrack))).toBe(source);

    const changedDescription = structuredClone(sourceTrack);
    const changedConfig = changedDescription.config;
    if (changedConfig === undefined || !('codedWidth' in changedConfig))
      throw new Error('missing video config');
    const changedBytes = changedConfig.description;
    if (!(changedBytes instanceof Uint8Array)) throw new Error('missing Uint8Array description');
    changedBytes[1] = (changedBytes[1] ?? 0) ^ 1;
    expect(nativePacketSource(stream, changedDescription)).toBeUndefined();
    expect(nativePacketSource(stream, { ...sourceTrack, rotation: 180 })).toBeUndefined();
    expect(nativePacketSource(stream, { ...sourceTrack, alpha: false })).toBeUndefined();
    expect(nativePacketSource(stream, { ...sourceTrack, fps: 25 })).toBeUndefined();
    expect(nativePacketSource(stream, { ...sourceTrack, language: 'fra' })).toBeUndefined();

    const changedDimensions = structuredClone(sourceTrack);
    const dimensionsConfig = changedDimensions.config;
    if (dimensionsConfig === undefined || !('codedWidth' in dimensionsConfig))
      throw new Error('missing dimensions config');
    dimensionsConfig.codedWidth = 1_918;
    expect(nativePacketSource(stream, changedDimensions)).toBeUndefined();

    const changedColor = structuredClone(sourceTrack);
    if (changedColor.color === undefined) throw new Error('missing color metadata');
    changedColor.color.primaries = 9;
    expect(nativePacketSource(stream, changedColor)).toBeUndefined();

    const changedGapless = structuredClone(sourceTrack);
    if (changedGapless.gapless === undefined) throw new Error('missing gapless metadata');
    changedGapless.gapless.totalSamples = 118_463;
    expect(nativePacketSource(stream, changedGapless)).toBeUndefined();

    const changedSideData = structuredClone(sourceTrack);
    const sidePayload = changedSideData.containerSideData?.[0]?.attachedFilePayloads[0];
    if (sidePayload === undefined) throw new Error('missing side-data payload');
    sidePayload[2] = (sidePayload[2] ?? 0) ^ 1;
    expect(nativePacketSource(stream, changedSideData)).toBeUndefined();

    const changedProjection = structuredClone(sourceTrack);
    if (changedProjection.containerProjection === undefined)
      throw new Error('missing projection metadata');
    changedProjection.containerProjection = {
      ...changedProjection.containerProjection,
      attachmentIndex: 1,
    };
    expect(nativePacketSource(stream, changedProjection)).toBeUndefined();
    expect(
      nativePacketSource(stream, { ...sourceTrack, futureMuxFact: true } as TrackInfo),
    ).toBeUndefined();
  });

  it('does not claim the first provider when a later stream has no provenance', async () => {
    const first = emptyStream();
    const external = emptyStream();
    let claims = 0;
    registerNativePacketSource(first, {
      track,
      isClaimable: () => true,
      claim: () => {
        claims++;
        return Promise.resolve([]);
      },
    });
    await expect(
      muxNativeFirstPartyPacketStreams(
        {
          tracks: [
            { track, packets: first },
            { track: { ...track, id: 2 }, packets: external },
          ],
        },
        { container: 'mp4', signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    expect(claims).toBe(0);
  });

  it('declines a locked or semantically changed TrackInfo stream before claiming', async () => {
    const stream = emptyStream();
    const reader = stream.getReader();
    let claims = 0;
    registerNativePacketSource(stream, {
      track,
      isClaimable: () => true,
      claim: () => {
        claims++;
        return Promise.resolve([]);
      },
    });
    await expect(
      muxNativeFirstPartyPacketStreams(
        { audio: { track, packets: stream } },
        { container: 'mp4', signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    reader.releaseLock();
    await expect(
      muxNativeFirstPartyPacketStreams(
        { audio: { track: { ...track, durationSec: 1 }, packets: stream } },
        { container: 'mp4', signal: new AbortController().signal },
      ),
    ).resolves.toBeUndefined();
    expect(claims).toBe(0);
  });

  it('aborts and settles sibling claims when one provider fails', async () => {
    const first = emptyStream();
    const second = emptyStream();
    let siblingAborted = false;
    registerNativePacketSource(first, {
      track,
      isClaimable: () => true,
      claim: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              siblingAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new MediaError('aborted', 'sibling aborted');
      },
    });
    const secondTrack = { ...track, id: 2 };
    registerNativePacketSource(second, {
      track: secondTrack,
      isClaimable: () => true,
      claim: async () => {
        throw new MediaError('demux-error', 'second failed');
      },
    });
    await expect(
      muxNativeFirstPartyPacketStreams(
        {
          tracks: [
            { track, packets: first },
            { track: secondTrack, packets: second },
          ],
        },
        { container: 'mov', signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'demux-error', message: 'second failed' });
    expect(siblingAborted).toBe(true);
  });
});
