# ADR 40: A quick start keeps the conversation outside the repository

Status: accepted

## Context

Starting a conversation in an existing repository put the transcript on one of its branches, and every entry then committed the working tree's pending changes with it (`init --adopt`). That is the right shape for a project that is the conversation, and the wrong first impression for a person who has code and wants to try the editor: it asks them to accept commits in their repository before they have seen anything. ADR 38 made the opposite arrangement possible: the conversation is its own repository and the code is attached to it. What was missing was a way to attach code that is not a child of the conversation, and a way for the editor to find the conversation from the code.

## Decision

- The editor offers, for a workspace folder that is the top level of a git repository with no conversation, a **quick start**. It makes a conversation (no provider yet) in the `conversations` folder of the user's data directory, named for the repository and a short hash of its path, and attaches the repository to it as an external attachment (ADR 38). The repository's branches, commits and files are not touched; the only thing added is a hidden keep-alive ref under `refs/chattree/` that holds what the harness needs to put the person's work back.
- **The link from the code to the conversation lives with the code**, in the workspace folder's own settings (`.vscode/settings.json`): `chattree.attach` maps the path of each repository, relative to the folder (`.` for the folder itself), to the conversation's folder. A moved or renamed repository takes the record with it. When the editor opens a folder whose record names a conversation, it shows that conversation (the relation is inverted: the folder is the code, the graph is the conversation's) and, if the link inside the conversation points anywhere else, makes it again at the code's current path.
- The name the code has inside the conversation comes from the key (`.` is `code`, another path is that path with `-` for separators), so it is the same on every machine and never depends on where the code is.
- `init --adopt` stays for the command line. The editor no longer offers it.
- Moving later to the usual arrangement, where the code is a submodule of the conversation, is a few git commands and no change to `attached.yml` (the name stays the same). The steps are in the guide.

## Why

- The first thing a new person does should leave their repository as it was.
- Putting the record in the editor's settings, keyed by the path relative to the folder, is what survives a move; a record kept in the conversation or in the user's settings would hold an absolute path that goes stale.
- The conversation is found from the code, not the other way, because the code is what the person opens.

## Consequences

- The command line does not see the link: run from inside a quick-started repository it finds no conversation. Opening the conversation's folder works, and a command to reach it by the code's path is a first step if it is wanted (parking lot).
- Only a workspace folder that is itself a repository's top level is offered a quick start. The map allows several repositories under one folder; the editor does not yet offer to add them.
- A conversation whose folder has gone (the data directory was cleared) is reported against the folder, with the setting to remove to start again.
