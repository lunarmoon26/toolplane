# Toolplane v0 contract

Status: Implemented local v0 with first-party packs and per-call approvals.

## First-party packs and approvals

- Bundled Notion, Cloudflare and Blender packs are independent of the old
  `opencode-*` checkouts. Registration is explicit, disabled by default, and
  grants remain required. No existing harness configuration is replaced.
- Migrated executors use Toolplane as the standalone approval owner, not a
  claim of inherited OpenCode permission approval. Old plugin paths are unchanged.
- Every non-demo call requires per-call approval unless a first-party policy
  explicitly allows its exact read operation. Generic remote MCP tools default
  to approval-required; upstream annotations never waive approval.
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
  Every `execute` call needs approval, even if its generated code looks read-only.
- Blender retains focused inspections, Python, Poly Haven and Three.js export.
  Only the three inspections and Poly Haven `action=search` waive approval.
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

## Security and lifecycle

- HTTP binds to `127.0.0.1`. Browser requests with an external Origin or Host
  fail; there is no CORS allowance. All APIs except health require bearer auth.
- A bootstrap admin token authorizes management, not tool invocation. Admin
  agents are deliberately privileged: they can register endpoints and grant
  capabilities. Give ordinary agents distinct caller tokens instead.
- Tokens are random; caller tokens are stored hashed and returned once on
  creation. The bootstrap token is in a mode-0600 local file or explicit env.
  The UI keeps tokens in memory only, never URL/localStorage.
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

Verified 2026-10-17: `bun run check` passed; `bun test` passed 54 tests
(including HTTP → stdio MCP → MCPorter, approval lifecycle, pinned hosted-pack
fixtures, and synthetic Blender TCP dispatch); `bun run test:python` passed
10 tests (export conversion, broker transport and official-skill byte integrity).
`bun run test:ui` passed exact-argument approve/deny, replay rejection, pack
registration, invocation activity, mobile overflow and console locking with no
JavaScript errors. Browser fixtures use an isolated
in-memory registry. These checks do not establish production security or
large-catalog retrieval quality.

Operational follow-up 2026-10-17: chat-owned background process had exited;
`toolplane.service` now runs under the user systemd manager as a transient unit,
not boot-enabled. Hosted discovery succeeded with 67 Notion capabilities (including
the two documentation resource wrappers) and four Cloudflare tools; Blender has
six offline descriptors. Sources remain disabled and grants unchanged. This is
catalog/auth-path evidence, not domain-call parity. The discovered providers use
2020-12 schemas; one Notion schema is about 78 KiB. Validation preserves dialects
and permits up to 128 KiB per input schema, within the unchanged 1 MiB catalog cap.

## Tradeoffs and next steps

Standalone migrated packs use this broker's per-call approvals. Existing OpenCode
plugin instances retain their own permission boundaries; they are not registered
as bypass transports. Neither global configuration nor old repositories change.
One local admin role is sufficient for the prototype; team RBAC and short-lived
delegations need a separate design. SQLite receipts/approvals currently retain metadata
until an operator removes the local database; retention controls are future work.
BM25 is local and deterministic; multilingual recall remains an evaluation task.
