# First-party migration provenance

Imported locally 2026-10-17. Runtime modules never import the old checkouts.
Those repositories are unchanged; none has been archived.

| Pack | Source repository / baseline | Imported content |
| --- | --- | --- |
| Blender | https://github.com/lunarmoon26/opencode-blender · `fb62028b8d26ab031e2b2e227aa4d26f7c48aa97` | Framework-neutral executor modules, 16 domain skills, MIT license |
| Cloudflare | https://github.com/lunarmoon26/opencode-cloudflare · `834a6ba2ee8a732294c25513b568f41cc7c1b8f7` | Domain skill and MIT license; transport/policy reimplemented locally |
| Notion | https://github.com/lunarmoon26/opencode-notion · `c44c83dd888e895f5de5f11a43e00be0f583a6ab` | Seven skills and Markdown exporter; transport/policy reimplemented locally |

Notion has no root LICENSE at import. Its four official workflow directories
remain byte-identical to the source copies, including supporting files. Their
upstream source/terms are recorded in [notion/skills/UPSTREAM.md](notion/skills/UPSTREAM.md).
No license grant is invented for those files; review terms before publication.
First-party adapter skills are adapted to Toolplane. Blender's remaining workflow
examples use symbolic native names translated by [the adapter](../skills/toolplane-integrations/SKILL.md); no native
OpenCode runtime dependency is retained.

## Boundaries and archive readiness

- Local migration tests use fixtures, not live Notion/Cloudflare data or Blender
  scenes. Subsequent operational discovery loaded both hosted catalogs; resource
  reads and actual domain workflows still need operator verification before the
  old projects are safe to retire.
- No credential vaults, `.local` files, OAuth logs, exports, `.env` files or Git
  history were copied into these packs. The source histories remain in place.
- The standalone approval owner is Toolplane. It is not a proxy into old native
  permission APIs and does not assert inherited session approval.
- Skill extraction automation and Sketch/Xcode adapters are not migrated yet.

Byte-identity checks for the four official Notion trees use SHA-256 of sorted
relative filename bytes + NUL + file bytes + NUL. Expected tree hashes:

```
notion-knowledge-capture caec7b33b83a133b19ad16b5d297e118ecdd5a9ecf4c484add18cbc18a694f1e
notion-meeting-intelligence 817f775ba2b707a76e9a7b862cd1c01fc78a340a06864c3c8c7b2c8d7eff4f7e
notion-research-documentation 1eea4234bd9de7ecd836bca3a01c9aeb0e929f02571ff323a5964c490fe55ffb
notion-spec-to-implementation 721905e116db44e5a5475993513fbed5ea4f0bb63fa181f1eb13fe090d182f70
```
