import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mediaTestRoot = resolve(process.argv[2] ?? '../media-test');
const restore = process.argv.includes('--restore');
const targets = [
  {
    label: 'shared',
    manifestPath: join(mediaTestRoot, 'fixtures/media/hls_aes128.m3u8'),
    publicPrefix: '/fixtures/media/',
  },
  {
    label: 'probe-scenario',
    manifestPath: join(mediaTestRoot, 'fixtures/media/scenarios/probe/hls_aes128/hls_aes128.m3u8'),
    publicPrefix: '/fixtures/media/scenarios/probe/hls_aes128/',
  },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mapUri(uri, publicPrefix) {
  const trimmed = uri.trim();
  if (trimmed.length === 0 || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  if (restore) {
    if (!trimmed.startsWith(publicPrefix)) {
      throw new Error(`cannot restore URI outside public prefix: ${trimmed}`);
    }
    return trimmed.slice(publicPrefix.length);
  }
  if (trimmed.startsWith('/')) return trimmed;
  return `${publicPrefix}${trimmed}`;
}

function rewriteManifest(text, publicPrefix) {
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === '\n' || part === '\r\n' || part.startsWith('#')) {
        return part.replace(
          /URI="([^"]+)"/g,
          (_match, uri) => `URI="${mapUri(uri, publicPrefix)}"`,
        );
      }
      return part.trim().length === 0 ? part : mapUri(part, publicPrefix);
    })
    .join('');
}

const results = targets.map(({ label, manifestPath, publicPrefix }) => {
  if (!existsSync(manifestPath)) {
    throw new Error(`missing HLS manifest ${manifestPath}`);
  }
  const before = readFileSync(manifestPath);
  const originalText = before.toString('utf8');
  const rewrittenText = rewriteManifest(originalText, publicPrefix);
  const after = Buffer.from(rewrittenText, 'utf8');
  if (!restore && !rewrittenText.includes(publicPrefix)) {
    throw new Error(`HLS manifest rewrite did not add a public resolver prefix for ${label}`);
  }
  writeFileSync(manifestPath, after);
  return {
    manifest: label,
    changed: !before.equals(after),
    beforeSha256: sha256(before),
    afterSha256: sha256(after),
    publicPrefix,
    restore,
  };
});

console.log(
  JSON.stringify({
    manifests: results,
    resolverContext: restore
      ? 'original relative key and segment URIs restored'
      : 'manifests carry root-relative key and segment URIs for the public static origin',
  }),
);
