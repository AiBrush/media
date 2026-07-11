import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const mediaTestRoot = resolve(process.argv[2] ?? '../media-test');
const sourceDirectory = resolve(process.argv[3] ?? '/private/tmp/gapless-candidates');
const scenarioDirectory = join(
  mediaTestRoot,
  'fixtures/media/scenarios/audio-dsp/edge_gapless_aac_decode',
);
const globalFixtureDirectory = join(mediaTestRoot, 'fixtures/media');
const nativeCorpusDirectory = join(globalFixtureDirectory, 'native-gapless-aac');
const catalogPath = join(mediaTestRoot, 'fixtures/media/scenarios/_sources.ndjson');
const planPath = join(mediaTestRoot, 'fixtures/media/scenarios/_plan.ndjson');
const syntheticFixtureDirectories = [
  join(mediaTestRoot, 'fixtures/media/scenarios/robustness/edge_gapless_priming_probe'),
  join(mediaTestRoot, 'fixtures/media/scenarios/robustness/prop_gapless_sample_count_priming'),
];
const trialGoldenPaths = [
  {
    path: join(mediaTestRoot, 'fixtures/golden/gapless_aac.m4a.meta.json'),
    sha256: 'd8c0fd007cda3ccac06f224844fe56cd721c68ba0c6f377f7f99965db3dabe81',
  },
  {
    path: join(mediaTestRoot, 'fixtures/golden/gapless_aac.m4a.packets.json'),
    sha256: '686fd5caee96f1091133e2e7e3fb3676a60695693b9d6e3251cd5186078c5f63',
  },
];
const obsoletePublicFallbackGoldenPaths = [
  {
    path: join(
      mediaTestRoot,
      'fixtures/golden/scenarios/audio-dsp/edge_gapless_aac_decode/gapless_aac.m4a.meta.json',
    ),
    sha256: 'e69bc440670e3850c3186a77d6a84dd94e660018deae689a900902bc5faec341',
  },
  {
    path: join(
      mediaTestRoot,
      'fixtures/golden/scenarios/audio-dsp/edge_gapless_aac_decode/gapless_aac.m4a.packets.json',
    ),
    sha256: '8f29ca175d755bcb2fab78fd9030e6b0d882dd5a1c2b29bea03891d52cf6759c',
  },
];

const legacyGeneratedTrialHash = 'ec8b79914196d3ae937d023a6cafdc59851c42b985175793516970fe3dd892e2';

const trialHashes = new Set([
  '1ceee73f659a3c83205b1c2c31dc6804d46d79e0de89231635b6b66a876be8a3',
  '62a6e48b82b075d3511ac018f7a651378a3780928dba1a5444d30c3cfb825e95',
  '717423386cac7f8fd9b9ceab061d0169e4e41fa0361bda96255bc35533884fd7',
]);

const acceptedCurrentHashes = new Set([
  ...trialHashes,
  legacyGeneratedTrialHash,
  '0e2fee9ddd5f0923e6364ef1e6897b0b4d2907b81240af85ffb2b9a518612018',
  '9d88f4e84ff513a7ad0da281213bee0e3d6cb719bbaeb7f0fd876b7620c26ad2',
  'e471b83ad773c080ffea37d5f7a406760bba7f5441f5ab4678b6c69eda735ac4',
  '0c996f1ce52cbc5bdecdf4afc67c32def29eebe462f2c08d14df7d940bc1f966',
  'f34444c8c4f388e63e29b53a2f463f67e135c6491dd71d808690632afd930c65',
  'df6c122b66eaf50e66984ef6e99e97116d4942ff017f5f9e2393a551e0e0188d',
  '74c2effc1a22c69b2c269cb2a9cb7b450e8a8e958ed2d706261b9dd4ce121d81',
  '122a84efc78300709c4f0c85bcf63332af0685427b22cbb6cb6e8f4610e6d0fc',
  '1aad4c05186b68ae88d1e8fedb98b849f083e9d7253c3d1f3d7a04434f7728bd',
  'bddef94a3db26b5d10f0eb0e8c6a107658f463022e1091a5c81802b4eb65e36c',
  '16daef39412e15b958b881e448ea1b7379cbc6b37b3f3fb3014427f56f07b551',
  'e24f068e5ce9acd302c0cc912d0e3cf23615ba89cd70f9b6cb4d8cef93c709dc',
  '12a73423890d696ec65997dead92edccf1ee067dad38484883a0124674884704',
  'f13ce79c45d8548b2be0d26f73a5a7e6b40679988f1a076fa90da5f5af505831',
  '3c6936eec59ffee8766b1622793ba64473cd77b24b652820505ebf30b121768c',
  '4145104b80829af7a8229bd5ec98b6632eb344775cae5f890eb8543e5e00f900',
  '358885ab169536e6a4607d59c19a97c0bd6f48bb321e86ae301ffb0afe70c246',
  '61a6d3056d69de61b243780169c552580d8f20a255c3f4ecb461007936acb7a9',
  'c35fe072c25bc60c52d923a3ce20bae1e252e233a019004cc1dc276d6aff7c10',
  'de771a53404d7b795d8aa349fe2dfba95b2c61ad9768f257e4f88d2a7c4cc2c7',
]);

