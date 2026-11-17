/**
 * The chunks of a web stream, as something `for await` can read (the type of `ReadableStream` does not say it is one).
 * A consumer that stops early (a `break`, a throw) cancels the stream, so the connection behind a response body is released
 * instead of being left unread.
 */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      yield value;
    }
  } finally {
    // After a normal end there is nothing to cancel. Otherwise the rest of the stream will never be read, so say so; a stream that
    // refuses to cancel (it already failed) is not worth failing the consumer's own exit for.
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
