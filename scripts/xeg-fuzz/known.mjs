/**
 * Divergences that are understood and waiting on a decision. A case that matches one is
 * reported under `known:` and does not fail the run, so a clean run means "nothing new".
 * Remove an entry the moment its decision lands; the fuzzer then holds the fix.
 *
 * Each entry is `{ id, summary, applies(testCase) }`.
 */
export const KNOWN = [];
