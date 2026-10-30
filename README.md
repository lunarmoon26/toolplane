# Toolplane

A local-first operating console and capability broker for agent tools.
Humans and admin agents manage registrations through one API. Caller agents
receive only explicitly granted capabilities through **search + call**.

**Status:** working v0 vertical slice, not a production multi-tenant gateway.
Built with Bun, TypeScript, Hono, SQLite, MCPorter, and the MCP SDK. No LLM required.
The preceding [research and reproducible benchmark evidence](docs/research/README.md)
live in this repository; no separate research project is required.

## Start

Requires Bun 1.4.2+.

```sh
bun install --frozen-lockfile
bun run init
bun start
```

Open **http://127.0.0.1:4318**. Retrieve the private admin credential from
`.local/admin.token` and paste it into the console once. The token is exchanged
for an HttpOnly, SameSite=Strict browser-session cookie valid for seven days.
Refreshes and browser/service restarts preserve the login; **Lock console** revokes
it. The bootstrap token is never saved in localStorage/sessionStorage. Do not share
it with ordinary caller agents. Use the same host and port when returning:
`localhost` and `127.0.0.1` have separate browser sessions.

`init` never overwrites existing credentials. `TOOLPLANE_HOME` changes the state
directory; `TOOLPLANE_PORT` changes the port. An explicit `TOOLPLANE_ADMIN_TOKEN`
(at least 32 characters) replaces file-based bootstrap authentication. Rotate it
by stopping the service, replacing the token and restarting; existing caller
tokens remain independent. Admin key rotation invalidates browser sessions.
SQLite and upstream auth state stay under the home. If logout cannot reach the
service, the console warns that revocation is unconfirmed; refreshing may restore
that session until logout succeeds or it expires.

The Hono API and browser assets load together at service startup. After updating
the checkout, restart the service, then refresh the browser. Assets are not
hot-served from changing source files against an older backend.

### First workflow

1. **Register source** → choose the built-in demo. It starts disabled.
2. **Discover tools** → inspect the two tool schemas. Discovery invokes no tools.
3. **Enable** the source. This grants nobody access.
4. **Create caller key**, save the once-shown key, and select that caller.
5. Grant `status` in the catalog. `echo` remains inaccessible unless also granted.
6. Give the caller token to an agent through its environment, not its prompt.

No sources, host configuration or existing `opencode-*` integrations are imported
automatically. The demo never contacts external services. To register a real MCP
server, choose Remote MCP, enter its trusted endpoint, and optionally name a
service-side bearer environment variable. The admin API also accepts explicit
custom credential header references (`headersEnv`, described below); the form's
bearer field is not a custom-header setting. v0 does not launch interactive OAuth
or upstream stdio processes. Change upstream environment credentials by restarting
the service so cached clients pick them up.

### Background service on this Linux workstation

Toolplane runs as the transient user-systemd service `toolplane.service`, rather
than a chat-owned background process. It survives chat/process cleanup and restarts
on failure, but is **not enabled at boot** and does not survive a machine restart.
It inherits only the explicitly named Cloudflare token variable; no token is stored
in a repository file or printed in command arguments.

```sh
systemctl --user is-active toolplane.service
systemctl --user restart toolplane.service
systemctl --user stop toolplane.service
```

For a fresh start after reboot/stop, run from this directory with the token already
exported in that terminal (substitute your Bun path if different):

```sh
systemd-run --user --unit=toolplane --collect --working-directory="$PWD" \
  --property=Restart=on-failure --property=RestartSec=3 --property=UMask=0077 \
  --property=TimeoutStopSec=45 --setenv=CLOUDFLARE_API_TOKEN \
  "$HOME/.bun/bin/bun" src/main.ts
```

`restart` retains the service's captured environment. To rotate the token, stop
and recreate the transient unit from a terminal with the updated variable.

## Caller interfaces

### Portable meta-skill over registered provider skills

