/**
 * The lazy filter stage wrapper (doc 08 §7 budget split): a same-type `TransformStream` whose real
 * driver module loads only when a frame actually flows. The wiring discipline here is load-bearing
 * for every filtered convert (ADR-186); see {@link createLazyFilterStream}.
 */

/** Minimal closable-frame shape the lazy wrapper touches (a `VideoFrame`/`AudioData`, structurally). */
export interface LazyFilterFrame {
  close(): void;
}

/**
 * `Transformer` plus the standard `cancel(reason)` hook (invoked when the readable side is cancelled).
 * The bundled `lib.dom` `Transformer` predates `cancel`; the local extension keeps strict mode honest
 * (same idiom as `webcodecs-video.ts`).
 */
interface TransformerWithCancel<I, O> extends Transformer<I, O> {
  cancel?: (reason?: unknown) => void | PromiseLike<void>;
}

/**
 * Wrap a lazily-created same-type filter stage so its driver module loads only when a frame actually
 * flows (doc 08 §7 budget split). The wiring is load-bearing for every filtered convert:
 *
 * - **Writable `highWaterMark` must be ≥ 1.** A zero-HWM writable never reports room, so the upstream
 *   `pipeTo` waits on `writer.ready` forever and the whole decode→filter→encode chain stalls silently
 *   before the first frame — the Session-10 transcode-timeout regression (ADR-186).
 * - **Backpressure is real in both directions:** `transform` awaits the inner write, and the output pump
 *   enqueues into the outer readable (HWM 1) whose fullness throttles the outer writable, so in-flight
 *   frames stay bounded for any stage shape (1:1, buffering-with-flush-tail, or fan-out).
 * - **Close-once:** an input the inner sink never accepted is closed here; an inner output that loses
 *   the race against a downstream cancel is closed instead of thrown out of the pump.
 */
export function createLazyFilterStream<F extends LazyFilterFrame>(
  create: () => Promise<TransformStream<F, F>>,
): TransformStream<F, F> {
  let writer: WritableStreamDefaultWriter<F> | undefined;
  let reader: ReadableStreamDefaultReader<F> | undefined;
  let pump: Promise<void> | undefined;
  let outerDead = false;

  const ensure = async (
    controller: TransformStreamDefaultController<F>,
  ): Promise<WritableStreamDefaultWriter<F>> => {
    if (writer !== undefined) return writer;
    const stream = await create();
    writer = stream.writable.getWriter();
    const activeReader = stream.readable.getReader();
    reader = activeReader;
    pump = (async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await activeReader.read();
          if (done) return;
          if (outerDead) {
            value.close(); // downstream already cancelled: release, never enqueue into a dead stream
            continue;
          }
          try {
            controller.enqueue(value);
          } catch {
            value.close(); // lost the close→enqueue race: release the frame, stop pumping
            return;
          }
        }
      } catch (error) {
        if (!outerDead) controller.error(error);
      } finally {
        activeReader.releaseLock();
      }
    })();
    return writer;
  };

  const transformer: TransformerWithCancel<F, F> = {
    async transform(frame, controller): Promise<void> {
      let activeWriter: WritableStreamDefaultWriter<F>;
      try {
        activeWriter = await ensure(controller);
      } catch (error) {
        frame.close();
        throw error;
      }
      await activeWriter.write(frame);
    },
    async flush(): Promise<void> {
      if (writer === undefined) return;
      await writer.close();
      await pump;
    },
    cancel(reason): void {
      // Initiate teardown without awaiting it: WHATWG abort/cancel settle only after any in-flight
      // inner write finishes, so awaiting here would let a stuck stage block cancellation forever.
      // The inner driver releases its own resources via its abort/cancel hooks and StageOptions signal.
      outerDead = true;
      void writer?.abort(reason).catch(() => {});
      void reader?.cancel(reason).catch(() => {});
    },
  };

  return new TransformStream<F, F>(transformer, { highWaterMark: 1 }, { highWaterMark: 1 });
}
