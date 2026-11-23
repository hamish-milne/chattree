# ADR 42: A background job is approved when it starts

Status: accepted

## Context

A background job (ADR 28) runs after the call that started it has returned. The call was approved by a grant (a one-off yes, or a standing rule); a standing grant can lapse (its time runs out, or the person revokes it) while the job is still running.

## Decision

The approval is the one given at the start. Nothing re-checks a grant while the job runs, and a job is not stopped because the grant that allowed it has lapsed. The person can stop any job from the jobs list at any time (ADR 28).

## Why

- What the approval covered was the command, with its arguments. A lapse later does not change what was approved, and killing a half-finished build or install is more likely to do harm than let it finish.
- A rule that re-checked would need a definition of "the same call" while its output changes, and a decision about what to do with a job that is part-way through (leave it, kill it, ask).
- The risk is bounded: jobs are `run` and `script`, and the person sees them in the jobs list and can stop them.

## Notes

Revisit if a kind of job can start further work that is not covered by the first approval (a `subagent` run as a job would: its own calls ask on their own, but it spends money after a budget grant has lapsed). Subagent budgets are in the parking lot.