`skills/toolplane-integrations` applies to **any registered MCP source**, including
third-party providers such as Exa, as well as the bundled packs. Install that one
meta-skill from your Toolplane checkout into the desired client project:

```sh
bunx skills add /absolute/path/to/toolplane --skill toolplane-integrations
# Equivalent: npx skills add /absolute/path/to/toolplane --skill toolplane-integrations
```

The Skills CLI lets you choose target agents and defaults to project-level
installation; add `-g` only for a deliberately global installation. Keep the
source checkout available when using symlink-based installs. Select only this
skill to avoid installing every bundled workflow. No installer was run as part of
this feature; it does not change a global client configuration.

Install chosen official provider skills separately, for example:

```sh
bunx skills add exa-labs/agent-skills
```

Keep those upstream-owned files unchanged. In the host's project instructions,
make the intended broker workflow explicit:

> For registered-provider workflows, load `toolplane-integrations` before the
> provider skill. Use its domain guidance, but discover and invoke capabilities
> through Toolplane; do not execute direct API/SDK/CLI examples as a fallback.

This is **instruction composition**, not automatic skill dependencies, enforced
precedence, a generated-code sandbox or an installer for MCP sources. Installing
skills does not grant tools, import keys, authorize spend or connect a caller to
Toolplane. The host still needs the ordinary caller MCP/HTTP connection below.
Unknown/ungranted provider operations are reported, not routed around the broker.

#### Exa example: official skills, broker-owned transport

Canonical setup/tools/auth: <https://exa.ai/docs/get-started/exa-mcp>.
Broker-specific workflow and staleness notes:
[Exa adapter reference](skills/toolplane-integrations/references/exa.md).

An administrator can create this **disabled** registration through
`POST /api/admin/sources` (or `cli request` using an admin credential):

```json
{
  "name": "Exa",
  "config": {
    "kind": "mcp",
    "url": "https://mcp.exa.ai/mcp",
    "headersEnv": { "x-api-key": "EXA_API_KEY" }
  }
}
```

Only the environment-variable name is stored. The existing key must be in the
**service's environment**, not merely the caller's shell. An ordinary service
restart retains its captured environment; recreate it with the explicitly named
variable if necessary. No caller or ambient provider keys are forwarded. Restart
after credential changes to replace cached upstream clients.

`headersEnv` supports up to eight case-insensitively unique custom credential
headers with explicit uppercase environment-variable names. Inline `headers`
values, transport/session/cookie headers and `Authorization` overrides are
rejected; use `bearerEnv` for Bearer authentication. Missing, blank, invalid or
over-8-KiB values fail before connection without exposing the value. The existing
UI can inspect the registration, but custom-header creation currently uses the
admin API rather than the bearer-only form.

Custom-header sources use the official MCP SDK's **Streamable HTTP** transport,
with origin checks and redirects/cookies/environment proxies disabled. There is
no OAuth or legacy SSE fallback on that path. Keyless/Bearer-only sources and
bundled packs continue using MCPorter. Register the final Streamable HTTP URL;
do not rely on a redirect to carry a provider key to another endpoint.
An HTTP 404 on an established custom-header session discards that client for the
next explicit request. The failed invocation is not automatically retried.

After explicit setup, refresh the live catalog, inspect schemas, enable the
source and grant only the intended tools to the caller. Authentication is not a
grant. Generic MCP legacy grants ask even for search; admins may explicitly set
another caller policy. Paid research needs separate scope/spend consent as well
as a grant. No live Exa registration, discovery, search or key access was performed
for this change.

The canonical docs checked on 2026-10-29 say authenticated Exa catalogs enable
`agent_run` by default; older descriptions of it as always opt-in are stale.
Advanced search is still opt-in. Toolplane currently rejects URL query parameters,
so `?tools=` and OAuth `?login` examples are not accepted; use plain-endpoint live
discovery and explicit grants, and report missing tools instead of silently
installing a direct connection. Official API skills can cover products beyond
the MCP catalog; those do not become callable just because a skill is installed.

