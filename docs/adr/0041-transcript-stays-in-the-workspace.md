# ADR 41: The transcript stays in the workspace the agent sees

Status: accepted

## Context

The transcript (`chat.yml`), the blobs and the conversation's own commits live in the same repository as the workspace (ADR 8), so `ls -R`, `grep -r` and `git log` in the workspace show them. Early on, gemma and gpt-oss stumbled over this: extra requests and repeated checks. The options were to hide the conversation's files (a hidden directory, or filtering them out of `run`'s listings) or to say in the prompt which files they are.

## Decision

Leave the layout as it is. The file tools refuse writes to `chat.yml`, `harness.yml`, `.git`, `.chattree` and `blobs`, and refuse reads of `.git` and `.chattree`; the note about attached repositories (ADR 38) tells the model the workspace itself is scratch space and the code that ships is in the attached repositories. With the instructions as they are, models behave well in this layout (the maintainer's judgement from use, not a measurement), so nothing is hidden and the conversation's files are not listed in the prompt.

## Why

- Hiding the files from `run` would mean intercepting shell commands, which cannot be done reliably, and a hidden directory would change the format (ADR 4, 8) for a problem the instructions already solve.
- Production code does not live in this repository. It is attached (ADR 38), or kept outside the conversation by a quick start (ADR 40), so a `git` command in the workspace is about the conversation, and a `git` command in an attached folder is about the code. That split is the answer to "what may the model do with git": the conversation's repository is the harness's, and the code's repository is the model's to work in.

## Notes

- Not settled: what the model should be able to do when it wants a repository of its own in the workspace, to commit to or only to explore (`git init`, `git clone`). See the parking lot.
- Revisit if a model is found that cannot be told, or if the transcript's size makes `grep -r` in the workspace slow.
