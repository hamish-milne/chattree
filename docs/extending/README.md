# Extending chattree

Where chattree can be extended, and how. Each page is the contract for one extension point: what you implement, what the harness promises you, how to register it, and how to test it.

| You want to | Read |
|---|---|
| Support a new model API or service | [Provider adapters](provider-adapters.md) |
| Give the model a new tool | [Tools](tools.md) |
| Teach the model a procedure, or connect an external tool server | [Skills and MCP servers](skills-and-mcp.md) |
| Run a local model that needs its own prompt format and output parsing | [Dialects](dialects.md) |
| Run chattree's commands and files somewhere other than this machine | [Hosts](hosts.md) |
| Build a user interface or service on top of the library | [Embedding](embedding.md) |

**Plugins.** There is no plugin system yet: every extension above is code in the repository, registered in a list in the source. A plugin system, which would let a package add adapters, tools and dialects without changing chattree, is planned. These pages are written so that what they describe (a definition plus a registration) is what a plugin would supply.

**Before you start.** Read [`docs/conventions.md`](../conventions.md) for how code is written here, and [`docs/map/index.md`](../map/index.md) for where things live. The test and lint gates apply to extensions as to everything else.
