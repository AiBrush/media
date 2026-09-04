/**
 * Memoize one async loader. Used for lazy module chunks: a cached dynamic `import()` still costs
 * ~10–15 µs per call in Chromium (module map lookup plus a fresh promise), while awaiting an already
 * settled promise costs nothing. Holding the module namespace promise is not a data cache: it carries
 * no input-derived state and is shared by every engine instance by design.
 */
export function memoizeAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= load();
    return promise;
  };
}
