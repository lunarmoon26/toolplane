# Toolplane v0 contract

## Persistent browser administration (2026-10-23)

The console exchanges a valid admin bearer credential for a random, seven-day
browser session. The session cookie is HttpOnly, SameSite=Strict, host-only and
restricted to `/api/admin`; the bootstrap admin token is never stored in browser
storage. SQLite stores only session hashes, admin-key binding, origin and expiry.
Reloads/browser restarts/service restarts preserve an unexpired login. Admin key
rotation invalidates its sessions. Bearer authentication remains available to
admin API clients; browser sessions cannot authenticate caller APIs or mint more
sessions without the bootstrap credential. Cookie-authenticated mutations require
an exact same-origin Origin header, in addition to the loopback/Origin checks.

Lock console revokes the current server-side session, expires the cookie, clears
private UI state and stops polling. Other tabs sharing that session lock when
their next request detects revocation. Expiry/revocation returns the UI to login;
network failures alone do not discard the login. If logout cannot reach the server,
the UI warns that revocation is unconfirmed instead of promising secure logout.
The UI never replays a failed mutation automatically. This remains a trusted
loopback HTTP app, not a secure remote/multi-tenant browser-session service.

Acceptance: reload/reopen/restart persistence, hash-only storage, expiry/key
rotation/logout revocation, cookie attributes, CSRF/role separation, multi-tab
expiry detection, and late-response lock protection.

## Caller policy and live inbox delta (2026-10-22)

Caller/tool policies persist in SQLite across host sessions and service restarts.
Admins choose **Allow from caller**, **Allow within scope**, **Always ask**, or
**Deny**. Callers cannot change these policies or self-approve. This is broker-owned
trust, not delegation to OpenCode's native permission UI. Policies bind to the
exact descriptor fingerprint; new/changed tools need new grants.

Scoped policies contain a nonempty map of exact top-level argument values and a
future expiry (up to 30 days when configured). Every listed field must be present
and canonically JSON-equal. Other arguments still use the tool's input schema.
Calls outside the constraints or after expiry require approval; matching calls
run automatically. This constrains the submitted arguments, not code semantics,
Python/network/filesystem access, or the downstream effects of an opaque program.
Do not use an unrelated field to claim resource isolation of arbitrary code.

Allow runs without per-call prompts, Ask includes reads, and Deny removes the tool
from caller discovery and blocks dispatch. Existing grants retain legacy read
exemptions/write approvals until explicitly changed; migration never broadens
access. Policy changes invalidate outstanding approvals. Authorization, expiry,
and policy revision are rechecked immediately before effect after preparation.

The catalog groups tools by source. Per-tool, per-source and filtered-catalog
checkboxes select an explicit snapshot of tools; Apply policy performs an atomic
admin update and rejects stale fingerprints. Selection never includes hidden,
newly discovered or subsequently changed tools. Bulk approval is not a wildcard.

The unlocked inbox refreshes automatically within roughly two seconds while the
tab is visible. Background-tab throttling may delay updates; focus refreshes it.
Polling does not rebuild the catalog or interrupt policy editing, and lock stops
polling, clears private approval content and prevents late responses restoring it.
Connection failures are visible, retries are bounded per request, and polling
never approves requests or retries invocations. Bulk inbox approval/denial uses
an explicit reviewed set of request IDs and is atomic, never future requests.

Acceptance: persistence/session independence, scope matching/expiry, default
migration, deny/ask/allow enforcement, pre-dispatch revocation, stale bulk rejection,
and browser tests for grouping/selection, live inbox arrivals and lock races.

Status: Implemented local v0 with caller policies, first-party packs and live approvals.

## First-party packs and approvals

- Bundled Notion, Cloudflare and Blender packs are independent of the old
  `opencode-*` checkouts. Registration is explicit, disabled by default, and
  grants remain required. No existing harness configuration is replaced.
- Migrated executors use Toolplane as the standalone approval owner, not a
  claim of inherited OpenCode permission approval. Old plugin paths are unchanged.
- Caller policy determines whether a granted call needs per-call approval. Legacy
  grants use the first-party exact-read exemptions; generic remote MCP legacy
  grants require approval. Upstream annotations never waive approval.
- Calls needing approval return a pending request without dispatch. An admin
  reviews caller, source, exact arguments, and contract fingerprint, then approves
  or denies. Approval alone does not execute: the same caller submits the same
  call with its approval ID. Approval is single-use and expires after five minutes.
