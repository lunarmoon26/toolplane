# Toolplane

Bun + TypeScript; local-first capability registry and invocation broker.

- `docs/contract.md` owns v0 behavior and security boundaries.
- `src/contracts.ts` owns API validation; SQLite schema is in `src/store.ts`.
- UI and admin agents use the same `/api/admin` API; caller credentials never
  administer registrations or grant themselves capabilities.
- No live server registration, credential import, or global harness edits as tests.
- `bun run check` and `bun test`; UI smoke test: `tests/ui_smoke.py` (Playwright).
- Preserve structured MCP results. Never infer authorization from read-only hints.
- New/changed schemas require new grants. Recheck grants at the point of effect.
- No general-purpose generated-code sandbox, native OpenCode permission bypasses,
  ambient credential forwarding, or automatic retry of ambiguous invocations.
- Standalone Blender Python/Cloudflare CodeMode are explicit domain executors:
  grants plus single-use exact-argument approval are required. Old plugin instances
  retain native permissions; migrated packs own standalone Toolplane approvals.
- `skills/toolplane-integrations/SKILL.md` adapts domain workflow names; four official Notion skill trees
  stay byte-identical. Keep provenance and licenses with imported modules.
