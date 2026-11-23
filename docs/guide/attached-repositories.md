# Attached repositories

A conversation is a repository, and the model works in its folder. Your production code is better kept apart from that: the conversation is scratch space and a transcript, and the code is *attached* to it. The model can use git in the attached code; chattree records what is uncommitted in it with every snapshot, so rewinding or forking a thread brings the code back as it was. The model commits there only when you ask (a line in your instructions can make that standing).

There are two ways to attach code.

- **As a submodule** of the conversation's repository: the usual arrangement for a project that you start from the command line.
- **Linked in from elsewhere**: the code stays where it is, and the conversation holds a link to it. This is what the editor's quick start makes.

Either way the code has a name in the conversation (`code` by default), threads other than the one in the project folder get their own checkout of it, and merging a fork or subagent merges its code by what it found there (see [Concepts](concepts.md)).

## Quick start in the editor

Open a folder that is a git repository with no conversation. The repository picker offers to start one. Choosing it:

- makes a conversation in chattree's `conversations` folder (under your data directory, `%LOCALAPPDATA%\chattree` on Windows), named for the repository;
- attaches your repository to it; your branches, commits and files stay as they are (chattree keeps hidden refs under `refs/chattree/` in your repository, which hold what it needs to restore your work);
- saves the link in the folder's `.vscode/settings.json`, under `chattree.attach`, as a map from the repository's path (`.` for the folder itself) to the conversation. It lives with the code, so moving or renaming the folder does not break it. You may want to keep `.vscode/settings.json` out of version control.

The settings sheet then opens on Providers, as for any new conversation.

## Moving to a submodule

If you would rather have the conversation hold the code as a submodule (to keep both in one place, say, or to clone them together), the steps are a few git commands. `attached.yml` needs no change, because the code keeps its name, and nothing is lost: the repository itself moves in, so its uncommitted work, its branches and the hidden refs chattree keeps in it all come with it. Run them with no thread running, in the conversation's folder (the path is in `chattree.attach`):

```sh
# 1. Stop treating the code as linked in: remove the link, its entry in the repository's config,
#    and its line ("/code") in .git/info/exclude.
rm code                       # on Windows: rmdir code (removes the junction, not the code)
git config --unset-all chattree.external
#    delete the line "/code" from .git/info/exclude

# 2. Move your repository to where the link was, and register it as a submodule under the same name.
mv /path/to/your/repo code
git submodule add "$(git -C code remote get-url origin)" code    # or the path "$PWD/code" if it has no remote
git commit -m "Attach the code as a submodule"
```

Then remove the entry from `chattree.attach` (in the settings file that is now in `code/.vscode/`) and open the conversation's folder in the editor. Threads that have their own checkouts of the code keep working: a checkout is a worktree of the repository, which has moved with its folder (run `git -C code worktree repair` if one reports a missing path).

To go the other way, move the submodule's repository out (`git submodule deinit`, `git rm`, and `mv code /path/to/your/repo`), then link it in again: the editor's quick start does that.

## Pushing

`/push [remote]` pushes the branch checked out in each attached repository, then the conversation's own branch if it has a remote. The code goes first, so the commits a fetched conversation names are there. It stops at the first failure and prints the command to retry.

## Settings

`attached` in `harness.yml` controls the note the model is given about attached repositories (`note`, `guidance`), the name of the branch made for a thread that commits (`branch_prefix`) and how merges treat code (`merge`): see [Configuration](configuration.md).
