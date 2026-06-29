import { describe, expect, it } from 'vitest';
import {
  isFirefoxRuntime,
  isLikelyFirefoxRuntime,
  isLikelyWebKitRuntime,
  isWebKitRuntime,
} from './runtime-detect.ts';

function withNavigator<T>(value: unknown, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  });
  try {
    return fn();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'navigator', original);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  }
}

describe('isLikelyWebKitRuntime', () => {
  it('accepts Safari and Playwright WebKit-style runtimes', () => {
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        'Apple Computer, Inc.',
      ),
    ).toBe(true);
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko)',
      ),
    ).toBe(true);
    expect(isLikelyWebKitRuntime('', 'Apple Computer, Inc.')).toBe(true);
  });

  it('rejects Chromium, Edge, Firefox, and their iOS UA variants', () => {
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Google Inc.',
      ),
    ).toBe(false);
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      ),
    ).toBe(false);
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
      ),
    ).toBe(false);
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(
      isLikelyWebKitRuntime(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15',
      ),
    ).toBe(false);
  });
});

describe('isLikelyFirefoxRuntime', () => {
  it('accepts desktop Firefox runtimes', () => {
    expect(
      isLikelyFirefoxRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
      ),
    ).toBe(true);
  });

  it('rejects Chromium, Safari, and iOS Firefox UA variants', () => {
    expect(
      isLikelyFirefoxRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(
      isLikelyFirefoxRuntime(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      ),
    ).toBe(false);
    expect(
      isLikelyFirefoxRuntime(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15',
      ),
    ).toBe(false);
    expect(isLikelyFirefoxRuntime('')).toBe(false);
  });
});

describe('runtime detector globals', () => {
  it('reads Firefox from navigator.userAgent', () => {
    withNavigator(
      {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
        vendor: '',
      },
      () => {
        expect(isFirefoxRuntime()).toBe(true);
        expect(isWebKitRuntime()).toBe(false);
      },
    );
  });

  it('reads WebKit from navigator vendor and user agent', () => {
    withNavigator(
      {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        vendor: 'Apple Computer, Inc.',
      },
      () => {
        expect(isWebKitRuntime()).toBe(true);
        expect(isFirefoxRuntime()).toBe(false);
      },
    );
  });

  it('falls back safely when navigator or navigator string fields are absent', () => {
    withNavigator({}, () => {
      expect(isFirefoxRuntime()).toBe(false);
      expect(isWebKitRuntime()).toBe(false);
    });
    withNavigator(undefined, () => {
      expect(isFirefoxRuntime()).toBe(false);
      expect(isWebKitRuntime()).toBe(false);
    });
  });
});
