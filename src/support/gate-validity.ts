/**
 * Gate output validity — inspect content, not status alone (REQUIREMENTS §8.1 — C4).
 *
 * Gates MUST inspect output validity, not status alone. A green status with
 * corrupt output (empty bundle, missing declaration, invalid sourcemap,
 * zero-byte WASM) must still fail. This module is the pure, Node-testable
 * validator — no filesystem, no fixture branching, never huge-alloc,
 * deterministic.
 */

export type GateName = 'typecheck' | 'docs' | 'build' | 'bundle' | 'integrity';

export interface GateOutput {
  readonly gate: GateName;
  readonly status: 'pass' | 'fail';
  readonly bytes?: number;
  readonly files?: readonly string[];
  readonly errors?: readonly string[];
}

const REQUIRED_FILES: Record<GateName, readonly string[]> = {
  typecheck: ['dist/index.d.ts', 'dist/core.d.ts'],
  docs: ['docs/runtime-and-capabilities.md'],
  build: ['dist/index.js', 'dist/core.js'],
  bundle: ['dist/index.js'],
  integrity: ['dist/index.js'],
};

export function isGateName(value: string): boolean {
  if (typeof value !== 'string') throw new RangeError('gate must be string');
  if (value.length > 20) throw new RangeError('gate too long');
  return (Object.keys(REQUIRED_FILES) as readonly string[]).includes(value);
}

export function isValidGateOutput(output: unknown): boolean {
  if (typeof output !== 'object' || output === null) return false;
  const o = output as Partial<GateOutput>;
  if (typeof o.gate !== 'string' || !isGateName(o.gate)) return false;
  if (o.status !== 'pass' && o.status !== 'fail') return false;
  if (o.bytes !== undefined && (typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes < 0 || o.bytes > 10 * 1024 * 1024)) return false;
  if (o.files !== undefined) {
    if (!Array.isArray(o.files)) return false;
    for (const f of o.files) if (typeof f !== 'string' || !f) return false;
  }
  if (o.errors !== undefined) {
    if (!Array.isArray(o.errors)) return false;
    for (const e of o.errors) if (typeof e !== 'string') return false;
  }
  return true;
}

export function assertGateOutputValidity(output: GateOutput): void {
  if (!isValidGateOutput(output)) throw new RangeError('invalid gate output');
  if (output.status === 'pass' && output.errors !== undefined && output.errors.length > 0) throw new RangeError(`${output.gate} status pass but errors present`);
  if (output.status === 'pass') {
    const required = REQUIRED_FILES[output.gate];
    for (const f of required) {
      if (!output.files?.includes(f)) throw new RangeError(`${output.gate} missing required file ${f}`);
    }
    if (output.bytes !== undefined && output.bytes === 0) throw new RangeError(`${output.gate} bytes is 0 but status pass`);
  }
  if (output.status === 'fail' && (!output.errors || output.errors.length === 0)) throw new RangeError(`${output.gate} status fail but no errors`);
}

export function gatePassesWithValidOutput(output: GateOutput): boolean {
  try {
    assertGateOutputValidity(output);
    return output.status === 'pass';
  } catch {
    return false;
  }
}