### OpenCode workstation connection and skill ownership

This workstation's global OpenCode configuration connects the local Toolplane
stdio facade with a dedicated **OpenCode** caller. Its credential is referenced
from `.local/opencode-caller.token`, not the admin token. Connection alone grants
no capabilities: enable sources and grant selected tools in the console.

OpenCode explicitly loads `skills/` and each integration pack's `skills/`
directory from this checkout. Load `toolplane-integrations` before domain skills.
The migration backup is under `.local/migrations/`.

Leave unrelated `bunx skills add` installations in `~/.agents/skills` and their
`.skill-lock.json` managed by that installer. Toolplane-owned adapters live here,
outside that update lifecycle; do not overwrite an installer-managed skill in
place. Before adding an overlapping skill, check for duplicate names and select
one authoritative source rather than relying on discovery precedence. Four
official Notion skill trees remain unmodified. No matching legacy integration
plugins or managed skills were found on this Linux workstation during migration;
other machines require their own inventory.

Set `TOOLPLANE_TOKEN` to a caller key. `TOOLPLANE_URL` defaults to the localhost
service above and only accepts loopback HTTP origins.

```sh
bun run cli search 'demo status'
bun run cli describe '<qualified-id-from-search>'
bun run cli call '<qualified-id-from-search>' '{}'
```

The stdio MCP facade exposes exactly `search` and `call`:

```sh
bun run mcp
```

Configure a harness's MCP process to run `bun src/mcp.ts` with this project as
its working directory and the caller token in its environment. The service must
already be running. This facade does **not** expose administration.

Search returns compact candidates; `search` with `{ "id": "…" }` returns the full
schema. Callers can reuse known IDs without another search. All discovery and
invocation paths check current grants, source state and credential revocation.

### Experimental local search reranking

Search remains deterministic BM25 by default. An operator can opt into a trusted
**local System One-compatible** endpoint using `TOOLPLANE_SEARCH_RANKER`, a JSON
object parsed at startup. No key is read, no model is downloaded/launched, and
this experiment has **no hosted Jev/Mercury/OpenRouter transport**. Use the exact
model name and endpoint supplied by your local server; a regular chat-completions
endpoint is not interchangeable with System One.

```sh
export TOOLPLANE_SEARCH_RANKER='{"url":"http://127.0.0.1:8765/v1/systemone","model":"your-local-model","mode":"noul","poolSize":30,"timeoutMs":1000,"maxConcurrent":2}'
```

Restart a development instance with that environment to enable ranking. Omit the
variable and restart to disable it. Existing background services do not inherit
new variables from a terminal. This feature does not reconfigure the running
workstation service or any harness.

- `mode`: `noul` (default, one usefulness question per candidate in a batch) or
  `choice` (one comparison across the pool). Neither score is treated as calibrated
  confidence. The endpoint must return the configured model identity exactly.
- `poolSize`: 2–50, default 30; at least the caller's requested limit is retrieved.
  `timeoutMs`: 1–10,000, default 1,000. `maxConcurrent`: 1–8, default 2.
- Only numeric-loopback HTTP is allowed, with no URL credentials/query/fragment.
  Redirects, cookies and environment proxies are disabled. The endpoint receives
  the search query and authorized compact cards—not schemas, credentials, policies,
  invocation arguments or tool results. Trust the server's own egress/retention.
- Exact IDs, empty pools and single candidates bypass inference. A valid ranking
  reorders the entire lexical shortlist before applying the existing public limit
  (at most ten). It does not prune, merge tool identities, or execute anything.
- Timeouts, capacity limits, invalid answers and abstention use lexical order.
  Three consecutive failures open a 30-second circuit. There are no retries or
  waiting queues. Timed-out work retains capacity until it settles. Request
  cancellation aborts ranking. Live visibility/fingerprint changes discard it.
