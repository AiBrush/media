import { InputError } from '../contracts/errors.ts';
import { type Source, fromBlob } from './source.ts';

export async function fromOPFSImpl(path: string): Promise<Source> {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') {
    throw new InputError('unsupported-input', 'OPFS is unavailable in this environment');
  }
  const file = await opfsFile(storage, path);
  return { ...fromBlob(file), kind: 'opfs' };
}

async function opfsFile(storage: StorageManager, path: string): Promise<File> {
  const parts = path.split('/').filter((p) => p.length > 0);
  const name = parts.pop();
  if (name === undefined) {
    throw new InputError('unsupported-input', `invalid OPFS path '${path}'`);
  }
  let dir = await storage.getDirectory();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}
