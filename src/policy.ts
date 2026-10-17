import type { SourceConfig } from "./contracts"

// Deliberate first-party allowlists, not upstream hints or code inspection.
const notionReads = new Set([
  "notion-search", "notion-ai-search", "notion-fetch", "notion-get-self",
  "notion-get-tool-access", "notion-get-users", "notion-get-teams",
  "notion-get-comments", "notion-get-async-task", "notion-query-data-sources",
  "notion-query-multiple-data-sources", "notion-query-meeting-notes",
  "notion-list-private-pages", "notion-list-shared-pages", "notion-list-favorite-pages",
  "notion-list-recent-pages", "notion-list-page-backlinks", "notion-get-enabled-skills",
  "notion-download-skill", "notion-get-file-download-urls", "notion-download-attachment",
  "resources", "resource",
])
export function requiresApproval(config: SourceConfig, name: string, args: Record<string, unknown>) {
  if (config.kind === "demo") return false
  if (config.kind !== "pack") return true
  if (config.pack === "notion") return !notionReads.has(name)
  if (config.pack === "cloudflare") return !new Set(["docs", "search"]).has(name)
  return !new Set(["blender_status", "blender_scene_info", "blender_object_info"]).has(name) && !(name === "polyhaven" && args.action === "search")
}