- Enabled multi-candidate query responses include `ranking.status` (`reranked` or
  `fallback`) and a bounded fallback reason. Search content is not persisted.

Reranking cannot recover tools BM25 did not retrieve, and cannot resolve unsupported
requests by itself. It is not an authorization or safety gate. Start with offline
fixtures before opting a development instance into inference.

#### Offline discovery evaluation

```sh
bun run eval:search
bun run eval:search --limit 1
```

These commands make **no model calls**, even if the ranker variable is set. They
evaluate a handwritten smoke fixture (12 tools, 16 requests) and report candidate
recall, recall/NDCG/MRR at the requested limit, all-required-tools coverage, and
empty-retrieval accuracy for no-match requests. Chinese misses are included rather
than hidden by conditional scoring. This is not a production benchmark or evidence
of downstream task success. Candidate recall is measured before reranking.

To send only the synthetic fixture to your explicitly configured local endpoint:

```sh
bun run eval:search --ranker --limit 1
```

The result compares lexical and ranked output on identical pools and reports
fallback counts. `--fixture path/to/sanitized-fixture.json` accepts the same format
as `tests/fixtures/search-ranking.json` (at most 500 tools/cases and 1 MiB). Use
distinct source-qualified IDs and complete required-tool labels. The evaluator
does not contact registered tools, read live catalogs, or load caller credentials.
Do not send private catalog fixtures to a server without reviewing its data policy.

### Caller policies and approvals

Select a caller in **Tool catalog**, select tools individually, by source group,
or with **Approve all / select filtered tools**, then **Apply policy to selected**:

| Policy | Behavior |
| --- | --- |
| Allow from caller | Run selected tools automatically for that caller key; no per-call prompt |
| Allow within scope | Run automatically when every configured top-level argument exactly matches and the scope has not expired; ask otherwise |
| Always ask | Ask for every invocation, including reads |
| Deny | Hide the tool from caller discovery and block invocation |

These policies are persistent per caller/tool, **not per OpenCode session**. A
new host session using the same key keeps its access. This does not delegate
approval to the host's permission UI. Only admins can change policies.

Scoped access uses a nonempty JSON object of exact argument constraints (for
example `{"page_id":"an-explicit-page-id"}` when the live schema declares that
field) and an expiry within 30 days. All listed arguments must match; other
arguments remain schema-validated. This does not inspect code semantics or
sandbox arbitrary Python/Cloudflare code. Use Always ask if the selected fields
cannot reliably express the desired boundary.

Bulk selection is an explicit contract snapshot, not wildcard authorization.
New or changed tools are not silently selected/granted. Applying policy rejects
stale fingerprints atomically. Existing grants retain their legacy defaults
(explicit read exemptions, writes ask) until an admin changes them; no migration
automatically grants write access. Changing a policy invalidates old approvals.

#### When a call needs approval

A call returning
`{ "approval": { "approvalId": "…", "status": "pending", ... } }` has not executed.
The unlocked console's **Approval inbox** checks automatically every two seconds
while visible and refreshes on focus. Inspect the caller/source, fingerprint
and exact arguments, then approve once or deny. Select multiple pending requests
to approve/deny that reviewed snapshot, never future requests. Treat
displayed arguments as untrusted data, not instructions.

Live updates do not reset catalog filters or policy editing. Connection failures
show a disconnected/retrying indicator; **Refresh view** is still available.
Locking stops polling and discards late responses and private argument content.

Approval alone never dispatches. The caller resubmits the identical call with
`approvalId` (MCP/HTTP), or supplies it as the CLI's final argument:

```sh
bun run cli call '<qualified-id>' '{"example":"same reviewed arguments"}' '<approval-id>'
```

