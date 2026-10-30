import { descriptorInput, Fault, MAX_CATALOG_BYTES, MAX_RESULT_BYTES, MAX_SCHEMA_BYTES, type Descriptor } from "./contracts"
import { SearchIndex } from "./search"
import { Store } from "./store"
import type { Upstream } from "./upstream"
import { compileInputSchema } from "./schema"
import type { SearchRanking } from "./rerank"

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null")

export class Broker {
  private refreshing = new Set<string>()
  private active = new Map<string, number>()
  private indices = new Map<string, { key: string; index: SearchIndex }>()
  constructor(readonly store: Store, private upstream: Upstream, private timeoutMs = 30_000, private ranking?: SearchRanking) {}
  async refresh(id: string) {
    if (this.refreshing.has(id)) throw new Fault("refresh_busy", "Refresh already in progress", 409)
    const source = this.store.source(id)
    this.refreshing.add(id)
    try {
      const raw = await this.deadline(this.upstream.list(source))
      if (raw.length > 500 || bytes(raw) > MAX_CATALOG_BYTES) throw new Fault("catalog_too_large", "Catalog exceeds 500 tools or 1 MiB", 422)
      const descriptors: Descriptor[] = raw.map(value => descriptorInput.parse(value))
      if (new Set(descriptors.map(t => t.name)).size !== descriptors.length) throw new Fault("duplicate_tool", "Upstream catalog contains duplicate names", 422)
      for (const tool of descriptors) {
        if (tool.inputSchema.type !== "object" || bytes(tool.inputSchema) > MAX_SCHEMA_BYTES) throw new Fault("unsupported_schema", "Input schema must be an object schema of at most 128 KiB", 422)
        compileInputSchema(tool.inputSchema)
      }
      return this.store.replaceCatalog(source, descriptors)
    } catch (error) {
      if (error instanceof Fault) throw error
      throw new Fault("refresh_failed", "Catalog refresh failed; check upstream connectivity, authentication and supported schemas. Previous catalog is unchanged.", 502)
    } finally { this.refreshing.delete(id) }
  }
  search(callerId: string, input: { query?: string; id?: string; limit: number }) {
    const tools = this.store.visible(callerId)
    if (input.id) {
      const tool = tools.find(t => t.id === input.id)
      if (!tool) throw new Fault("not_available", "Tool is unavailable or not granted to this caller", 403)
      const grant = this.store.grants().find(g => g.callerId === callerId && g.toolId === tool.id)!
      return { tool, approvalPolicy: grant.policy }
    }
    const key = tools.map(t => `${t.id}:${t.fingerprint}`).join("|")
    let cached = this.indices.get(callerId)
    if (!cached || cached.key !== key) {
      cached = { key, index: new SearchIndex(tools) }
      this.indices.set(callerId, cached)
    }
    return { candidates: cached.index.search(input.query!, input.limit).map(({ id, name, description, fingerprint }) => ({ id, name, description: description.slice(0, 400), fingerprint })), schemaHint: "Use search with exact id to retrieve the full input schema." }
  }
  async searchRanked(callerId: string, input: { query?: string; id?: string; limit: number }, signal?: AbortSignal) {
    const checkCancelled = () => { if (signal?.aborted) throw new Fault("search_cancelled", "Search cancelled; no tools invoked", 499) }
    checkCancelled()
    if (!this.ranking || input.id) return this.search(callerId, input)
    const snapshot = this.store.visible(callerId).map(t => `${t.id}:${t.fingerprint}`).join("|")
    const pool = this.search(callerId, { ...input, limit: Math.max(input.limit, this.ranking.poolSize) })
    if (!pool.candidates) return pool
    if (pool.candidates.length < 2 || pool.candidates.some(c => c.id === input.query?.trim())) return this.search(callerId, input)
    const result = await this.ranking.rank(input.query!, pool.candidates, signal)
    checkCancelled()
    if (!this.store.callers().some(c => c.id === callerId && !c.revoked)) throw new Fault("not_available", "Caller was revoked during search", 403)
    const current = this.store.visible(callerId).map(t => `${t.id}:${t.fingerprint}`).join("|")
    if (snapshot !== current) return { ...this.search(callerId, input), ranking: { status: "fallback", reason: "catalog_changed" } }
    const byId = new Map(pool.candidates.map(card => [card.id, card]))
    return { candidates: result.ids.slice(0, input.limit).map(id => byId.get(id)!), schemaHint: pool.schemaHint,
      ranking: { status: result.status, ...(result.reason ? { reason: result.reason } : {}) } }
  }
  async call(callerId: string, id: string, args: Record<string, unknown>, signal?: AbortSignal, approvalId?: string) {
    // Pin the values reviewed and executed even for in-process callers.
    args = JSON.parse(JSON.stringify(args))
    const started = Date.now()
    let dispatched = false
    let expired = false
    try {
      signal?.throwIfAborted()
      let tool = this.store.authorized(callerId, id)
      const validate = compileInputSchema(tool.inputSchema)
      if (!validate(args)) throw new Fault("invalid_arguments", `Arguments do not match inputSchema (${validate.errors?.[0]?.keyword ?? "schema"}); retrieve the full schema with search.id`, 422)
      const policy = this.store.executionPolicy(callerId, tool, args)
      const approvalRequired = policy.ask
      if (approvalRequired) {
        if (!approvalId) return { approval: this.store.requestApproval(callerId, tool, args) }
        this.store.checkApproval(approvalId, callerId, id, args)
      } else if (approvalId) throw new Fault("approval_not_required", "Do not attach approvals to exempt calls")
      if ((this.active.get(tool.sourceId) ?? 0) >= 4 || [...this.active.values()].reduce((a, b) => a + b, 0) >= 16) throw new Fault("busy", "Invocation concurrency limit reached; no call was dispatched", 429)
      // No awaited work between live authorization and handing off the operation.
      tool = this.store.authorized(callerId, id)
      signal?.throwIfAborted()
      const source = this.store.source(tool.sourceId)
      this.active.set(source.id, (this.active.get(source.id) ?? 0) + 1)
      const admit = () => {
        // Adapters recheck after awaited connection preparation, before dispatch.
        if (expired) throw new Fault("timeout", "Invocation expired before dispatch", 504)
        const current = this.store.authorized(callerId, id)
        if (current.fingerprint !== tool.fingerprint) throw new Fault("not_available", "Tool changed before dispatch", 403)
        signal?.throwIfAborted()
        if (approvalRequired) this.store.checkApproval(approvalId!, callerId, id, args)
        const currentPolicy = this.store.executionPolicy(callerId, current, args)
        if (currentPolicy.revision !== policy.revision || currentPolicy.ask !== policy.ask) throw new Fault("policy_changed", "Caller policy changed or scope expired before dispatch; no call dispatched", 409)
        if (approvalRequired) this.store.checkApproval(approvalId!, callerId, id, args, true)
        dispatched = true
      }
      const operation = Promise.resolve().then(() => {
        return this.upstream.call(this.store.source(source.id), tool.name, args, admit)
      }).finally(() => this.active.set(source.id, Math.max(0, (this.active.get(source.id) ?? 1) - 1)))
      const result = await this.deadline(operation, () => { expired = true })
      if (bytes(result) > MAX_RESULT_BYTES) throw new Fault("result_too_large", "Operation completed but its result exceeds 128 KiB. Inspect the target; do not repeat a write just to retrieve output.", 422)
      const isError = typeof result === "object" && result !== null && "isError" in result && result.isError === true
      const receiptId = this.store.receipt(callerId, id, isError ? "upstream_error" : "succeeded", started, isError ? "upstream_error" : null)
      return { receiptId, result }
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault("effect_unknown", "Invocation failed or was interrupted; the external effect may be unknown. Inspect the target before retrying.", 502)
      const status = !dispatched ? "rejected" : fault.code === "result_too_large" ? "completed_output_unavailable" : "effect_unknown"
      this.store.receipt(callerId, id, status, started, fault.code)
      throw fault
    }
  }
  private async deadline<T>(operation: Promise<T>, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Fault("timeout", "Deadline exceeded; an in-flight operation may still complete. Inspect the target before retrying.", 504)) }, this.timeoutMs) })])
    } finally { clearTimeout(timer) }
  }
  async close() { await this.upstream.close() }
}