- Approval binds to caller, source revision, tool fingerprint, and canonical JSON
  arguments. Grant revocation, disabling, catalog refresh and caller revocation
  invalidate old requests. Authorization and atomic consumption occur after
  connection setup, immediately before dispatch; failed/ambiguous writes never
  regain an approval. Concurrent replays cannot dispatch twice.
- Pending/approved requests temporarily store private arguments in SQLite for
  review. Terminal/expired requests remove those arguments; receipts still contain
  metadata only. Agents can inspect only their own approval status, not administer
  requests. Privileged admin agents can approve, as they can already grant access.
  Argument removal is logical, not forensic erasure of SQLite WAL/backups; protect
  the local state directory. Expiry is swept on approval reads/writes, not by a timer.
- Notion uses explicit MCPorter OAuth login in a human terminal and a dedicated
  config/cache identity; no copying existing tokens. Resources are restricted to
  `notion://docs/`. The read-only Markdown exporter calls the broker, not MCP directly.
- Cloudflare retains hosted search/execute CodeMode and explicit token-env auth.
  Legacy grants ask for every `execute`, regardless of claimed code effects;
  explicit admin-configured caller policies can authorize automatic execution.
- Blender retains focused inspections, Python, Poly Haven and Three.js export.
  Legacy grants exempt only the three inspections and Poly Haven `action=search`.
  This is trusted host execution, not a Python/filesystem/network sandbox.
- Sketch/Xcode and live provider validation remain follow-up work. Pack migration
  is not archive readiness until authenticated parity is verified by the operator.

Acceptance: offline tests cover approval argument/caller binding, expiry, denial,
single-use/concurrency, revocation during setup, restart persistence, and no effects
before approval. Browser tests cover exact-argument review and approve/deny. Pack
catalog/policy tests and synthetic transports require no live accounts or app writes.

## Purpose and ownership

Humans use a local operating UI to register and manage capabilities. Authorized
admin agents use the same HTTP management API. Caller agents use search and
invocation only. The registry does not contain an LLM or own an agent loop.

One Bun process owns SQLite registrations, catalog snapshots, callers, grants
and metadata-only invocation receipts. MCPorter owns upstream MCP clients.
The UI is a client, not a second registry. The stdio MCP facade is a client of
the same HTTP caller API and exposes only `search` and `call`.

Hono owns HTTP routing and middleware composition. `src/http.ts` composes global
loopback/Origin/security-header checks, static assets, error mapping and route
modules. `src/http/admin.ts` and `src/http/caller.ts` own their route tables;
`src/http/admin-auth.ts` owns browser-session routes and admin authentication.
Broker/store authorization remains outside the routing framework. This replaces
the prototype's nested path/method dispatcher without changing caller APIs.
Static UI assets are snapshotted at process startup alongside the API version;
source-file edits take effect after restart, not ahead of the running backend.

## Security and lifecycle

- HTTP binds to `127.0.0.1`. Browser requests with an external Origin or Host
  fail; there is no CORS allowance. Admin data uses bearer or browser-session
  authentication; caller APIs require bearer auth. Sign-out only revokes the
  presented session and is idempotent, including after expiry.
- A bootstrap admin token authorizes management, not tool invocation. Admin
  agents are deliberately privileged: they can register endpoints and grant
  capabilities. Give ordinary agents distinct caller tokens instead.
- Tokens are random; caller tokens are stored hashed and returned once on
  creation. The bootstrap token is in a mode-0600 local file or explicit env.
  The UI exchanges the bootstrap token for an HttpOnly seven-day session cookie;
  neither token is kept in URL/localStorage/sessionStorage. Session hashes bind
  to the admin key and origin, and are revoked on logout or admin-key rotation.
- Registrations start disabled. Catalog refresh is an explicit admin action and
  can contact the configured server even while invocation is disabled.
- Enabling a source grants no tools. Each caller needs explicit per-tool grants.
  Behavior annotations never authorize execution. Both reads and writes need
   grants; approval-required calls also need a single-use approval from the inbox.
- Grants bind to the tool's schema/metadata fingerprint. Catalog changes clear
  affected grants. Disabled, removed, revoked or changed tools cannot start new
  calls. Calls already dispatched may complete; disabling is not rollback.