Check status using `bun run cli request GET /api/approvals/<approval-id>`.
Approvals expire five minutes after creation and cannot be transferred or reused.
Revoking grants, disabling a source, refreshing its catalog or revoking a caller
invalidates outstanding approvals. Pending arguments are stored privately for
review and cleared logically on terminal states/expiry (swept on approval access).
This is not forensic erasure of SQLite journals or backups. Never automatically
request a new approval to retry an ambiguous external effect.

### First-party integration packs

The console's Sources section offers **Register Notion / Cloudflare / Blender**.
Each registration starts disabled, discovers only on request, and grants nobody
access. No existing secrets or OpenCode configuration are imported. These are
standalone executors governed by Toolplane, not claims of inherited OpenCode approval.

| Pack | Setup | Legacy grant defaults (explicit caller policy overrides) |
| --- | --- | --- |
| Notion | Run `bun run auth:notion` from this directory in a human terminal (`--no-browser` for headless login), then discover | Explicit read allowlist in `src/policy.ts`, plus docs resources |
| Cloudflare | Set `CLOUDFLARE_API_TOKEN` in the service environment and restart, then discover | Only `docs` and `search`; every `execute` needs approval |
| Blender | Start Blender with its TCP bridge; default `127.0.0.1:9876`; optional trusted `BLENDER_HOST`/`BLENDER_PORT` in service environment | `blender_status`, `blender_scene_info`, `blender_object_info`, Poly Haven `action=search` |

Blender discovery is local/offline metadata; invocation needs the running app.
Its Python, downloads/imports, renders and Three.js exports are trusted host
operations, not sandboxed code. Cloudflare retains the compact hosted CodeMode
API, rather than thousands of endpoint definitions. Notion OAuth uses MCPorter
under the dedicated `toolplane-notion` identity/cache; no old tokens are copied.
The service never starts an interactive OAuth flow. Restart after authentication
if a pooled connection still reports its prior auth state.

Load [`toolplane-integrations`](skills/toolplane-integrations/SKILL.md) before the bundled domain skills. It maps
their symbolic/native method names onto qualified Toolplane IDs. Skills are local
workflow files, not automatically installed or executed. Four official Notion
skill trees remain unchanged; see [provenance and archive gates](packs/PROVENANCE.md).
Sketch/Xcode, skill extraction automation and authenticated provider parity are
not completed. Do not archive the old projects yet.

The migrated read-only Notion exporter uses the caller API and a granted fetch ID:

```sh
python3 packs/notion/skills/notion-markdown-export/scripts/export_markdown.py --help
```

See its [workflow](packs/notion/skills/notion-markdown-export/SKILL.md) for scoped
export/resume instructions. No live export is run as a migration test.

## Admin agents and HTTP API

Admin agents use the same API as the UI. Supply an **admin** bearer credential,
not a caller key. Administration is privileged: it can register remote endpoints
and grant caller access. It does not authorize tool calls with that admin token.
The CLI's generic JSON client accepts `request METHOD PATH [JSON]`, with `-` for
stdin. Avoid embedding secret values in command arguments.

