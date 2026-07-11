import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const corpusRoot = resolve(process.cwd(), '../media-test/fixtures/media/scenarios');
const catalogPath = resolve(corpusRoot, '_sources.ndjson');
const destinationPath = resolve(corpusRoot, 'audio-dsp/edge_gapless_aac_decode/01.mp4');
const sourcePath = '/private/tmp/gapless-candidates/ia-untitled.m4a';
const catalogBackupPath = '/private/tmp/gapless-candidates/pre-ia-catalog.ndjson';
const fixtureBackupPath = '/private/tmp/gapless-candidates/pre-ia-01.mp4';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const expectedCatalogSha = 'f1b7c9fcecaaa3646aca01fcc8f57ff6bff00b6559edbc9e8ed77527a3802ab2';
const expectedOldFixtureSha = '1ceee73f659a3c83205b1c2c31dc6804d46d79e0de89231635b6b66a876be8a3';
const expectedNewFixtureSha = '7a5b8dd34abbec73fda181a9106f28c792cc89b8740c534fd6563d7f756b1a58';

if (sha256(catalogPath) !== expectedCatalogSha) {
  throw new Error('catalog changed since the audited snapshot');
}
if (sha256(destinationPath) !== expectedOldFixtureSha) {
  throw new Error('rotation 01 changed since the audited snapshot');
}
if (sha256(sourcePath) !== expectedNewFixtureSha) {
  throw new Error('candidate bytes do not match the audited upstream hash');
}

copyFileSync(catalogPath, catalogBackupPath);
copyFileSync(destinationPath, fixtureBackupPath);

const lines = readFileSync(catalogPath, 'utf8').trimEnd().split('\n');
let replacements = 0;
const updatedLines = lines.map((line) => {
  const record = JSON.parse(line);
  if (record.scenarioId !== 'audio-dsp/edge_gapless_aac_decode') return line;
  if (record.files.length !== 3 || record.files[0].sha256 !== expectedOldFixtureSha) {
    throw new Error('gapless catalog record does not match the audited snapshot');
  }
  record.files[0] = {
    file: '01.mp4',
    provider: 'internet-archive',
    sourcePageUrl: 'https://archive.org/details/untitled-feb-32026810-am',
    downloadUrl: 'https://archive.org/download/untitled-feb-32026810-am/UntitledFeb32026810AM.m4a',
    license: 'CC0-1.0',
    container: 'mp4',
    videoCodecs: [],
    audioCodecs: ['aac'],
    width: null,
    height: null,
    durationSec: 160.217687,
    sizeBytes: 2573535,
    sha256: expectedNewFixtureSha,
    poolPath: `_pool/${expectedNewFixtureSha}.mp4`,
    probedWith: 'ffprobe -v error -show_streams -show_format',
  };
  record.note =
    'Rotation 01 is the exact downloaded Internet Archive original UntitledFeb32026810AM.m4a by Night Vision, published CC0-1.0; no local transcode, trim, resample, or byte rewrite. Rotations 02-03 remain exact Mozilla Gecko MPL-2.0 WebAudio vectors pending eligibility audit.';
  replacements += 1;
  return JSON.stringify(record);
});
if (replacements !== 1) throw new Error(`expected one catalog record, saw ${replacements}`);

copyFileSync(sourcePath, destinationPath);
if (sha256(destinationPath) !== expectedNewFixtureSha) {
  throw new Error('copied rotation does not match the audited upstream hash');
}
writeFileSync(catalogPath, `${updatedLines.join('\n')}\n`);

console.log(
  JSON.stringify({
    catalogSha256: sha256(catalogPath),
    fixtureSha256: sha256(destinationPath),
    catalogBackupSha256: sha256(catalogBackupPath),
    fixtureBackupSha256: sha256(fixtureBackupPath),
  }),
);
