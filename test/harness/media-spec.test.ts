import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FORMATS, formatOf, type Format } from "../../harness/formats.ts";
import { planMedia, type MediaSpec } from "../../harness/media-spec.ts";
import { ANTHROPIC_MEDIA, CHAT_MEDIA, RESPONSES_MEDIA, localMedia } from "../../providers/media-specs.ts";

const f = (mime: string): Format => formatOf(mime) as Format;

describe("planning a file for a sink", () => {
  const spec: MediaSpec = { audio: [{ mime: "audio/mpeg" }, { mime: "audio/flac" }, { mime: "audio/wav" }], image: [{ mime: "image/png", maxBytes: 1000 }, { mime: "image/jpeg" }] };

  test("an accepted format passes untouched, however low it is in the order", () => {
    assert.deepEqual(planMedia(f("audio/wav"), 5_000_000, spec), { action: "pass" });
    assert.deepEqual(planMedia(f("audio/mpeg"), 5, spec), { action: "pass" });
  });

  test("a format that is not accepted is converted to the first accepted one the converter can make", () => {
    assert.deepEqual(planMedia(f("audio/ogg"), 5, spec), { action: "convert", to: { mime: "audio/mpeg" } });
    const noMp3 = (_: Format, to: { mime: string }) => to.mime !== "audio/mpeg";
    assert.deepEqual(planMedia(f("audio/ogg"), 5, spec, noMp3), { action: "convert", to: { mime: "audio/flac" } });
    assert.deepEqual(planMedia(f("image/bmp"), 5, spec), { action: "convert", to: { mime: "image/png", maxBytes: 1000 } });
  });

  test("when nothing can be made the refusal says what the sink takes", () => {
    const r = planMedia(f("audio/ogg"), 5, spec, () => false);
    assert.equal(r.action, "refuse");
    assert.match((r as { reason: string }).reason, /an Ogg sound.*takes an MP3 sound, a FLAC sound, a WAV sound.*cannot be converted/);
  });

  test("a file over the sink's size limit is refused, not converted", () => {
    const r = planMedia(f("image/png"), 2_000_000, spec);
    assert.equal(r.action, "refuse");
    assert.match((r as { reason: string }).reason, /over the .* MiB this model takes in image\/png; make a smaller copy/);
    assert.deepEqual(planMedia(f("image/png"), 1000, spec), { action: "pass" });
  });

  test("a kind the sink does not take, video, an unknown file and a PDF that cannot pass are refused", () => {
    assert.match((planMedia(f("application/pdf"), 5, spec) as { reason: string }).reason, /does not take PDFs/);
    assert.match((planMedia(f("video/mp4"), 5, spec) as { reason: string }).reason, /video is not supported yet/);
    assert.match((planMedia(undefined, 5, spec) as { reason: string }).reason, /not a picture, sound or PDF/);
    assert.match((planMedia(f("image/png"), 5, { audio: spec.audio ?? [] }) as { reason: string }).reason, /does not take pictures/);
    assert.match((planMedia(f("audio/wav"), 5, {}) as { reason: string }).reason, /does not take sound/);
    const pdfOnly: MediaSpec = { pdf: [{ mime: "application/pdf", maxBytes: 10 }] };
    assert.equal(planMedia(f("application/pdf"), 11, pdfOnly).action, "refuse");
  });

  test("a sink takes a format by any name for it", () => {
    assert.deepEqual(planMedia(f("audio/wav"), 5, { audio: [{ mime: "audio/x-wav" }] }), { action: "pass" });
  });
});

describe("what each sink takes", () => {
  const specs: [string, MediaSpec][] = [["anthropic", ANTHROPIC_MEDIA], ["responses", RESPONSES_MEDIA], ["chat", CHAT_MEDIA], ["local", localMedia({})]];

  test("every target is a known format of the kind it is listed under, once", () => {
    for (const [name, spec] of specs) {
      for (const kind of ["image", "audio", "pdf"] as const) {
        const mimes = (spec[kind] ?? []).map((t) => t.mime);
        assert.equal(new Set(mimes).size, mimes.length, `${name} ${kind} has a repeat`);
        for (const m of mimes) assert.equal(formatOf(m)?.kind, kind, `${name}: ${m}`);
      }
    }
  });

  test("what the wires take: sound only on chat and local, PDF only on anthropic and responses", () => {
    assert.equal(ANTHROPIC_MEDIA.audio, undefined);
    assert.equal(RESPONSES_MEDIA.audio, undefined);
    assert.equal(CHAT_MEDIA.pdf, undefined);
    assert.equal(localMedia({}).pdf, undefined);
    assert.ok(CHAT_MEDIA.audio !== undefined && localMedia({}).audio !== undefined);
  });

  test("a local server takes bmp but not webp (its image decoder has no webp), and has only the kinds its projector has", () => {
    const mimes = (localMedia({}).image ?? []).map((t) => t.mime);
    assert.ok(mimes.includes("image/bmp") && !mimes.includes("image/webp"));
    assert.deepEqual(planMedia(f("image/webp"), 5, localMedia({})), { action: "convert", to: { mime: "image/png" } });
    assert.equal(localMedia({ vision: false }).image, undefined);
    assert.equal(localMedia({ audio: false }).audio, undefined);
    assert.ok(localMedia({ vision: true, audio: false }).image !== undefined);
  });

  test("the order is for conversion: lossless first locally, smallest first over a network", () => {
    assert.equal(localMedia({}).audio?.[0]?.mime, "audio/flac");
    assert.equal(CHAT_MEDIA.audio?.[0]?.mime, "audio/mpeg");
    assert.equal(localMedia({}).image?.[0]?.mime, "image/png");
  });

  test("everything a sink takes that the registry calls direct is taken by some sink, and nothing else is", () => {
    const taken = new Set(specs.flatMap(([, s]) => [...(s.image ?? []), ...(s.audio ?? []), ...(s.pdf ?? [])].map((t) => t.mime)));
    // bmp is taken by a local server (stb_image) although no hosted provider takes it
    assert.ok(FORMATS.filter((x) => x.direct).every((x) => taken.has(x.mime)), "a direct format that no sink takes");
  });
});