const nativeCorpus = [
  {
    file: '01.mp4',
    sha256: '0c996f1ce52cbc5bdecdf4afc67c32def29eebe462f2c08d14df7d940bc1f966',
  },
  {
    file: '02.mp4',
    sha256: 'f34444c8c4f388e63e29b53a2f463f67e135c6491dd71d808690632afd930c65',
  },
  {
    file: '03.mp4',
    sha256: 'df6c122b66eaf50e66984ef6e99e97116d4942ff017f5f9e2393a551e0e0188d',
  },
  {
    file: '04.mp4',
    sha256: '74c2effc1a22c69b2c269cb2a9cb7b450e8a8e958ed2d706261b9dd4ce121d81',
  },
  {
    file: '05.mp4',
    sha256: '122a84efc78300709c4f0c85bcf63332af0685427b22cbb6cb6e8f4610e6d0fc',
  },
];

const replacements = [
  {
    file: '01.mp4',
    sourceFile: 'bullet-case-5-56mm-on-concrete-1.m4a',
    sha256: '3c6936eec59ffee8766b1622793ba64473cd77b24b652820505ebf30b121768c',
    sizeBytes: 18953,
    durationSec: 1.013563,
    sourcePageUrl: 'https://bigsoundbank.com/bullet-case-5-56mm-on-concrete-1-s1361.html',
    downloadUrl: 'https://bigsoundbank.com/UPLOAD/m4a/1361.m4a',
    license: 'CC0 1.0',
  },
  {
    file: '02.mp4',
    sourceFile: 'bullet-case-5-56mm-on-concrete-6.m4a',
    sha256: '4145104b80829af7a8229bd5ec98b6632eb344775cae5f890eb8543e5e00f900',
    sizeBytes: 16736,
    durationSec: 1.017563,
    sourcePageUrl: 'https://bigsoundbank.com/bullet-case-5-56mm-on-concrete-6-s1366.html',
    downloadUrl: 'https://bigsoundbank.com/UPLOAD/m4a/1366.m4a',
    license: 'CC0 1.0',
  },
  {
    file: '03.mp4',
    sourceFile: 'tone-matching-search-1.m4a',
    sha256: '358885ab169536e6a4607d59c19a97c0bd6f48bb321e86ae301ffb0afe70c246',
    sizeBytes: 11680,
    durationSec: 1.020979,
    sourcePageUrl: 'https://bigsoundbank.com/tone-matching-search-1-s1612.html',
    downloadUrl: 'https://bigsoundbank.com/UPLOAD/m4a/1612.m4a',
    license: 'CC0 1.0',
  },
  {
    file: '04.mp4',
    sourceFile: 'tone-matching-search-2.m4a',
    sha256: '61a6d3056d69de61b243780169c552580d8f20a255c3f4ecb461007936acb7a9',
    sizeBytes: 11441,
    durationSec: 1.020979,
    sourcePageUrl: 'https://bigsoundbank.com/tone-matching-search-2-s1613.html',
    downloadUrl: 'https://bigsoundbank.com/UPLOAD/m4a/1613.m4a',
    license: 'CC0 1.0',
  },
  {
    file: '05.mp4',
    sourceFile: 'lasonotheque-1796.m4a',
    sha256: 'c35fe072c25bc60c52d923a3ce20bae1e252e233a019004cc1dc276d6aff7c10',
    sizeBytes: 33681,
    durationSec: 1.057521,
    provider: 'lasonotheque.org',
    sourcePageUrl: 'https://lasonotheque.org/whoosh-4-s1796.html',
    downloadUrl: 'https://lasonotheque.org/UPLOAD/m4a/1796.m4a',
    license: 'CC0 1.0',
  },
];

