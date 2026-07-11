/** Cold metadata-rewrite dispatch, loaded only when `remux(..., { tags })` is requested. */

import type { Container } from '../api/types.ts';
import { CapabilityError } from '../contracts/errors.ts';

/** Rewrite container-native metadata while preserving every media payload byte. */
export async function rewriteMetadataTags(
  bytes: Uint8Array,
  target: Container,
  tags: Record<string, string>,
): Promise<Uint8Array> {
  switch (target) {
    case 'mp4':
    case 'mov':
      return (await import('./mp4-tags.ts')).writeMp4Tags(bytes, tags);
    case 'webm':
    case 'mkv':
      return (await import('./matroska-tags.ts')).writeMkvTags(bytes, tags);
    case 'mp3':
      return (await import('./id3.ts')).writeMp3Id3Tags(bytes, tags);
    case 'flac':
      return (await import('./vorbis-comment.ts')).writeFlacVorbisComment(bytes, tags);
    case 'ogg':
      return (await import('./ogg-vorbis-comment.ts')).writeOggVorbisComment(bytes, tags);
    case 'wav':
      return (await import('./pcm-tags.ts')).writeWavTags(bytes, tags);
    case 'aiff':
      return (await import('./pcm-tags.ts')).writeAiffTags(bytes, tags);
    case 'caf':
      return (await import('./pcm-tags.ts')).writeCafTags(bytes, tags);
    default:
      throw new CapabilityError('capability-miss', 'metadata tag rewrite is not available', {
        op: 'remux',
        tried: [target],
      });
  }
}
