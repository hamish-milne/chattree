import assert from "node:assert/strict";
import { test } from "node:test";
import { configJsonSchema } from "../../harness/config-schema.ts";
import { harnessSchema } from "../../ui/fixtures/harness-schema.ts";
import { defaultRegistry } from "../../providers/index.ts";

test("the schema the mock editor uses is the harness's own (regenerate with tools/gen-ui-schema.ts)", () => {
  assert.deepEqual(harnessSchema, JSON.parse(JSON.stringify(configJsonSchema(defaultRegistry()))));
});