const publicControl = {
  sourceFile: 'tone-matching-search-2.m4a',
  sha256: '61a6d3056d69de61b243780169c552580d8f20a255c3f4ecb461007936acb7a9',
};
const publicInvocation = replacements.find((replacement) => replacement.file === '05.mp4');
if (publicInvocation === undefined) throw new Error('public invocation replacement is missing');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (!existsSync(scenarioDirectory) || !existsSync(catalogPath) || !existsSync(planPath)) {
  throw new Error(`media-test fixture paths are missing below ${mediaTestRoot}`);
}

mkdirSync(nativeCorpusDirectory, { recursive: true });
for (const native of nativeCorpus) {
  const sourcePath = join(scenarioDirectory, native.file);
  const targetPath = join(nativeCorpusDirectory, native.file);
  if (existsSync(targetPath) && sha256(targetPath) !== native.sha256) {
    throw new Error(`refusing to overwrite unexpected native corpus file ${targetPath}`);
  }
  if (existsSync(targetPath)) continue;
  if (!existsSync(sourcePath) || sha256(sourcePath) !== native.sha256) {
    throw new Error(`missing or unexpected native corpus source ${sourcePath}`);
  }
  copyFileSync(sourcePath, targetPath);
}

const removeScenarioTrialFixture = join(scenarioDirectory, 'gapless_aac.m4a');
if (existsSync(removeScenarioTrialFixture)) {
  const hash = sha256(removeScenarioTrialFixture);
  if (hash === legacyGeneratedTrialHash || hash === publicControl.sha256) {
    unlinkSync(removeScenarioTrialFixture);
  } else if (!acceptedCurrentHashes.has(hash)) {
    throw new Error(
      `refusing to remove unexpected trial fixture ${removeScenarioTrialFixture} (${hash})`,
    );
  }
}

const globalTrialFixture = join(globalFixtureDirectory, 'gapless_aac.m4a');
const syntheticFixture = join(globalFixtureDirectory, 'gapless_aac_synthetic.m4a');
if (existsSync(globalTrialFixture)) {
  const hash = sha256(globalTrialFixture);
  if (hash === legacyGeneratedTrialHash) {
    if (existsSync(syntheticFixture) && sha256(syntheticFixture) !== legacyGeneratedTrialHash) {
      throw new Error(`refusing to overwrite unexpected ${syntheticFixture}`);
    }
    if (!existsSync(syntheticFixture)) renameSync(globalTrialFixture, syntheticFixture);
    else unlinkSync(globalTrialFixture);
  } else if (!acceptedCurrentHashes.has(hash)) {
    throw new Error(`refusing to rename unexpected trial fixture ${globalTrialFixture} (${hash})`);
  }
}

for (const directory of syntheticFixtureDirectories) {
  const trialPath = join(directory, 'gapless_aac.m4a');
  const targetPath = join(directory, 'gapless_aac_synthetic.m4a');
  if (!existsSync(trialPath)) continue;
  const hash = sha256(trialPath);
  if (hash === legacyGeneratedTrialHash) {
    if (existsSync(targetPath) && sha256(targetPath) !== legacyGeneratedTrialHash) {
      throw new Error(`refusing to overwrite unexpected ${targetPath}`);
    }
    if (!existsSync(targetPath)) renameSync(trialPath, targetPath);
    else unlinkSync(trialPath);
  } else if (!acceptedCurrentHashes.has(hash)) {
    throw new Error(`refusing to rename unexpected synthetic fixture ${trialPath} (${hash})`);
  }
}

