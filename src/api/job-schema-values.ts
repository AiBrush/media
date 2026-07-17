/**
 * Structural value validators for the declarative-job schema (docs/architecture/execution-runtime §3.1).
 * These are the generic, domain-free guards: prototype-pollution-hardened plain records/arrays, canonical
 * numbers/strings/enums, and plain-data cloning. Domain shapes live in `job-schema.ts` /
 * `job-schema-targets.ts`; keeping the primitives separate keeps every schema module small and cycle-free.
 */

import { InputError } from '../contracts/errors.ts';

/** Explicitly names every schema field while retaining indexed access for unknown-field rejection. */
export interface PlainRecord extends Record<string, unknown> {
  readonly input?: unknown;
  readonly ops?: unknown;
  readonly output?: unknown;
  readonly container?: unknown;
  readonly video?: unknown;
  readonly audio?: unknown;
  readonly faststart?: unknown;
  readonly fragmented?: unknown;
  readonly op?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly mode?: unknown;
  readonly to?: unknown;
  readonly tags?: unknown;
  readonly trackSelect?: unknown;
  readonly scheme?: unknown;
  readonly keys?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly fit?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly degrees?: unknown;
  readonly axis?: unknown;
  readonly codec?: unknown;
  readonly fps?: unknown;
  readonly bitrate?: unknown;
  readonly bitrateMode?: unknown;
  readonly crf?: unknown;
  readonly twoPass?: unknown;
  readonly bitDepth?: unknown;
  readonly alpha?: unknown;
  readonly rotate?: unknown;
  readonly flip?: unknown;
  readonly crop?: unknown;
  readonly pad?: unknown;
  readonly colorspace?: unknown;
  readonly tonemap?: unknown;
  readonly sampleRate?: unknown;
  readonly channels?: unknown;
  readonly gainDb?: unknown;
  readonly fade?: unknown;
  readonly dynamics?: unknown;
  readonly biquad?: unknown;
  readonly inSec?: unknown;
  readonly outSec?: unknown;
  readonly curve?: unknown;
  readonly normalize?: unknown;
  readonly limit?: unknown;
  readonly targetDbfs?: unknown;
  readonly ceilingDbfs?: unknown;
  readonly knee?: unknown;
  readonly type?: unknown;
  readonly frequency?: unknown;
  readonly q?: unknown;
}

/**
 * Accept only a null-or-`Object.prototype` object whose own keys are enumerable string *data* fields —
 * accessor-backed or exotic fields are rejected without invoking their getters.
 */
export function plainRecord(value: unknown, label: string): PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !('value' in descriptor)
    ) {
      throw new InputError(`${label} must contain enumerable string data fields only`);
    }
  }
  return value as PlainRecord;
}

/** Reject any own key outside the declared schema for `label`. */
export function allowedKeys(value: PlainRecord, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new InputError(`${label} has unknown field '${key}'`);
  }
}

/** Accept only a dense array of enumerable data elements (no accessors, no named properties). */
export function plainArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InputError(`${label} must be an array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !isCanonicalArrayIndex(key, value.length) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !('value' in descriptor)
    ) {
      throw new InputError(`${label} must contain enumerable data elements only`);
    }
  }
  return value;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Deep-copy validated plain data onto fresh `Object.prototype` objects so later mutation of the caller's
 * job cannot reach into an already-validated snapshot.
 */
export function clonePlainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => clonePlainData(item));
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: clonePlainData(item),
      writable: true,
    });
  }
  return result;
}

export function requiredStringRecord(value: unknown, label: string): Record<string, string> {
  const record = plainRecord(value, label);
  const result = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') {
      throw new InputError(`${label}.${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
}

export function optionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  return value === undefined ? undefined : requiredStringRecord(value, label);
}

export function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const strings = plainArray(value, label);
  if (strings.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new InputError(`${label} must be an array of non-empty strings`);
  }
  return strings as readonly string[];
}

export function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InputError(`${label} must be a non-empty string`);
  }
  return value;
}

export function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(`${label} must be a finite number`);
  }
  return value;
}

export function positiveNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result <= 0) throw new InputError(`${label} must be positive`);
  return result;
}

export function positiveInteger(value: unknown, label: string): number {
  const result = positiveNumber(value, label);
  if (!Number.isSafeInteger(result)) {
    throw new InputError(`${label} must be a positive safe integer`);
  }
  return result;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new InputError(`${label} must be a non-negative safe integer`);
  }
  return result;
}

export function optionalPositiveNumber(value: unknown, label: string): void {
  if (value !== undefined) positiveNumber(value, label);
}

export function optionalPositiveInteger(value: unknown, label: string): void {
  if (value !== undefined) positiveInteger(value, label);
}

export function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

export function optionalNonNegativeNumber(value: unknown, label: string): void {
  if (value === undefined) return;
  const result = finiteNumber(value, label);
  if (result < 0) throw new InputError(`${label} must be non-negative`);
}

export function optionalFiniteNumber(value: unknown, label: string): void {
  if (value !== undefined) finiteNumber(value, label);
}

export function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new InputError(`${label} must be a boolean`);
  }
}

export function optionalEnum<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  optional = true,
): void {
  if (value === undefined && optional) return;
  if (!allowed.some((candidate) => candidate === value)) {
    throw new InputError(`${label} is not supported`);
  }
}
