#!/usr/bin/env python3
"""Render a model's own chat template over the template scenarios, as parity fixtures for a dialect (test/support/templates.ts).

    python3 tools/jinja-fixture.py FAMILY TEMPLATE [--bos TEXT] [--eos TEXT] [--string-args] [--tool-names] [--null-as-empty] [--var NAME=VALUE ...]

FAMILY is the directory under test/fixtures/templates to write (it gets `<scenario>.request.json` and `<scenario>.prompt.txt`);
TEMPLATE is a `.jinja` file or a `tokenizer_config.json` with a `chat_template`. The scenarios are the requests of the `qwen`
family there. The environment is the one transformers uses (trim_blocks, lstrip_blocks, `tojson` without escaping non-ASCII,
`raise_exception`, `strftime_now`); llama-server's own renderer (minja) agrees with it on the templates tried so far, but
`tools/template-compare.ts` is the check against the server itself.

  --bos TEXT       the `bos_token` (default empty: dialects leave the BOS to the server, where it adds one itself)
  --eos TEXT       the `eos_token` (default empty; Mistral's template writes it after every assistant message)
  --string-args    pass a call's arguments as a JSON string, as the OpenAI wire does (DeepSeek's template needs it)
  --tool-names     put the tool's name on its result message (`name`), as Kimi's template uses it
  --null-as-empty  an assistant message with calls and no text has content "" and not null (Mistral's template needs it)
  --var NAME=VALUE extra template variables (`true`/`false` read as booleans), such as enable_thinking=false
"""
import json
import sys
from pathlib import Path

import jinja2
from jinja2.ext import loopcontrols
from jinja2.sandbox import ImmutableSandboxedEnvironment

ROOT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "templates"
SCENARIOS = ["one-call", "reasoning-between-calls", "after-final-answer", "nested-schema", "multiline-argument", "error-result", "two-calls-at-once"]


def tojson(x, ensure_ascii=False, indent=None, separators=None, sort_keys=False):
    return json.dumps(x, ensure_ascii=ensure_ascii, indent=indent, separators=separators, sort_keys=sort_keys)


def render(template: str, request: dict, bos: str, eos: str, string_args: bool, tool_names: bool, null_as_empty: bool, extra: dict) -> str:
    def raise_exception(message):
        raise jinja2.exceptions.TemplateError(message)

    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=[loopcontrols])
    env.filters["tojson"] = tojson
    env.globals["raise_exception"] = raise_exception
    env.globals["strftime_now"] = lambda fmt: "2026-11-11"
    messages = json.loads(json.dumps(request["messages"]))
    names = {}
    for m in messages:
        if null_as_empty and m.get("content") is None:
            m["content"] = ""
        for c in m.get("tool_calls") or []:
            names[c["id"]] = c["function"]["name"]
            args = json.loads(c["function"]["arguments"]) if isinstance(c["function"]["arguments"], str) else c["function"]["arguments"]
            c["function"]["arguments"] = json.dumps(args, ensure_ascii=False) if string_args else args
        if m["role"] == "tool" and tool_names:
            m["name"] = names.get(m.get("tool_call_id"), "")
    return env.from_string(template).render(messages=messages, tools=request["tools"], add_generation_prompt=True, bos_token=bos, eos_token=eos, **extra)


def main() -> None:
    argv = sys.argv[1:]
    if len(argv) < 2:
        sys.exit(__doc__)
    family, source = argv[0], Path(argv[1])
    bos, eos, string_args, tool_names, null_as_empty, extra = "", "", False, False, False, {}
    i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--bos":
            bos = argv[i + 1]
            i += 1
        elif a == "--eos":
            eos = argv[i + 1]
            i += 1
        elif a == "--string-args":
            string_args = True
        elif a == "--tool-names":
            tool_names = True
        elif a == "--null-as-empty":
            null_as_empty = True
        elif a == "--var":
            k, v = argv[i + 1].split("=", 1)
            extra[k] = {"true": True, "false": False}.get(v, v)
            i += 1
        else:
            sys.exit(f"unknown option {a}")
        i += 1
    text = source.read_text(encoding="utf8")
    template = json.loads(text)["chat_template"] if source.suffix == ".json" else text
    out = ROOT / family
    out.mkdir(parents=True, exist_ok=True)
    for s in SCENARIOS:
        request = json.loads((ROOT / "qwen" / f"{s}.request.json").read_text(encoding="utf8"))
        (out / f"{s}.request.json").write_text(json.dumps(request, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
        (out / f"{s}.prompt.txt").write_text(render(template, request, bos, eos, string_args, tool_names, null_as_empty, extra), encoding="utf8")
    print(f"wrote {len(SCENARIOS)} scenarios to {out}")


main()