for (const trialGolden of trialGoldenPaths) {
  if (!existsSync(trialGolden.path)) continue;
  const hash = sha256(trialGolden.path);
  if (hash !== trialGolden.sha256) {
    throw new Error(`refusing to remove unexpected trial golden ${trialGolden.path} (${hash})`);
  }
  unlinkSync(trialGolden.path);
}

for (const fallbackGolden of obsoletePublicFallbackGoldenPaths) {
  if (!existsSync(fallbackGolden.path)) continue;
  const hash = sha256(fallbackGolden.path);
  if (hash !== fallbackGolden.sha256) {
    throw new Error(`refusing to remove unexpected fallback golden ${fallbackGolden.path}`);
  }
  unlinkSync(fallbackGolden.path);
}

const syntheticFixturePaths = [
  join(globalFixtureDirectory, 'gapless_aac_synthetic.m4a'),
  ...syntheticFixtureDirectories.map((directory) => join(directory, 'gapless_aac_synthetic.m4a')),
];
for (const syntheticPath of syntheticFixturePaths) {
  if (!existsSync(syntheticPath)) continue;
  const hash = sha256(syntheticPath);
  if (hash !== legacyGeneratedTrialHash) {
    throw new Error(`refusing to remove unexpected synthetic fixture ${syntheticPath} (${hash})`);
  }
  unlinkSync(syntheticPath);
}

for (const replacement of replacements) {
  const targetPath = join(scenarioDirectory, replacement.file);
  const sourcePath = join(sourceDirectory, replacement.sourceFile);
  if (!existsSync(sourcePath)) {
    throw new Error(`missing pinned source ${sourcePath}`);
  }
  const currentHash = existsSync(targetPath) ? sha256(targetPath) : undefined;
  if (
    currentHash !== undefined &&
    !acceptedCurrentHashes.has(currentHash) &&
    currentHash !== replacement.sha256
  ) {
    throw new Error(`refusing to replace unexpected ${targetPath} (${currentHash})`);
  }
  const sourceHash = sha256(sourcePath);
  if (sourceHash !== replacement.sha256) {
    throw new Error(`source hash mismatch for ${sourcePath}: ${sourceHash}`);
  }
  copyFileSync(sourcePath, targetPath);
  if (sha256(targetPath) !== replacement.sha256) {
    throw new Error(`post-copy hash mismatch for ${targetPath}`);
  }
}

const publicControlSource = join(sourceDirectory, publicControl.sourceFile);
if (!existsSync(publicControlSource) || sha256(publicControlSource) !== publicControl.sha256) {
  throw new Error(`missing or unexpected public control ${publicControlSource}`);
}
const publicControlTargets = [
  join(globalFixtureDirectory, 'gapless_aac.m4a'),
  ...syntheticFixtureDirectories.map((directory) => join(directory, 'gapless_aac.m4a')),
];
for (const targetPath of publicControlTargets) {
  if (existsSync(targetPath)) {
    const currentHash = sha256(targetPath);
    if (currentHash !== publicControl.sha256 && !acceptedCurrentHashes.has(currentHash)) {
      throw new Error(`refusing to overwrite unexpected public control ${targetPath}`);
    }
  }
  copyFileSync(publicControlSource, targetPath);
  if (sha256(targetPath) !== publicControl.sha256) {
    throw new Error(`public control hash mismatch for ${targetPath}`);
  }
}

const lines = readFileSync(catalogPath, 'utf8').split('\n');
const matchingIndexes = [];
for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].trim() === '') continue;
  const row = JSON.parse(lines[index]);
  if (row.scenarioId === 'audio-dsp/edge_gapless_aac_decode') matchingIndexes.push(index);
}
if (matchingIndexes.length !== 1) {
  throw new Error(`expected one gapless catalog row, found ${matchingIndexes.length}`);
}

