import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { accessPolicy, canonicalJSON, Fault, fingerprint, hash, newToken, type AccessPolicy, type Caller, type Descriptor, type Source, type SourceConfig, type Tool } from "./contracts"
import { requiresApproval } from "./policy"

type SourceRow = { id: string; name: string; config: string; enabled: number; revision: number; refreshed_at: string | null }
type ToolRow = { id: string; source_id: string; descriptor: string; fingerprint: string }
type CallerRow = { id: string; name: string; revoked: number }
type ApprovalRow = { id: string; caller_id: string; tool_id: string; source_id: string; revision: number; fingerprint: string; args_hash: string; arguments: string | null; status: string; expires_at: number; created_at: number }
const sourceFrom = (row: SourceRow): Source => ({ id: row.id, name: row.name, config: JSON.parse(row.config), enabled: !!row.enabled, revision: row.revision, refreshedAt: row.refreshed_at })
const toolFrom = (row: ToolRow): Tool => ({ ...JSON.parse(row.descriptor), id: row.id, sourceId: row.source_id, fingerprint: row.fingerprint })
const callerFrom = (row: CallerRow): Caller => ({ id: row.id, name: row.name, revoked: !!row.revoked })

export class Store {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true })
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, refreshed_at TEXT);
      CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), descriptor TEXT NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS callers(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS grants(caller_id TEXT NOT NULL REFERENCES callers(id), tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, PRIMARY KEY(caller_id,tool_id));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, caller_id TEXT NOT NULL, tool_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, code TEXT);
      CREATE INDEX IF NOT EXISTS receipts_started ON receipts(started_at DESC);`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, caller_id TEXT NOT NULL,
      tool_id TEXT NOT NULL, source_id TEXT NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      args_hash TEXT NOT NULL, arguments TEXT, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,
      admin_hash TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL);`)
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(grants)").all().map(column => column.name)
    this.db.transaction(() => {
      if (!columns.includes("policy")) this.db.exec("ALTER TABLE grants ADD COLUMN policy TEXT NOT NULL DEFAULT '{\"mode\":\"legacy\"}'")
      if (!columns.includes("revision")) this.db.exec("ALTER TABLE grants ADD COLUMN revision TEXT NOT NULL DEFAULT 'legacy'")
    })()
  }
  sources() { return this.db.query<SourceRow, []>("SELECT * FROM sources ORDER BY name,id").all().map(sourceFrom) }
  pruneAdminSessions(adminHash: string) {
    this.db.query("DELETE FROM admin_sessions WHERE expires_at<=? OR admin_hash<>?").run(Date.now(), adminHash)
  }
  createAdminSession(adminHash: string, origin: string) {
    this.pruneAdminSessions(adminHash)
    const count = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM admin_sessions").get()!.n
    if (count >= 100) throw new Fault("session_limit", "Too many active browser sessions; revoke a session or wait for expiry", 429)
    const token = newToken(), expiresAt = Date.now() + 7 * 86_400_000
    this.db.query("INSERT INTO admin_sessions VALUES(?,?,?,?)").run(hash(token), adminHash, origin, expiresAt)
    return { token, expiresAt }
  }
  adminSession(token: string, adminHash: string, origin: string) {
    const session = this.db.query<{ expires_at: number }, [string, string, string, number]>("SELECT expires_at FROM admin_sessions WHERE token_hash=? AND admin_hash=? AND origin=? AND expires_at>?").get(hash(token), adminHash, origin, Date.now())
    if (!session) throw new Fault("session_expired", "Browser session expired or was revoked; sign in again", 401)
    return { expiresAt: session.expires_at }
  }
  revokeAdminSession(token: string) { this.db.query("DELETE FROM admin_sessions WHERE token_hash=?").run(hash(token)) }
  source(id: string) {
    const row = this.db.query<SourceRow, [string]>("SELECT * FROM sources WHERE id=?").get(id)
    if (!row) throw new Fault("not_found", "Source not found", 404)
    return sourceFrom(row)
  }
  addSource(name: string, config: SourceConfig) {
    const id = randomUUID()
    this.db.query("INSERT INTO sources(id,name,config) VALUES(?,?,?)").run(id, name, JSON.stringify(config))
    return this.source(id)
  }
  setEnabled(id: string, enabled: boolean) {
    this.source(id)
    this.db.query("UPDATE sources SET enabled=?,revision=revision+1 WHERE id=?").run(Number(enabled), id)
    this.invalidateApprovals("source_id", id)
    return this.source(id)
  }
  tools() { return this.db.query<ToolRow, []>("SELECT * FROM tools ORDER BY id").all().map(toolFrom) }
  replaceCatalog(source: Source, descriptors: Descriptor[]) {
    return this.db.transaction(() => {
      if (this.source(source.id).revision !== source.revision) throw new Fault("stale_refresh", "Registration changed during refresh; refresh again", 409)
      const nextIds = new Set(descriptors.map(tool => `${source.id}::${tool.name}`))
      for (const tool of this.tools().filter(t => t.sourceId === source.id)) {
        if (!nextIds.has(tool.id)) this.db.query("DELETE FROM tools WHERE id=?").run(tool.id)
      }
      for (const descriptor of descriptors) {
        const id = `${source.id}::${descriptor.name}`
        const digest = fingerprint(descriptor)
        this.db.query("DELETE FROM grants WHERE tool_id=? AND fingerprint<>?").run(id, digest)
        this.db.query("INSERT INTO tools VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET descriptor=excluded.descriptor,fingerprint=excluded.fingerprint").run(id, source.id, JSON.stringify(descriptor), digest)
      }
      this.db.query("UPDATE sources SET refreshed_at=?,revision=revision+1 WHERE id=?").run(new Date().toISOString(), source.id)
      this.invalidateApprovals("source_id", source.id)
      return this.tools().filter(t => t.sourceId === source.id)
    })()
  }
  callers() { return this.db.query<CallerRow, []>("SELECT id,name,revoked FROM callers ORDER BY name,id").all().map(callerFrom) }
  createCaller(name: string) {
    const id = randomUUID(), token = newToken()
    this.db.query("INSERT INTO callers(id,name,token_hash) VALUES(?,?,?)").run(id, name, hash(token))
    return { id, name, revoked: false, token }
  }
  authenticate(token: string) {
    const row = this.db.query<CallerRow, [string]>("SELECT id,name,revoked FROM callers WHERE token_hash=? AND revoked=0").get(hash(token))
    if (!row) throw new Fault("unauthorized", "A valid caller credential is required", 401)
    return callerFrom(row)
  }
  revoke(id: string) {
    if (!this.callers().some(c => c.id === id)) throw new Fault("not_found", "Caller not found", 404)
    this.db.transaction(() => {
      this.db.query("UPDATE callers SET revoked=1 WHERE id=?").run(id)
      this.db.query("DELETE FROM grants WHERE caller_id=?").run(id)
      this.invalidateApprovals("caller_id", id)
    })()
  }
  grants() {
    return this.db.query<{ callerId: string; toolId: string; policy: string; revision: string }, []>("SELECT caller_id AS callerId,tool_id AS toolId,policy,revision FROM grants ORDER BY caller_id,tool_id").all().map(row => ({ ...row, policy: JSON.parse(row.policy) as AccessPolicy | { mode: "legacy" } }))
  }
  grant(callerId: string, toolId: string, granted: boolean) {
    if (!this.callers().some(c => c.id === callerId && !c.revoked)) throw new Fault("not_found", "Active caller not found", 404)
    const tool = this.tools().find(t => t.id === toolId)
    if (!tool) throw new Fault("not_found", "Tool not found", 404)
    if (granted) {
      // Compatibility route never resets an existing explicit policy.
      this.db.query("INSERT OR IGNORE INTO grants(caller_id,tool_id,fingerprint) VALUES(?,?,?)").run(callerId, toolId, tool.fingerprint)
    }
    else {
      this.db.transaction(() => {
        this.db.query("DELETE FROM grants WHERE caller_id=? AND tool_id=?").run(callerId, toolId)
        this.db.query("UPDATE approvals SET status='invalidated',arguments=NULL WHERE caller_id=? AND tool_id=? AND status IN ('pending','approved')").run(callerId, toolId)
      })()
    }
  }
  setPolicies(callerId: string, tools: { id: string; fingerprint: string }[], input: AccessPolicy) {
    const policy = accessPolicy.parse(input)
    if (policy.mode === "scope" && (policy.expiresAt <= Date.now() || policy.expiresAt > Date.now() + 30 * 86_400_000 || Buffer.byteLength(canonicalJSON(policy.equals)) > 16 * 1024)) throw new Fault("invalid_scope", "Scope requires a future expiry within 30 days and at most 16 KiB of constraints", 422)
    if (!tools.length || tools.length > 500 || new Set(tools.map(t => t.id)).size !== tools.length) throw new Fault("invalid_selection", "Select 1–500 distinct tool contracts", 422)
    return this.db.transaction(() => {
      if (!this.callers().some(c => c.id === callerId && !c.revoked)) throw new Fault("not_found", "Active caller not found", 404)
      const catalog = this.tools()
      for (const selected of tools) {
        const tool = catalog.find(t => t.id === selected.id)
        if (!tool || tool.fingerprint !== selected.fingerprint) throw new Fault("stale_selection", "Selected tool changed or disappeared; review the catalog again", 409)
        if (policy.mode === "scope" && !Object.keys(policy.equals).every(key => Object.hasOwn((tool.inputSchema.properties ?? {}) as object, key))) throw new Fault("invalid_scope", "Scope fields must be declared top-level arguments of every selected tool", 422)
      }
      for (const tool of tools) {
        this.db.query("INSERT INTO grants(caller_id,tool_id,fingerprint,policy,revision) VALUES(?,?,?,?,?) ON CONFLICT(caller_id,tool_id) DO UPDATE SET fingerprint=excluded.fingerprint,policy=excluded.policy,revision=excluded.revision").run(callerId, tool.id, tool.fingerprint, canonicalJSON(policy), randomUUID())
        this.db.query("UPDATE approvals SET status='invalidated',arguments=NULL WHERE caller_id=? AND tool_id=? AND status IN ('pending','approved')").run(callerId, tool.id)
      }
      return { updated: tools.length }
    })()
  }
  executionPolicy(callerId: string, tool: Tool, args: Record<string, unknown>) {
    const row = this.db.query<{ policy: string; revision: string }, [string, string, string]>("SELECT policy,revision FROM grants WHERE caller_id=? AND tool_id=? AND fingerprint=?").get(callerId, tool.id, tool.fingerprint)
    if (!row) throw new Fault("not_available", "Tool is not granted", 403)
    const policy = JSON.parse(row.policy) as AccessPolicy | { mode: "legacy" }
    if (policy.mode === "deny") throw new Fault("not_available", "Tool is denied to this caller", 403)
    let ask = true
    if (policy.mode === "legacy") ask = requiresApproval(this.source(tool.sourceId).config, tool.name, args)
    else if (policy.mode === "allow") ask = false
    else if (policy.mode === "scope") ask = policy.expiresAt <= Date.now() || !Object.entries(policy.equals).every(([key, value]) => Object.hasOwn(args, key) && canonicalJSON(args[key]) === canonicalJSON(value))
    return { ask, revision: row.revision, policy }
  }
  visible(callerId: string) {
    return this.db.query<ToolRow, [string]>(`SELECT t.* FROM tools t JOIN sources s ON s.id=t.source_id
      JOIN grants g ON g.tool_id=t.id AND g.fingerprint=t.fingerprint
       JOIN callers c ON c.id=g.caller_id WHERE c.id=? AND c.revoked=0 AND s.enabled=1 AND json_extract(g.policy,'$.mode')<>'deny' ORDER BY t.id`).all(callerId).map(toolFrom)
  }
  authorized(callerId: string, id: string) {
    const tool = this.visible(callerId).find(t => t.id === id)
    if (!tool) throw new Fault("not_available", "Tool is unavailable or not granted to this caller", 403)
    return tool
  }
  private expireApprovals() {
    this.db.query("UPDATE approvals SET status='expired',arguments=NULL WHERE expires_at<=? AND status IN ('pending','approved')").run(Date.now())
  }
  private invalidateApprovals(column: "source_id" | "caller_id", id: string) {
    this.db.query(`UPDATE approvals SET status='invalidated',arguments=NULL WHERE ${column}=? AND status IN ('pending','approved')`).run(id)
  }
  approvals() {
    this.expireApprovals()
    return this.db.query<ApprovalRow, []>("SELECT * FROM approvals ORDER BY CASE WHEN status IN ('pending','approved') THEN 0 ELSE 1 END,created_at DESC,id LIMIT 100").all().map(row => ({ ...row, arguments: row.arguments ? JSON.parse(row.arguments) as Record<string, unknown> : null }))
  }
  approval(id: string, callerId?: string) {
    this.expireApprovals()
    const row = this.db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id=?").get(id)
    if (!row || (callerId && row.caller_id !== callerId)) throw new Fault("approval_not_found", "Approval not found", 404)
    return row
  }
  requestApproval(callerId: string, tool: Tool, args: Record<string, unknown>) {
    this.expireApprovals()
    const source = this.source(tool.sourceId), payload = canonicalJSON(args), digest = hash(payload)
    const existing = this.db.query<ApprovalRow, [string, string, string, number, string]>("SELECT * FROM approvals WHERE caller_id=? AND tool_id=? AND args_hash=? AND revision=? AND fingerprint=? AND status IN ('pending','approved')").get(callerId, tool.id, digest, source.revision, tool.fingerprint)
    if (existing) return this.approvalStatus(existing)
    const count = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM approvals WHERE status IN ('pending','approved')").get()!.count
    if (count >= 100) throw new Fault("approval_queue_full", "Review pending requests before submitting more", 429)
    const id = randomUUID(), now = Date.now()
    this.db.query("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, callerId, tool.id, source.id, source.revision, tool.fingerprint, digest, payload, "pending", now + 300_000, now)
    return this.approvalStatus(this.approval(id))
  }
  approvalStatus(row: ApprovalRow) { return { approvalId: row.id, status: row.status, toolId: row.tool_id, expiresAt: row.expires_at } }
  decideApproval(id: string, decision: "approved" | "denied") {
    const row = this.approval(id)
    if (row.status !== "pending") throw new Fault("approval_not_pending", "Approval is no longer pending", 409)
    this.assertApprovalBinding(row, row.caller_id, row.tool_id, row.args_hash)
    this.db.query("UPDATE approvals SET status=?,arguments=CASE WHEN ?='denied' THEN NULL ELSE arguments END WHERE id=? AND status='pending'").run(decision, decision, id)
    return this.approvalStatus(this.approval(id))
  }
  decideApprovals(ids: string[], decision: "approved" | "denied") {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Fault("invalid_selection", "Select distinct pending requests", 422)
    return this.db.transaction(() => ids.map(id => this.decideApproval(id, decision)))()
  }
  private assertApprovalBinding(row: ApprovalRow, callerId: string, toolId: string, argsHash: string) {
    const tool = this.authorized(callerId, toolId)
    if (row.caller_id !== callerId || row.tool_id !== toolId || row.args_hash !== argsHash || row.fingerprint !== tool.fingerprint || row.revision !== this.source(tool.sourceId).revision) throw new Fault("approval_mismatch", "Approval does not match the current caller, tool, source revision or arguments", 403)
  }
  checkApproval(id: string, callerId: string, toolId: string, args: Record<string, unknown>, consume = false) {
    return this.db.transaction(() => {
      const row = this.approval(id, callerId)
      if (row.status !== "approved") throw new Fault("approval_unavailable", `Approval is ${row.status}; no call dispatched`, 409)
      this.assertApprovalBinding(row, callerId, toolId, hash(canonicalJSON(args)))
      if (consume) this.db.query("UPDATE approvals SET status='consumed',arguments=NULL WHERE id=? AND status='approved'").run(id)
    })()
  }
  receipt(callerId: string, toolId: string, status: string, started: number, code: string | null) {
    const id = randomUUID()
    this.db.query("INSERT INTO receipts VALUES(?,?,?,?,?,?,?)").run(id, callerId, toolId, status, new Date(started).toISOString(), Date.now() - started, code)
    return id
  }
  receipts() { return this.db.query("SELECT * FROM receipts ORDER BY started_at DESC,id LIMIT 100").all() }
  close() { this.db.close() }
}
