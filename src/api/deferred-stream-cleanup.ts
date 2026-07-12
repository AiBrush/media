/** Cold cancellation/error cleanup for deferred frame streams. */

type DefaultReadResult<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true; readonly value?: T | undefined };

/** Claim and close an already-produced value before cancellation clears the stream's queue. */
export default async function closeThenCancelDeferredStream<T>(
  stream: ReadableStream<T>,
  reason: unknown,
  closeValue: (value: unknown) => void,
): Promise<void> {
  const reader = stream.getReader();
  let readyValue: DefaultReadResult<T> | undefined;
  const ready = reader.read().then(
    (result) => {
      readyValue = result;
    },
    () => {},
  );
  let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Claim work that the just-completed producer already queued, but yield for at most one task so an
    // empty/hung source cannot delay cancellation indefinitely.
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        cancelDeadline = setTimeout(resolve, 0);
      }),
    ]);
    if (cancelDeadline !== undefined) clearTimeout(cancelDeadline);
    if (readyValue !== undefined && !readyValue.done) closeValue(readyValue.value);
    await reader.cancel(reason).catch(() => {});
    await ready;
  } finally {
    reader.releaseLock();
  }
}
