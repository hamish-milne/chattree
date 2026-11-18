# ADR 36: Application services are their own layer, between the hosts and the harness

Status: accepted

## Context

A second host (the extension's controller) needs what the CLI already does that is not a turn: start a project, read the user's settings file, build the provider registry (the local models' runtime included), set up the tools. That code sat in `cli/` and spoke in terms of a terminal (`Io`, `CliError`). It cannot go in `harness/`, which knows nothing of the settings file, the environment or the local model host.

## Decision

`app/` holds the application services every host shares: the user settings file, the provider registry, `init`, and (as the controller needs them) opening a project and building the tool set. It depends on `harness/`, `providers/`, `localmodels/` and `src/`; `cli/` and `ui/controller/` depend on it. It takes an `AppEnv` (the host, environment variables, working directory, clock and settings) and nothing from a terminal; a person's mistake is an `AppError` with a hint, which each host shows in its own way (`CliError` is an `AppError` the CLI raises for its own).

## Why

The harness stays a library with no settings, no environment and no machine knowledge; the CLI and the extension host become thin and cannot drift apart on what `init` does. Moving the code is cheaper now, with two callers, than untangling it later.

## Notes

The CLI's session engine (drafts, escape handling, prompt width) stays in `cli/`: it is terminal state, not a service.
