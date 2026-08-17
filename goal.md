
Continuously improve @aibrush/media toward the requirements in REQUIREMENTS.md: the broadest correct browser-media coverage, fastest correct execution, smallest route-specific bundle, bounded memory, and reliable cross-browser behavior.
Work autonomously in repeated, feature-sized cycles:
1. Re-establish the baseline from the latest compatible media-test results and current repository state. Preserve unrelated user changes.
2. Select the highest-impact unresolved feature or systemic cause—not merely the easiest failing test. Prioritize correctness, then coverage, robustness, memory, speed, and loaded size.
3. Investigate the general media semantics and root cause. Read standards, browser behavior, and maintained competitor implementations when useful.
4. Implement the smallest clean production solution using the latest codebase and API only. Do not preserve legacy compatibility or add temporary shims.
5. Add generalized unit, property, boundary, malformed-input, and randomized variants appropriate to the change.
6. Run focused repository tests, the relevant media-test cell/family, and applicable type, documentation, build, integrity, and bundle gates. Inspect output validity—not status alone.
7. Record before/after evidence in the final report, then immediately continue with the next highest-impact feature.
Treat media-test as an external evaluator. Never branch on fixture names, hashes, sizes, scenario IDs, expected outputs, cache contents, or test origins. Never weaken, skip, or rewrite a valid test merely to obtain PASS. Any optimization must apply to the real format, codec, operation, or capability and survive unseen variants.
Prefer fixes that eliminate a shared root cause across multiple features. Do not create progress/history documents or accumulate experimental leftovers. Remove superseded code when safe.
Continue without asking for routine decisions. Ask only when genuinely blocked by missing authority or an irreversible product choice. Finish only when the required matrix and release gates in REQUIREMENTS.md pass and reproducible evidence supports the SOTA claim.