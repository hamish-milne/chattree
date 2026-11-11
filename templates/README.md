# Chat templates

Patched copies of a model's own chat template, for `local_models.models.<name>.chat_template` (llama-server `--chat-template-file`).

- `gpt-oss.jinja`: the stock gpt-oss template (as embedded in the Unsloth Q4_K_M file, build b12110 of llama.cpp) with one change: a past tool call is
  rendered as `<|start|>assistant<|channel|>commentary to=functions.x <|constrain|>json<|message|>{…}<|call|>`, the form harmony defines and the model
  writes, instead of `<|start|>assistant to=functions.x<|channel|>commentary json<|message|>`. With the stock form the model's first tokens after a
  tool result are junk (`<|channel|>comment?commentary?`) and llama-server answers 500 "does not match the expected peg-native format"
  (docs/local-models.md, 8.2). Checked by rendering both with Jinja2 against a recorded request and comparing with the prompt that gave clean
  output; not yet checked against llama.cpp's own Jinja engine, which is what the live run is for.

Use an absolute path, or one relative to the settings file:

```yaml
local_models:
  models:
    gpt-oss-20b: { hf: "unsloth/gpt-oss-20b-GGUF:Q4_K_M", chat_template: /path/to/chattree/templates/gpt-oss.jinja }
```
