---
name: cloudflare-api
description: Use when a task needs to inspect or change Cloudflare resources such as Workers, DNS, R2, KV, D1, Pages, zones, firewall rules, or analytics through the Cloudflare API MCP.
---

# Cloudflare API

Load `toolplane-integrations` first. Discover this pack's exact qualified tool
IDs through Toolplane search and retrieve their live schemas before calling.

Cloudflare's server uses code mode. Its usual tools are:

- `docs` to search Cloudflare documentation.
- `search` to find API paths and their required inputs.
- `execute` to call a discovered API endpoint.

Use `docs` or `search` before `execute` when the endpoint or request shape is
not already known. Treat every `execute` operation as potentially mutating;
confirm the target account, zone, resource, and intended effect before writes.
Keep code mode enabled: it avoids loading thousands of endpoint schemas into
context.

Legacy Toolplane grants require single-use approval for every `execute` call and
unfamiliar method, even if generated code claims to be read-only. Explicit caller
policies override that default: follow the live `approvalPolicy` from exact-ID
search, and do not invent another manual gate for an automatically allowed call.
Do not bypass the gate with shell/API calls. Keep confirmation rules enabled.
Permission rejection is not an API failure to work around. After an interrupted
or timed-out write, inspect the resource before retrying: cancellation does not
guarantee the server operation stopped.
