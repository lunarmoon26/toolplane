import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { canonicalJSON, Fault, fingerprint, hash, newToken, type Caller, type Descriptor, type Source, type SourceConfig, type Tool } from "./contracts"

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
  }
  sources() { return this.db.query<SourceRow, []>("SELECT * FROM sources ORDER BY name,id").all().map(sourceFrom) }
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
  grants() { return this.db.query<{ callerId: string; toolId: string }, []>("SELECT caller_id AS callerId,tool_id AS toolId FROM grants ORDER BY caller_id,tool_id").all() }
  grant(callerId: string, toolId: string, granted: boolean) {
    if (!this.callers().some(c => c.id === callerId && !c.revoked)) throw new Fault("not_found", "Active caller not found", 404)
    const tool = this.tools().find(t => t.id === toolId)
    if (!tool) throw new Fault("not_found", "Tool not found", 404)
    if (granted) this.db.query("INSERT OR REPLACE INTO grants VALUES(?,?,?)").run(callerId, toolId, tool.fingerprint)
    else {
      this.db.transaction(() => {
        this.db.query("DELETE FROM grants WHERE caller_id=? AND tool_id=?").run(callerId, toolId)
        this.db.query("UPDATE approvals SET status='invalidated',arguments=NULL WHERE caller_id=? AND tool_id=? AND status IN ('pending','approved')").run(callerId, toolId)
      })()
    }
  }
  visible(callerId: string) {
    return this.db.query<ToolRow, [string]>(`SELECT t.* FROM tools t JOIN sources s ON s.id=t.source_id
      JOIN grants g ON g.tool_id=t.id AND g.fingerprint=t.fingerprint
      JOIN callers c ON c.id=g.caller_id WHERE c.id=? AND c.revoked=0 AND s.enabled=1 ORDER BY t.id`).all(callerId).map(toolFrom)
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
