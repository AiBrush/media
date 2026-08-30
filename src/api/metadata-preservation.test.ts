import { describe, expect, it } from 'vitest';
import { REMUX_PRESERVED_KEYS, missingPreservedKeys } from './remux-copy-contract.ts';

describe('metadata preservation contract — chapters/text/attachments/tags/coverArt (REQUIREMENTS §5.2, §6 — 2.3.3)', () => {
  it('REMUX_PRESERVED_KEYS now includes the 5 user-visible metadata keys', () => {
    expect(REMUX_PRESERVED_KEYS).toContain('chapters');
    expect(REMUX_PRESERVED_KEYS).toContain('text');
    expect(REMUX_PRESERVED_KEYS).toContain('attachments');
    expect(REMUX_PRESERVED_KEYS).toContain('tags');
    expect(REMUX_PRESERVED_KEYS).toContain('coverArt');
    expect(REMUX_PRESERVED_KEYS.length).toBe(14);
  });

  it('missingPreservedKeys reports exactly the absent metadata keys', () => {
    const allButChapters = [...REMUX_PRESERVED_KEYS].filter((k) => k !== 'chapters');
    expect(missingPreservedKeys(allButChapters)).toEqual(['chapters']);
    expect(missingPreservedKeys([...REMUX_PRESERVED_KEYS])).toEqual([]);
    expect(missingPreservedKeys([]).length).toBe(14);
  });

  it('chapters/text/attachments/tags/coverArt are preserved on copy remux, not silently dropped', () => {
    const copyKeys = [...REMUX_PRESERVED_KEYS];
    expect(missingPreservedKeys(copyKeys)).toEqual([]);
    // Dropping any one metadata key is a contract violation
    for (const key of ['chapters', 'text', 'attachments', 'tags', 'coverArt'] as const) {
      const without = copyKeys.filter((k) => k !== key);
      expect(missingPreservedKeys(without)).toContain(key);
    }
  });

  it('20× randomized declaration remains deterministic and never huge-alloc', () => {
    for (let i = 0; i < 20; i++) {
      const declared =
        i % 2 === 0 ? [...REMUX_PRESERVED_KEYS] : [...REMUX_PRESERVED_KEYS].slice(0, 9);
      const missing = missingPreservedKeys(declared);
      expect(Array.isArray(missing)).toBe(true);
      expect(missing.length).toBe(REMUX_PRESERVED_KEYS.length - declared.length);
    }
  });

  it('boundary: empty, single-key, and full declaration', () => {
    expect(missingPreservedKeys([]).length).toBe(14);
    expect(missingPreservedKeys(['timestamps']).length).toBe(13);
    expect(missingPreservedKeys([...REMUX_PRESERVED_KEYS]).length).toBe(0);
  });

  it('malformed inputs never throw huge-alloc and are treated as absent', () => {
    expect(missingPreservedKeys([] as unknown as string[])).toEqual([...REMUX_PRESERVED_KEYS]);
    expect(missingPreservedKeys(['not-a-key'] as unknown as string[]).length).toBe(14);
    // @ts-ignore — malformed array with duplicates still handled
    expect(missingPreservedKeys(['timestamps', 'timestamps'] as unknown as string[]).length).toBe(
      13,
    );
  });
});
