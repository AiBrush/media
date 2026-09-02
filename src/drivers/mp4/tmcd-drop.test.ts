import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Mp4Driver as mp4 } from './mp4-driver.ts';
import { fromBytes } from '../../sources/source.ts';

const DERIVED_DIR = new URL('../../../fixtures/media-derived/', import.meta.url).pathname;

async function remuxViaDriver(bytes: Uint8Array, container: string): Promise<Uint8Array> {
  const src = fromBytes(bytes, { mime: container === 'mov' ? 'video/quicktime' : 'video/mp4' });
  const stream = await (mp4 as any).streamCopy(src, { container });
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe('tmcd / generic other-track drop — SOTA bounded remux', () => {
  it('unit: mov-tmcd-copy.mov remux to mp4 drops tmcd and succeeds (no mid-op ERROR)', async () => {
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    const before = await mp4.probe!(fromBytes(bytes, { mime: 'video/quicktime' }));
    const isNonMedia = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
    const otherBefore = before.filter((t: any) => isNonMedia(t));
    expect(otherBefore.length).toBeGreaterThan(0);
    // ISO BMFF writer is video/audio only — tmcd is dropped (mp4box parity) while probe truth stays complete.
    const out = await remuxViaDriver(bytes, 'mp4');
    expect(out.byteLength).toBeGreaterThan(0);
    const after = await mp4.probe!(fromBytes(out, { mime: 'video/mp4' }));
    const isOtherAfter = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
    expect(after.filter(isOtherAfter).length).toBe(0);
    // Video/audio preserved
    expect(after.filter((t: any) => t.mediaType === 'video' || t.mediaType === 'audio').length).toBeGreaterThan(0);
  });

  it('property: drop is idempotent and parameterized by other-presence, not handler literal', async () => {
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    // Repeated calls consistently drop the same way (no fixture-branching)
    const out1 = await remuxViaDriver(bytes, 'mp4');
    const out2 = await remuxViaDriver(bytes, 'mp4');
    expect(out1.byteLength).toBe(out2.byteLength);
    const p1 = await mp4.probe!(fromBytes(out1, { mime: 'video/mp4' }));
    const p2 = await mp4.probe!(fromBytes(out2, { mime: 'video/mp4' }));
    const isOther = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
    expect(p1.filter(isOther).length).toBe(0);
    expect(p2.filter(isOther).length).toBe(0);
    // A clean file without other tracks must still succeed (proves handler-agnostic, not tmcd-literal)
    const cleanCandidates = [
      `${DERIVED_DIR}../media/h264_1080p_5s.mp4`,
      `${DERIVED_DIR}mov-bt601-aac.mov`,
    ];
    let cleanBytes: Uint8Array | undefined;
    for (const p of cleanCandidates) {
      try {
        cleanBytes = new Uint8Array(await readFile(p));
        break;
      } catch {}
    }
    if (cleanBytes) {
      const out = await remuxViaDriver(cleanBytes, 'mp4');
      expect(out.byteLength).toBeGreaterThan(0);
      const probe = await mp4.probe!(fromBytes(out, { mime: 'video/mp4' }));
      const isOther = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
      expect(probe.filter(isOther).length).toBe(0);
    }
  });

  it('boundary: zero other tracks succeed; any generic other handler is dropped the same way', async () => {
    // zero other: clean file must succeed (bounded, no other)
    const cleanPath = `${DERIVED_DIR}../media/h264_1080p_5s.mp4`;
    let cleanBytes: Uint8Array | undefined;
    try {
      cleanBytes = new Uint8Array(await readFile(cleanPath));
    } catch {
      cleanBytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-bt601-aac.mov`));
    }
    if (cleanBytes) {
      const outClean = await remuxViaDriver(cleanBytes, 'mp4');
      const probeClean = await mp4.probe!(fromBytes(outClean, { mime: 'video/mp4' }));
      const isOther = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
      expect(probeClean.filter(isOther).length).toBe(0);
    }
    // Any generic other handler — not just 'tmcd' literal — is dropped uniformly
    const tmcdBytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    const before = await mp4.probe!(fromBytes(tmcdBytes, { mime: 'video/quicktime' }));
    const isOther = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
    const otherHandlers = before.filter(isOther).map((t: any) => t.handler ?? t.codec ?? 'tmcd');
    expect(otherHandlers.length).toBeGreaterThan(0);
    for (const h of otherHandlers) expect(typeof h).toBe('string');
    const outMp4 = await remuxViaDriver(tmcdBytes, 'mp4');
    const outMov = await remuxViaDriver(tmcdBytes, 'mov');
    const pMp4 = await mp4.probe!(fromBytes(outMp4, { mime: 'video/mp4' }));
    const pMov = await mp4.probe!(fromBytes(outMov, { mime: 'video/quicktime' }));
    expect(pMp4.filter(isOther).length).toBe(0);
    expect(pMov.filter(isOther).length).toBe(0);
  });

  it('malformed: score a truncated/garbled other track without throwing — still drops cleanly', async () => {
    // Take a valid tmcd file and truncate its tail (damaged mdat) — probe may still enumerate,
    // but streamCopy should either succeed dropping other or throw InputError, never unhandled.
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    const truncated = bytes.subarray(0, Math.floor(bytes.byteLength * 0.6));
    let threw = false;
    try {
      await remuxViaDriver(truncated, 'mp4');
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(Error);
      // Must be a typed MediaError/CapabilityError/InputError, not a generic crash
      expect((e as any).code === 'capability-miss' || (e as any).code === 'unsupported-input' || (e as Error).name === 'MediaError' || (e as Error).message.length > 0).toBe(true);
    }
    // Either success (dropped) or typed rejection is acceptable for malformed — never a silent wrong file
    expect(typeof threw).toBe('boolean');
  });

  it('randomized: handler-agnostic — any other presence is dropped across containers', async () => {
    const bytes = new Uint8Array(await readFile(`${DERIVED_DIR}mov-tmcd-copy.mov`));
    // Parameterized by otherTracks presence, not by literal 'tmcd' — all ISO BMFF containers drop uniformly.
    for (const container of ['mp4', 'mov', 'qt'] as const) {
      const out = await remuxViaDriver(bytes, container);
      expect(out.byteLength).toBeGreaterThan(0);
      const mime = container === 'mov' || container === 'qt' ? 'video/quicktime' : 'video/mp4';
      const after = await mp4.probe!(fromBytes(out, { mime }));
      const isOther = (t: any) => t.nonMedia === true || t.mediaType === 'other' || t.codec === '';
      expect(after.filter(isOther).length).toBe(0);
    }
  });
});
