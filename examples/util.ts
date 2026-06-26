import { basename, extname } from 'node:path';
import { InputError } from '@aibrush/media';
import type { Container, MediaInput, Output } from '@aibrush/media';

const MIME_BY_EXTENSION = new Map<string, string>([
  ['.aac', 'audio/aac'],
  ['.adts', 'audio/aac'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.avif', 'image/avif'],
  ['.caf', 'audio/x-caf'],
  ['.flac', 'audio/flac'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m2ts', 'video/mp2t'],
  ['.m4a', 'audio/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mkv', 'video/x-matroska'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.mts', 'video/mp2t'],
  ['.ogg', 'audio/ogg'],
  ['.ogv', 'video/ogg'],
  ['.png', 'image/png'],
  ['.ts', 'video/mp2t'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
]);

const CONTAINER_BY_EXTENSION = new Map<string, Container>([
  ['.aac', 'aac'],
  ['.adts', 'adts'],
  ['.aif', 'aiff'],
  ['.aiff', 'aiff'],
  ['.caf', 'caf'],
  ['.flac', 'flac'],
  ['.m2ts', 'm2ts'],
  ['.mkv', 'mkv'],
  ['.mov', 'mov'],
  ['.mp3', 'mp3'],
  ['.mp4', 'mp4'],
  ['.mts', 'mts'],
  ['.ogg', 'ogg'],
  ['.ogv', 'ogg'],
  ['.ts', 'ts'],
  ['.wav', 'wav'],
  ['.webm', 'webm'],
]);

export function arg(args: readonly string[], index: number, label: string): string {
  const value = args[index];
  if (value === undefined || value.length === 0) {
    throw new InputError('unsupported-input', `missing ${label}`);
  }
  return value;
}

export function numberArg(args: readonly string[], index: number, label: string): number {
  const raw = arg(args, index, label);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new InputError('unsupported-input', `${label} must be a finite number, got '${raw}'`);
  }
  return value;
}

export function containerFromPath(path: string): Container {
  const ext = extname(path).toLowerCase();
  const container = CONTAINER_BY_EXTENSION.get(ext);
  if (container === undefined) {
    throw new InputError('unsupported-input', `cannot infer output container from '${path}'`);
  }
  return container;
}

export async function readMediaFile(path: string): Promise<MediaInput> {
  const bytes = await Bun.file(path).arrayBuffer();
  const filename = basename(path);
  const type = MIME_BY_EXTENSION.get(extname(path).toLowerCase());
  return type === undefined ? new File([bytes], filename) : new File([bytes], filename, { type });
}

export async function writeOutputFile(path: string, output: Output): Promise<void> {
  const bytes = await outputToBytes(output);
  await Bun.write(path, bytes);
}

async function outputToBytes(output: Output): Promise<Uint8Array> {
  if (output instanceof Blob) {
    return new Uint8Array(await output.arrayBuffer());
  }
  if (output instanceof ReadableStream) {
    return readAll(output);
  }
  throw new InputError('unsupported-input', 'operation produced no byte output for this example');
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
