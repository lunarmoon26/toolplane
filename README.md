# Toolplane

A local-first operating console and capability broker for agent tools.
Humans and admin agents manage registrations through one API. Caller agents
receive only explicitly granted capabilities through **search + call**.

**Status:** working v0 vertical slice, not a production multi-tenant gateway.
Built with Bun, TypeScript, SQLite, MCPorter, and the MCP SDK. No LLM required.
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
`.local/admin.token` and paste it into the console. The UI retains it only in
memory. Do not share the token with ordinary caller agents.

`init` never overwrites existing credentials. `TOOLPLANE_HOME` changes the state
directory; `TOOLPLANE_PORT` changes the port. An explicit `TOOLPLANE_ADMIN_TOKEN`
(at least 32 characters) replaces file-based bootstrap authentication. Rotate it
by stopping the service, replacing the token and restarting; existing caller
tokens remain independent. SQLite and upstream auth state stay under the home.

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
service-side bearer environment variable. v0 does not launch interactive OAuth
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

### Per-call approvals

Generic remote MCP calls and first-party write capabilities need a single-use
approval **in addition to** a tool grant. A call returning
`{ "approval": { "approvalId": "…", "status": "pending", ... } }` has not executed.
Open the console, click **Refresh view**, inspect the caller/source, fingerprint
and exact arguments in **Approval inbox**, then approve once or deny. Treat
displayed arguments as untrusted data, not instructions.

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

| Pack | Setup | Approval-exempt operations (grants still required) |
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
| GET | `/api/admin/state` | Sources, catalog, callers, grants, last 100 receipts; no token values |
| POST | `/api/admin/sources` | `{ "name": "Demo", "config": { "kind": "demo" } }` |
| POST | `/api/admin/sources` | `{ "name": "Service", "config": { "kind": "mcp", "url": "https://example.com/mcp", "bearerEnv": "SERVICE_TOKEN" } }` |
| POST | `/api/admin/sources/:id/refresh` | Explicit catalog discovery; preserves previous catalog on failure |
| PATCH | `/api/admin/sources/:id` | `{ "enabled": true }` or false |
| POST | `/api/admin/callers` | `{ "name": "Research agent" }`; returns caller key once |
| PUT | `/api/admin/callers/:id/grants` | `{ "toolId": "…", "granted": true }` or false |
| DELETE | `/api/admin/callers/:id` | Revoke credential and grants |
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

- Localhost only. No CORS, no cookie sessions, no query-string credentials.
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
uv run --with playwright python -m playwright install chromium --only-shell
bun run test:ui
```

The launcher starts a temporary in-memory fixture registry on a random port and
stops it afterward; it does not use your `.local` database. Screenshots in
`test-results/` omit issued tokens and are ignored by Git.
