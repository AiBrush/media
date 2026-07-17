/**
 * Shared HTTP length/range header parsers (docs/architecture/sources.md §5 item 4). One definition
 * serves both the fetch transport (`source.ts`) and the body-free size probe (`url-size.ts`); a
 * structural scan proves the duplicate definitions stay dead.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseContentLength, parseContentRangeTotal } from './http-range.ts';

describe('parseContentRangeTotal', () => {
  it.each([
    ['bytes 0-0/1234', 1234],
    ['bytes 0-99/713', 713],
    ['bytes */4096', 4096], // RFC 9110 unsatisfied-range form carries the total too
    ['bytes 0-0/0', 0],
    ['bytes 0-0/*', undefined],
    ['bytes 0-0/', undefined],
    ['bytes 0-0', undefined],
    ['abc', undefined],
    ['', undefined],
    ['bytes 0-0/-1', undefined],
    ['bytes 0-0/1.5', undefined],
    ['bytes 0-0/0x10', undefined], // hex is not 1*DIGIT
    ['bytes 0-0/9007199254740993', undefined], // beyond Number.MAX_SAFE_INTEGER
  ] as const)('%j → %j', (value, expected) => {
    expect(parseContentRangeTotal(value)).toBe(expected);
  });

  it('treats a missing header (null) as unknown', () => {
    expect(parseContentRangeTotal(null)).toBeUndefined();
  });
});

describe('parseContentLength', () => {
  it.each([
    ['1234', 1234],
    ['0', 0],
    ['abc', undefined],
    ['-1', undefined],
    ['12.5', undefined],
    ['0x10', undefined],
  ] as const)('Content-Length: %j → %j', (value, expected) => {
    expect(parseContentLength(new Headers({ 'Content-Length': value }))).toBe(expected);
  });

  it('treats an absent Content-Length as unknown', () => {
    expect(parseContentLength(new Headers())).toBeUndefined();
  });
});

describe('single shared definition', () => {
  it('src/sources holds exactly one definition of each parser', () => {
    const dir = new URL('.', import.meta.url).pathname;
    let contentLength = 0;
    let contentRange = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const text = readFileSync(`${dir}${name}`, 'utf8');
      contentLength += (text.match(/function parseContentLength\(/g) ?? []).length;
      contentRange += (text.match(/function parseContentRangeTotal\(/g) ?? []).length;
    }
    expect(contentLength).toBe(1);
    expect(contentRange).toBe(1);
  });
});
