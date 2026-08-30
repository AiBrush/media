/**
 * Copy/remux preservation contract (REQUIREMENTS §5.6 — 1.4.5, §2.3.3).
 *
 * A copy/remux operation MUST never decode or encode samples unless the
 * requested edit makes that unavoidable, and it MUST preserve rational
 * timestamps, composition offsets, edit semantics, codecPrivate, color,
 * rotation, alpha, language, gapless, plus the user-visible metadata
 * surface: chapters, text/subtitle presence, attachments, common tags,
 * and cover art (REQUIREMENTS §5.2, §2.3.3).
 *
 * This module codifies the pure predicates the planner, the semantic
 * stream-copy prover, and the output-plan declaration all agree on, so a
 * single invariant can be tested without opening media bytes.
 */

import { plan } from '../kernel/planner.ts';

export const REMUX_PRESERVED_KEYS = Object.freeze([
  'timestamps',
  'compositionOffsets',
  'editList',
  'codecPrivate',
  'color',
  'rotation',
  'alpha',
  'language',
  'gapless',
  'chapters',
  'text',
  'attachments',
  'tags',
  'coverArt',
] as const);

export type RemuxPreservedKey = (typeof REMUX_PRESERVED_KEYS)[number];

/** True only for a remux/keyframe-trim that must stay copy-only (no codec/filter change). */
export function isCopyOnlyRemuxRequest(request: Parameters<typeof plan>[0]): boolean {
  const graph = plan(request);
  return graph.copyOnly;
}

/** Whether the remux output plan route is a copy-preserving route (no decode). */
export function isCopyPreservingRoute(route: string): boolean {
  return route === 'stream-copy' || route === 'metadata-rewrite';
}

/**
 * Validate that a remux declaration preserves all required keys.
 * Returns the missing keys (empty when fully preserving).
 */
export function missingPreservedKeys(declared: readonly string[]): readonly RemuxPreservedKey[] {
  return REMUX_PRESERVED_KEYS.filter((key) => !declared.includes(key));
}
