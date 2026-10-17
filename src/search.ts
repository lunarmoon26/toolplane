import type { Tool } from "./contracts"

const stop = new Set(["a", "an", "the", "is", "of", "for", "to", "in", "and", "my", "how"])
const terms = (text: string) => (text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => !stop.has(t))

// Corpus statistics are scoped to an already-authorized catalog.
export class SearchIndex {
  private postings = new Map<string, Map<string, number>>()
  private lengths = new Map<string, number>()
  private average = 1
  constructor(private tools: Tool[]) {
    for (const tool of tools) {
      const tokens = terms(`${tool.name} ${tool.description}`)
      this.lengths.set(tool.id, tokens.length)
      for (const term of tokens) {
        const posting = this.postings.get(term) ?? new Map<string, number>()
        posting.set(tool.id, (posting.get(tool.id) ?? 0) + 1)
        this.postings.set(term, posting)
      }
    }
    this.average = [...this.lengths.values()].reduce((a, b) => a + b, 0) / Math.max(1, tools.length) || 1
  }
  search(query: string, limit: number) {
    const exact = this.tools.find(tool => tool.id === query.trim())
    if (exact) return [exact]
    const scores = new Map<string, number>()
    for (const term of new Set(terms(query))) {
      const posting = this.postings.get(term)
      if (!posting) continue
      const idf = Math.log(1 + (this.tools.length - posting.size + 0.5) / (posting.size + 0.5))
      for (const [id, count] of posting) {
        const norm = 1.2 * (0.25 + 0.75 * this.lengths.get(id)! / this.average)
        scores.set(id, (scores.get(id) ?? 0) + idf * count * 2.2 / (count + norm))
      }
    }
    const byId = new Map(this.tools.map(tool => [tool.id, tool]))
    return [...scores].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, limit).map(([id]) => byId.get(id)!)
  }
}
