#!/usr/bin/env bun
import { CapabilityError, createMedia } from '@aibrush/media';
import type { PacketStreams, TrackInfo } from '@aibrush/media';
import { arg, containerFromPath, readMediaFile, writeOutputFile } from './util.ts';

const args = Bun.argv.slice(2);
const inputPath = arg(args, 0, 'input path');
const outputPath = arg(args, 1, 'output path');

const media = createMedia();
const input = await readMediaFile(inputPath);
const demuxed = await media.demux(input);

try {
  const streams = packetStreams(demuxed.tracks);
  const output = await media.mux(streams, {
    container: containerFromPath(outputPath),
    faststart: true,
  });
  await writeOutputFile(outputPath, output);
  console.info(`wrote ${outputPath}`);
} finally {
  await demuxed.close();
}

function packetStreams(tracks: readonly TrackInfo[]): PacketStreams {
  const video = firstTrack(tracks, 'video');
  const audio = firstTrack(tracks, 'audio');
  const streams: PacketStreams = {};
  if (video !== undefined) {
    streams.video = { track: video, packets: demuxed.packets(video.id) };
  }
  if (audio !== undefined) {
    streams.audio = { track: audio, packets: demuxed.packets(audio.id) };
  }
  if (streams.video === undefined && streams.audio === undefined) {
    throw new CapabilityError('capability-miss', 'input has no muxable audio or video tracks', {
      op: 'mux',
      tried: [],
    });
  }
  return streams;
}

function firstTrack(
  tracks: readonly TrackInfo[],
  mediaType: TrackInfo['mediaType'],
): TrackInfo | undefined {
  return tracks.find((track) => track.mediaType === mediaType && track.config !== undefined);
}
