import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const corpusRoot = resolve(process.cwd(), '../media-test/fixtures/media/scenarios');
const catalogPath = resolve(corpusRoot, '_sources.ndjson');
const destinationPath = resolve(corpusRoot, 'audio-dsp/edge_gapless_aac_decode/01.mp4');
const catalogBackupPath = '/private/tmp/gapless-candidates/pre-ia-catalog.ndjson';
const fixtureBackupPath = '/private/tmp/gapless-candidates/pre-ia-01.mp4';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const expectedCatalogBackupSha =
  'f1b7c9fcecaaa3646aca01fcc8f57ff6bff00b6559edbc9e8ed77527a3802ab2';
const expectedFixtureBackupSha =
  '1ceee73f659a3c83205b1c2c31dc6804d46d79e0de89231635b6b66a876be8a3';
const expectedTrialFixtureSha =
  '7a5b8dd34abbec73fda181a9106f28c792cc89b8740c534fd6563d7f756b1a58';

if (sha256(destinationPath) !== expectedTrialFixtureSha) {
  throw new Error('trial rotation changed since the audited mutation');
}
if (sha256(catalogBackupPath) !== expectedCatalogBackupSha) {
  throw new Error('catalog restoration bytes do not match the audited snapshot');
}
if (sha256(fixtureBackupPath) !== expectedFixtureBackupSha) {
  throw new Error('fixture restoration bytes do not match the audited snapshot');
}

copyFileSync(catalogBackupPath, catalogPath);
copyFileSync(fixtureBackupPath, destinationPath);

if (sha256(catalogPath) !== expectedCatalogBackupSha) {
  throw new Error('restored catalog hash mismatch');
}
if (sha256(destinationPath) !== expectedFixtureBackupSha) {
  throw new Error('restored fixture hash mismatch');
}

console.log(
  JSON.stringify({
    catalogSha256: sha256(catalogPath),
    fixtureSha256: sha256(destinationPath),
  }),
);
