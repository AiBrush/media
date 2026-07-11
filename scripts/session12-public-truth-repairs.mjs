import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const mediaTestRoot = resolve(process.argv[2] ?? '../media-test');
const sourceSha256 = '052f9c7c5359d642fbba887d57fc72fe5745fc75b34cddc7a7adc0a912f9cf9c';
const scenarios = [
  'demux/aac_adts',
  'mux/aac_to_adts',
  'mux/audio_only_aac_to_mp4',
  'probe/aac_adts',
  'remux/aac_adts_adts_to_mp4',
  'remux/aac_adts_adts_to_ts',
  'remux/prop_adts_to_mp4_duration_invariant',
  'transcode/aac_to_mp3_mp4',
  'transcode/aac_to_opus_webm',
  'transcode/aac_to_pcm_wav_extract',
  'trim/audio_aac_adts_copy',
];
const file = '02.aac';
const packetCount = 861;
const samplesPerPacket = 1024;
const sampleRate = 44_100;
const exactDurationSec = (packetCount * samplesPerPacket) / sampleRate;
const roundedDurationSec = 19.992;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeAtomic(path, text) {
  const temporary = join(dirname(path), `.session12-${path.split('/').at(-1)}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

const catalogPath = join(mediaTestRoot, 'fixtures/media/scenarios/_sources.ndjson');
const catalogLines = readFileSync(catalogPath, 'utf8').trimEnd().split('\n');
const updatedScenarios = new Set();
const updatedCatalog = catalogLines.map((line) => {
  const row = JSON.parse(line);
  if (!scenarios.includes(row.scenarioId)) return line;
  const entry = row.files?.find((candidate) => candidate.file === file);
  if (entry === undefined || entry.sha256 !== sourceSha256) {
    throw new Error(`unexpected ${row.scenarioId}/${file} catalog source`);
  }
  if (entry.durationSec !== 17.13566 && entry.durationSec !== exactDurationSec) {
    throw new Error(`unexpected ${row.scenarioId}/${file} duration ${entry.durationSec}`);
  }
  entry.durationSec = exactDurationSec;
  updatedScenarios.add(row.scenarioId);
  return JSON.stringify(row);
});
if (updatedScenarios.size !== scenarios.length)
  throw new Error('not every ADTS scenario was repaired');

const sourcePaths = scenarios.map((scenario) =>
  join(mediaTestRoot, 'fixtures/media/scenarios', scenario, file),
);
for (const path of sourcePaths) {
  if (sha256(path) !== sourceSha256) throw new Error(`unexpected ADTS source bytes at ${path}`);
}

const metadataWrites = [];
for (const scenario of scenarios) {
  const packetPath = join(
    mediaTestRoot,
    'fixtures/golden/scenarios',
    scenario,
    `${file}.packets.json`,
  );
  const packets = JSON.parse(readFileSync(packetPath, 'utf8'));
  if (
    packets.length !== packetCount ||
    packets.at(-1)?.ptsUs !== 19_969_161 ||
    packets.at(0)?.ptsUs !== 0
  ) {
    throw new Error(`unexpected packet truth in ${packetPath}`);
  }
  const metaPath = join(mediaTestRoot, 'fixtures/golden/scenarios', scenario, `${file}.meta.json`);
  const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (metadata.durationSec !== 17.136 && metadata.durationSec !== roundedDurationSec) {
    throw new Error(`unexpected metadata duration in ${metaPath}: ${metadata.durationSec}`);
  }
  if (metadata.tracks?.[0]?.sampleRate !== sampleRate || metadata.tracks?.[0]?.codec !== 'aac') {
    throw new Error(`unexpected AAC metadata in ${metaPath}`);
  }
  metadata.durationSec = roundedDurationSec;
  metadataWrites.push([metaPath, `${JSON.stringify(metadata, null, 2)}\n`]);
}

for (const [path, contents] of metadataWrites) writeAtomic(path, contents);
writeAtomic(catalogPath, `${updatedCatalog.join('\n')}\n`);
console.log(
  JSON.stringify({
    scenarios,
    file,
    sha256: sourceSha256,
    packetCount,
    samplesPerPacket,
    sampleRate,
    exactDurationSec,
    goldenDurationSec: roundedDurationSec,
  }),
);