const catalogIndex = matchingIndexes[0];
const currentRow = JSON.parse(lines[catalogIndex]);
const currentHashes = currentRow.files.map((file) => file.sha256);
if (!currentRow.files.every((file) => acceptedCurrentHashes.has(file.sha256))) {
  const replacementHashes = new Set(replacements.map((replacement) => replacement.sha256));
  if (!currentRow.files.every((file) => replacementHashes.has(file.sha256))) {
    throw new Error('refusing to replace unexpected gapless catalog hashes');
  }
}

const files = replacements.map((replacement) => ({
  file: replacement.file,
  provider: replacement.provider ?? 'bigsoundbank.com',
  sourcePageUrl: replacement.sourcePageUrl,
  downloadUrl: replacement.downloadUrl,
  container: 'mp4',
  videoCodecs: [],
  audioCodecs: ['aac'],
  width: null,
  height: null,
  durationSec: replacement.durationSec,
  sizeBytes: replacement.sizeBytes,
  sha256: replacement.sha256,
  license: replacement.license,
  poolPath: `_pool/${replacement.sha256}.mp4`,
  probedWith: 'ffprobe -v error -show_streams -show_format',
}));
lines[catalogIndex] = JSON.stringify({
  ...currentRow,
  files,
  note: 'Four exact BigSoundBank CC0 real recordings plus one exact CC0 LaSonotheque real recording occupy the five public MP4-family slots. Independent ffprobe proves ordinary no-edit AAC controls with 48 kHz mono/stereo traits and durations 1.013563–1.020979 s plus the 1.057521 s slot; native edit-list/priming coverage is preserved separately under fixtures/media/native-gapless-aac for the product matrix. No fixture bytes are synthesized, excerpted, remuxed, or transcoded.',
});
writeFileSync(catalogPath, lines.join('\n'));

const planLines = readFileSync(planPath, 'utf8').split('\n');
let updatedRealPlan = false;
let updatedSyntheticPlans = 0;
for (let index = 0; index < planLines.length; index += 1) {
  if (planLines[index].trim() === '') continue;
  const row = JSON.parse(planLines[index]);
  if (row.id === 'audio-dsp/edge_gapless_aac_decode') {
    row.input = '05.mp4';
    row.manifestSha256 = publicInvocation.sha256;
    row.source = 'fetched';
    row.sizeBucket = 'micro';
    row.manifestNotes =
      'Four exact CC0 BigSoundBank real AAC recordings plus one exact CC0 LaSonotheque real AAC recording; the public invocation points to the exact 05.mp4 slot and all controls remain no-edit.';
    row.genMethod = undefined;
    planLines[index] = JSON.stringify(row);
    updatedRealPlan = true;
  } else if (
    row.id === 'robustness/edge_gapless_priming_probe' ||
    row.id === 'robustness/prop_gapless_sample_count_priming'
  ) {
    row.input = 'gapless_aac.m4a';
    row.manifestSha256 = publicControl.sha256;
    row.source = 'fetched';
    row.manifestNotes =
      'Exact CC0 real AAC control; synthetic trial bytes were removed from the shared corpus.';
    row.genMethod = undefined;
    planLines[index] = JSON.stringify(row);
    updatedSyntheticPlans += 1;
  }
}
if (!updatedRealPlan || updatedSyntheticPlans !== 2) {
  throw new Error(
    `unexpected gapless plan rows: real=${updatedRealPlan} synthetic=${updatedSyntheticPlans}`,
  );
}
writeFileSync(planPath, planLines.join('\n'));

console.log(
  JSON.stringify({
    scenarioId: 'audio-dsp/edge_gapless_aac_decode',
    files: replacements.map((replacement) => ({
      file: replacement.file,
      sha256: replacement.sha256,
      sizeBytes: replacement.sizeBytes,
    })),
    previousHashes: currentHashes,
    trialArtifactsAbsent:
      syntheticFixturePaths.every((path) => !existsSync(path)) &&
      !existsSync(removeScenarioTrialFixture),
    publicControl: publicControl.sha256,
    updatedPublicPlan: true,
  }),
);