- Demo, remote MCP HTTP and bundled pack sources are accepted. Generic HTTP is limited to
  loopback URLs; other endpoints require HTTPS. Endpoint userinfo, query strings
  and fragments are rejected. Optional bearer auth names an explicit environment
  variable; secret values never enter registration records or UI responses.
- Source registration is a trusted-admin action, not a general URL-fetch proxy.
  MCPorter handles transport. Do not expose this service to a network or use it
  as a hostile multi-tenant boundary.
- Inputs are validated against registered JSON Schema before dispatch. Validation
  uses the declared draft-07 or 2020-12 dialect (undeclared schemas use draft-07);
  unknown dialects and unresolved external references fail closed. Results
  retain structured values. Over-budget results fail explicitly rather than
  silently truncating. Calls are not retried automatically. A timeout or transport
  failure can mean an unknown external effect; inspect the target before retry.
- Refresh replaces the catalog atomically, preserves the previous snapshot on
  failure, and rejects a stale refresh if registration state changed during I/O.
- Receipts record tool/caller identity, timing and status, never arguments,
  upstream results, tokens or raw upstream error text. Receipts are not approvals.

## User operations

- UI: add a demo/MCP/pack source; refresh; inspect catalog and full schemas;
  enable/disable a source; create/revoke caller credentials; grant/revoke tools;
  search the admin catalog; review exact-argument approvals and recent receipts.
- Caller API: search only enabled, granted tools; discover full schema by exact
  qualified ID; invoke by exact ID and arguments. No mandatory search before call.
- CLI: init credentials; JSON admin/caller requests; search and invocation.
- MCP stdio: `search` (query or exact ID) and `call`; no admin surface.

`src/contracts.ts` owns exact input shapes. JSON errors contain a stable code and
bounded actionable message. There is no public deployment, OAuth UI, stdio upstream
process registration, automatic catalog polling, generated-code sandbox, semantic
retrieval, automatic skill installation or native harness integration in v0.

## Acceptance evidence

Tests exercise persistence, admin/caller separation, disabled-by-default sources,
explicit grants, schema-change invalidation, input validation, exact identities,
visibility filtering, revocation, stale refresh, timeout reporting, receipts and
the real HTTP caller path. A stdio MCP client exercises search/call end to end.
Playwright exercises registration, catalog refresh, enabling, caller creation and
granting through the browser. A local synthetic MCP server proves upstream
MCPorter discovery and structured invocation without live resources.

Verified 2026-10-23: `bun run check` passed; `bun test` passed 73 tests
(including HTTP → stdio MCP → MCPorter, approval lifecycle, pinned hosted-pack
fixtures, and synthetic Blender TCP dispatch); `bun run test:python` passed
10 tests (export conversion, broker transport and official-skill byte integrity).
`bun run test:ui` passed grouped/filtered policy updates, live inbox arrivals,
bulk decisions, replay rejection, pack registration, mobile overflow and late-response locking with no
JavaScript errors. Browser fixtures use an isolated
in-memory registry. These checks do not establish production security or
large-catalog retrieval quality.

Persistent-login tests cover reload/browser-profile restore and logout after
reload; HTTP tests cover session hashing, cookie attributes, expiry, service
restart, key rotation, CSRF and caller/admin separation through the Hono routes.

Operational follow-up 2026-10-17: chat-owned background process had exited;
`toolplane.service` now runs under the user systemd manager as a transient unit,
not boot-enabled. Hosted discovery succeeded with 67 Notion capabilities (including
the two documentation resource wrappers) and four Cloudflare tools; Blender has
six offline descriptors. Sources remain disabled and grants unchanged. This is
catalog/auth-path evidence, not domain-call parity. The discovered providers use
2020-12 schemas; one Notion schema is about 78 KiB. Validation preserves dialects
and permits up to 128 KiB per input schema, within the unchanged 1 MiB catalog cap.

## Tradeoffs and next steps

Standalone migrated packs use this broker's caller policies and approvals. Existing OpenCode
plugin instances retain their own permission boundaries; they are not registered
as bypass transports. Neither global configuration nor old repositories change.
One local admin role is sufficient for the prototype; team RBAC and short-lived
delegations need a separate design. SQLite receipts/approvals currently retain metadata
until an operator removes the local database; retention controls are future work.
BM25 is local and deterministic; multilingual recall remains an evaluation task.