| Method | Path | Body / purpose |
| --- | --- | --- |
| GET | `/health` | Unauthenticated service liveness |
| POST | `/api/admin/session` | Admin bearer only: establish a seven-day browser session via Set-Cookie; bootstrap token not retained by browser scripts |
| GET | `/api/admin/session` | Session/authentication status and expiry; no credential values |
| DELETE | `/api/admin/session` | Same-origin sign-out: revoke current session and expire cookie; idempotent |
| GET | `/api/admin/state` | Sources, catalog, callers, grants, last 100 receipts; no token values |
| POST | `/api/admin/sources` | `{ "name": "Demo", "config": { "kind": "demo" } }` |
| POST | `/api/admin/sources` | `{ "name": "Service", "config": { "kind": "mcp", "url": "https://example.com/mcp", "bearerEnv": "SERVICE_TOKEN" } }` |
| POST | `/api/admin/sources/:id/refresh` | Explicit catalog discovery; preserves previous catalog on failure |
| PATCH | `/api/admin/sources/:id` | `{ "enabled": true }` or false |
| POST | `/api/admin/callers` | `{ "name": "Research agent" }`; returns caller key once |
| PUT | `/api/admin/callers/:id/grants` | `{ "toolId": "…", "granted": true }` or false |
| PUT | `/api/admin/callers/:id/policies` | `{ "tools": [{ "id": "…", "fingerprint": "…" }], "policy": { "mode": "allow" } }`; mode `allow`, `scope`, `ask`, or `deny`; scope also requires `equals` and `expiresAt` (epoch milliseconds) |
| DELETE | `/api/admin/callers/:id` | Revoke credential and grants |
| GET | `/api/admin/inbox` | Latest 100 approvals, active first; private arguments for admin review |
| POST | `/api/admin/approvals` | `{ "ids": ["…"], "decision": "approved" }` or `"denied"`; atomic bulk decision, no dispatch |
| POST | `/api/admin/approvals/:id` | `{ "decision": "approved" }` or `"denied"`; no execution |
| GET | `/api/approvals/:id` | Caller only: own request status |
| POST | `/api/search` | Caller only: `{ "query": "…", "limit": 5 }` or `{ "id": "…" }` |
| POST | `/api/call` | Caller only: `{ "id": "…", "arguments": {}, "approvalId": "optional-approved-request-id" }` |

Inputs are validated in [`src/contracts.ts`](src/contracts.ts). JSON errors use
`{ "error": { "code": "…", "message": "…" } }` and appropriate HTTP status codes.
Caller output retains MCP `content`, `structuredContent`, and error flags inside
the invocation result. Unknown effects and oversized completed results are explicit
errors, not silent retries or truncation.

## Safety boundaries

- Localhost only. No CORS or query-string credentials. Browser administration uses
  a host-only HttpOnly/SameSite=Strict cookie limited to `/api/admin`; mutations
  require a matching Origin. Caller APIs still require caller bearer credentials.
  Sessions are stored hashed in SQLite, bound to the admin key, origin and expiry.
  Trusted local HTTP is not remote/multi-tenant session isolation.
- All tools, including reads, require explicit grants. Read-only hints grant nothing.
- Grants bind to discovered input/output schemas and description fingerprints.
  Changed or removed tools lose grants. Upstream behavior can still change without
  a descriptor change: registration is a trust decision, not code attestation.
- Caller tokens are hashed in SQLite. Receipts omit arguments, results and raw
  upstream errors. Token values are never returned by the state API.
- Existing native permission UIs are not bypassed: migrated standalone packs use
  the Toolplane approval owner. Running OpenCode plugins are unchanged; no native
  session approval is inferred, imported or manufactured.
- No automatic retries. Cancellation or disabling does not undo an in-flight call.
- Current limits: 64 KiB request bodies, 500 tools / 1 MiB per refresh, 128 KiB
  draft-07 / 2020-12 input schemas, 128 KiB invocation results, 30-second deadlines, four
  active calls per source / sixteen total. Transport results may arrive before the
  broker can enforce its size limit; this is not a hostile-server memory sandbox.

See [the behavior contract](docs/contract.md) for ownership and limitations.
Semantic retrieval, skill-manifest discovery adapters, native CodeMode, individual admin
identities, registration editing/deletion and remote deployment
are follow-up work, not implemented capabilities.

## Verify

```sh
bun run check
bun test
bun run test:python
```

The integration test drives actual HTTP management → stdio MCP caller → broker →
MCPorter → a local synthetic MCP server. It never contacts live services.

Browser test (requires Python, uv, Playwright and its Chromium headless shell):

```sh
uv run --with playwright==1.63.0 python -m playwright install chromium --only-shell
bun run test:ui
```

The launcher starts a temporary in-memory fixture registry on a random port and
stops it afterward; it does not use your `.local` database. Screenshots in
`test-results/` omit issued tokens and are ignored by Git.
