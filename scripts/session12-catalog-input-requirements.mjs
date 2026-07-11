#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const mediaTestRoot = resolve(args.find((arg) => !arg.startsWith('--')) ?? '../media-test');
const dryRun = args.includes('--dry-run');
const catalogPath = join(mediaTestRoot, 'fixtures/media/scenarios/_sources.ndjson');
const scenarioMediaRoot = join(mediaTestRoot, 'fixtures/media/scenarios');

function isConversionScenario(scenarioId) {
  return (
    scenarioId.startsWith('transcode/') ||
    scenarioId.startsWith('audio-dsp/') ||
    /^performance\/(?:convert-|op-sweep-transcode|encode-fps|metamorphic-transcode)/.test(
      scenarioId,
    )
  );
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeAtomic(path, contents) {
  const temporary = join(dirname(path), `.session12-${path.split('/').at(-1)}.tmp`);
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

const lines = readFileSync(catalogPath, 'utf8').trimEnd().split('\n');
const verifiedHashes = new Set();
const repairs = [];
const outputLines = lines.map((line, lineIndex) => {
  const row = JSON.parse(line);
  if (typeof row.scenarioId !== 'string' || !isConversionScenario(row.scenarioId)) return line;
  if (!Array.isArray(row.files) || row.files.length === 0) return line;

  const availableVideo = new Set();
  const availableAudio = new Set();
  for (const entry of row.files) {
    for (const codec of stringArray(entry.videoCodecs, `${row.scenarioId} videoCodecs`)) {
      availableVideo.add(codec);
    }
    for (const codec of stringArray(entry.audioCodecs, `${row.scenarioId} audioCodecs`)) {
      availableAudio.add(codec);
    }
  }
  // Baked/synthetic negative rows commonly have no catalog codec facts. They require scenario-specific
  // knowledge and are deliberately outside this exact-real-input repair.
  if (availableVideo.size + availableAudio.size === 0) return line;

  if (typeof row.requires !== 'object' || row.requires === null || Array.isArray(row.requires)) {
    throw new Error(`${row.scenarioId} requires must be an object`);
  }

  const requiredVideo = stringArray(
    row.requires.videoCodecs ?? [],
    `${row.scenarioId} requires.videoCodecs`,
  );
  const requiredAudio = stringArray(
    row.requires.audioCodecs ?? [],
    `${row.scenarioId} requires.audioCodecs`,
  );
  const impossibleVideo = requiredVideo.filter((codec) => !availableVideo.has(codec));
  const impossibleAudio = requiredAudio.filter((codec) => !availableAudio.has(codec));
  if (impossibleVideo.length + impossibleAudio.length === 0) return line;

  for (const entry of row.files) {
    if (
      typeof entry.file !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      throw new Error(
        `unhashed corpus entry in ${row.scenarioId} at catalog line ${lineIndex + 1}`,
      );
    }
    if (!verifiedHashes.has(entry.sha256)) {
      const mediaPath = join(scenarioMediaRoot, row.scenarioId, entry.file);
      const actual = sha256(mediaPath);
      if (actual !== entry.sha256) {
        throw new Error(`corpus hash mismatch for ${row.scenarioId}/${entry.file}: ${actual}`);
      }
      verifiedHashes.add(entry.sha256);
    }
  }

  row.requires.videoCodecs = requiredVideo.filter((codec) => availableVideo.has(codec));
  row.requires.audioCodecs = requiredAudio.filter((codec) => availableAudio.has(codec));
  repairs.push({
    scenarioId: row.scenarioId,
    removedVideoOutputRequirements: impossibleVideo,
    removedAudioOutputRequirements: impossibleAudio,
    retainedVideoInputRequirements: row.requires.videoCodecs,
    retainedAudioInputRequirements: row.requires.audioCodecs,
  });
  return JSON.stringify(row);
});

if (!dryRun && repairs.length > 0) writeAtomic(catalogPath, `${outputLines.join('\n')}\n`);

console.log(
  JSON.stringify(
    {
      dryRun,
      catalogPath,
      repairedScenarioCount: repairs.length,
      verifiedUniqueSourceHashes: verifiedHashes.size,
      repairs,
    },
    null,
    2,
  ),
);
