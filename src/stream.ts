/** The chunks of a web stream, as something `for await` can read (the type of `ReadableStream` does not say it is one). */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Releases the lock without cancelling: if the consumer stops early, the rest of the stream is left unread.
    reader.releaseLock();
  }
}
