/**
 * Server-sent events, parsed from a byte stream. Our own parser (not `EventSource`) so it works on any runtime,
 * accepts arbitrary chunking, and is tested as such. Follows the WHATWG rules: lines end with LF, CRLF or CR;
 * a blank line dispatches the event; `data` lines join with LF; lines starting with `:` are comments; an
 * optional BOM at the start is ignored; an event with no data lines is not dispatched. `retry` is ignored.
 */

export interface SseEvent {
  /** The `event:` field; "message" when absent. */
  event: string;
  data: string;
  id: string | undefined;
}

export class SseParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  #buffer = "";
  #started = false;
  #lastWasCR = false;
  #event = "";
  #data: string[] = [];
  #hasData = false;
  #id: string | undefined;

  /** Feed bytes; returns the events completed by them. */
  push(chunk: Uint8Array): SseEvent[] {
    return this.#feed(this.#decoder.decode(chunk, { stream: true }), false);
  }

  /** The stream ended. An event that was not terminated by a blank line is dropped, as the standard says. */
  end(): SseEvent[] {
    const out = this.#feed(this.#decoder.decode(), true);
    this.#event = "";
    this.#data = [];
    this.#hasData = false;
    this.#id = undefined;
    return out;
  }

  #feed(text: string, final: boolean): SseEvent[] {
    let s = this.#buffer + text;
    if (!this.#started && s.length > 0) {
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      this.#started = true;
    }
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10 && this.#lastWasCR && i === start) {
        // The LF of a CRLF that was split across chunks: the CR already ended the line.
        this.#lastWasCR = false;
        start = i + 1;
        continue;
      }
      if (c !== 10 && c !== 13) {
        this.#lastWasCR = false;
        continue;
      }
      const line = s.slice(start, i);
      if (c === 13) {
        if (i + 1 < s.length) {
          if (s.charCodeAt(i + 1) === 10) i++;
        } else if (!final) {
          this.#lastWasCR = true;
        }
      } else this.#lastWasCR = false;
      start = i + 1;
      const ev = this.#line(line);
      if (ev !== undefined) out.push(ev);
    }
    this.#buffer = s.slice(start);
    if (final && this.#buffer.length > 0) {
      const ev = this.#line(this.#buffer);
      this.#buffer = "";
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }

  #line(line: string): SseEvent | undefined {
    if (line === "") {
      const had = this.#hasData;
      const ev: SseEvent = { event: this.#event === "" ? "message" : this.#event, data: this.#data.join("\n"), id: this.#id };
      this.#event = "";
      this.#data = [];
      this.#hasData = false;
      return had ? ev : undefined;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") {
      this.#data.push(value);
      this.#hasData = true;
    } else if (field === "id" && !value.includes("\u0000")) this.#id = value;
    return undefined;
  }
}

/** Parse a whole byte stream into events. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent, void, void> {
  const parser = new SseParser();
  for await (const chunk of body) yield* parser.push(chunk);
  yield* parser.end();
}
