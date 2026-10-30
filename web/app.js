const $ = id => document.getElementById(id)
let token = ""
let connected = false
let state = { sources: [], tools: [], callers: [], grants: [], receipts: [] }
let busy = false
let epoch = 0, inboxVersion = 0, inboxTimer, inboxLoading = false
const selectedTools = new Map(), selectedApprovals = new Set()
const policyLabel = mode => ({ allow: "Allow from caller", scope: "Allow within scope", ask: "Always ask", deny: "Deny", legacy: "Legacy · reads allowed / writes ask" }[mode] ?? "Not granted")
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node }
const notify = (message, error = false) => { $("notice").textContent = message; $("notice").className = error ? "error" : "" }
async function api(path, method = "GET", body) {
  const current = epoch
  const response = await fetch(`/api/admin/${path}`, { method, credentials: "same-origin", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === "inbox" ? 10000 : 40000), keepalive: path === "session" && method === "DELETE" })
  const result = await response.json()
  if (current !== epoch) throw new Error("Console session changed; late response discarded.")
  if (!response.ok) {
    if (response.status === 401 && connected) {
      lockLocal(); notify("Browser session expired or was revoked. Sign in again.", true)
    }
    const error = new Error(`${result.error.code}: ${result.error.message}`)
    error.status = response.status
    throw error
  }
  return result
}
async function action(fn) {
  if (busy) return
  busy = true
  inboxVersion++
  document.body.setAttribute("aria-busy", "true")
  try { await fn() } catch (error) { notify(error.message, true) }
  finally { busy = false; document.body.removeAttribute("aria-busy") }
}
function button(label, fn, kind = "secondary") {
  const node = text("button", label, kind)
  node.type = "button"
  node.addEventListener("click", () => action(fn))
  return node
}
async function reload() {
  inboxVersion++
  const current = epoch, result = await api("state")
  if (!connected || current !== epoch) return
  state = result; render()
}
async function syncInbox() {
  if (!connected || inboxLoading || busy || document.hidden) return
  const current = epoch, version = inboxVersion
  inboxLoading = true
  try {
    const result = await api("inbox")
    if (!connected || current !== epoch || version !== inboxVersion || busy) return
    if (JSON.stringify(state.approvals) !== JSON.stringify(result.approvals)) {
      state.approvals = result.approvals; renderApprovals()
    }
    $("inbox-sync").textContent = "Live · checks every 2 seconds"
  } catch {
    if (connected && current === epoch) $("inbox-sync").textContent = "Live updates disconnected · retrying; use Refresh view if needed."
  } finally { inboxLoading = false }
}
function startInbox() {
  clearTimeout(inboxTimer)
  const current = epoch
  const tick = async () => {
    if (!connected || current !== epoch) return
    await syncInbox()
    if (connected && current === epoch) inboxTimer = setTimeout(tick, 2000)
  }
  inboxTimer = setTimeout(tick, 100)
}
function render() {
  $("pack-list").replaceChildren()
  for (const pack of state.packs ?? []) {
    const row = text("div", "", "source-card"), info = text("div", "", "source-details")
    info.append(text("h3", `${pack.name} · first-party pack`), text("p", pack.transport), text("p", pack.readiness), text("p", `Workflow files: ${pack.skills}`))
    const add = button(`Register ${pack.name}`, async () => {
      await api("sources", "POST", { name: pack.name, config: { kind: "pack", pack: pack.id } })
      await reload(); notify(`${pack.name} registered disabled, with no grants. Discover tools when its connection is ready.`)
    })
    add.disabled = state.sources.some(source => source.config.kind === "pack" && source.config.pack === pack.id)
    row.append(info, add); $("pack-list").append(row)
  }
  $("source-count").textContent = state.sources.length
  $("tool-count").textContent = state.tools.length
  $("caller-count").textContent = state.callers.filter(c => !c.revoked).length
  $("grant-count").textContent = state.grants.filter(g => g.policy?.mode !== "deny").length
  const list = $("source-list"); list.replaceChildren()
  if (!state.sources.length) list.append(text("p", "Start with the built-in demo, or register a trusted remote MCP server.", "empty"))
  for (const source of state.sources) {
    const row = text("div", "", "source-card"); row.append(text("div", source.config.kind === "demo" ? "◇" : "↗", "source-icon"))
    const details = text("div", "", "source-details"); details.append(text("h3", source.name), text("p", source.config.kind === "demo" ? "Built-in demo · no external effects" : source.config.kind === "pack" ? `First-party ${source.config.pack} · caller-specific policies` : source.config.url), text("p", `${state.tools.filter(t => t.sourceId === source.id).length} tools · ${source.refreshedAt ? `Last discovery ${new Date(source.refreshedAt).toLocaleString()}` : "Not discovered yet"}`)); row.append(details)
    const actions = text("div", "", "source-actions"); actions.append(text("span", source.enabled ? "Enabled" : "Disabled", `pill${source.enabled ? " enabled" : ""}`), button("Discover tools", async () => { notify("Discovering catalog…"); await api(`sources/${source.id}/refresh`, "POST"); await reload(); notify("Catalog refreshed. Changed contracts require new grants.") }), button(source.enabled ? "Disable" : "Enable", async () => { await api(`sources/${source.id}`, "PATCH", { enabled: !source.enabled }); await reload(); notify(source.enabled ? "Source disabled. Already-dispatched calls may still complete." : "Source enabled. Only explicitly granted tools can be called.") })); row.append(actions); list.append(row)
  }
  const selected = $("grant-caller").value
  $("grant-caller").replaceChildren(new Option("Choose a caller", ""), ...state.callers.filter(c => !c.revoked).map(c => new Option(c.name, c.id)))
  if (state.callers.some(c => c.id === selected && !c.revoked)) $("grant-caller").value = selected
  renderTools()
  $("caller-list").replaceChildren()
  for (const caller of state.callers) {
    const row = text("div", "", "caller-row"), info = text("div", "")
    info.append(text("strong", caller.name), text("small", caller.revoked ? "Revoked" : `${state.grants.filter(g => g.callerId === caller.id && g.policy?.mode !== "deny").length} explicit grants · caller only`)); row.append(info)
    if (!caller.revoked) row.append(button("Revoke key", async () => { if (!confirm(`Revoke ${caller.name}? New calls stop; in-flight effects are not undone.`)) return; await api(`callers/${caller.id}`, "DELETE"); await reload(); notify("Caller key revoked.") }, "danger"))
    $("caller-list").append(row)
  }
  $("receipt-list").replaceChildren()
  for (const receipt of state.receipts) {
    const row = document.createElement("tr")
    for (const value of [new Date(receipt.started_at).toLocaleTimeString(), state.tools.find(t => t.id === receipt.tool_id)?.name ?? receipt.tool_id, receipt.status, `${receipt.duration_ms} ms`]) row.append(text("td", value))
    $("receipt-list").append(row)
  }
  $("activity-empty").hidden = state.receipts.length > 0
  renderApprovals()
}
function renderApprovals() {
  const pending = (state.approvals ?? []).filter(a => a.status === "pending")
  for (const id of selectedApprovals) if (!pending.some(a => a.id === id)) selectedApprovals.delete(id)
  $("pending-count").textContent = `${pending.length} pending`
  $("select-approvals").checked = pending.length > 0 && pending.every(a => selectedApprovals.has(a.id))
  $("select-approvals").indeterminate = pending.some(a => selectedApprovals.has(a.id)) && !$("select-approvals").checked
  $("select-approvals").disabled = !pending.length
  $("approve-selected").disabled = $("deny-selected").disabled = !selectedApprovals.size
  $("approval-list").replaceChildren()
  if (!state.approvals?.length) $("approval-list").append(text("p", "No approval requests. Calls follow the selected caller policy.", "empty"))
  for (const approval of state.approvals ?? []) {
    const card = text("div", "", "inset")
    const caller = state.callers.find(c => c.id === approval.caller_id)
    const source = state.sources.find(s => s.id === approval.source_id)
    card.append(text("h3", `${approval.status.toUpperCase()} · ${state.tools.find(t => t.id === approval.tool_id)?.name ?? approval.tool_id}`),
      text("p", `Caller: ${caller?.name ?? approval.caller_id} (${approval.caller_id})`),
      text("p", `Source: ${source?.name ?? approval.source_id} (${approval.source_id}) · revision ${approval.revision}`),
      text("p", `Contract fingerprint: ${approval.fingerprint}`), text("p", `Expires: ${new Date(approval.expires_at).toLocaleString()}`))
    if (approval.arguments) card.append(text("pre", JSON.stringify(approval.arguments, null, 2)))
    if (approval.status === "pending") {
      const label = text("label", "", "grant-label"), check = document.createElement("input")
      check.type = "checkbox"; check.checked = selectedApprovals.has(approval.id); check.setAttribute("aria-label", `Select request ${approval.id}`)
      check.addEventListener("change", () => { if (check.checked) selectedApprovals.add(approval.id); else selectedApprovals.delete(approval.id); renderApprovals() })
      label.append(check, text("span", "Select this request")); card.prepend(label)
    }
    if (approval.status === "pending") for (const decision of ["approved", "denied"]) card.append(button(decision === "approved" ? "Approve once" : "Deny", async () => {
      await api(`approvals/${approval.id}`, "POST", { decision }); await reload()
      notify(decision === "approved" ? "Approved once. The caller must resubmit the identical call with its approval ID; nothing executed yet." : "Request denied. No call dispatched.")
    }, decision === "approved" ? "" : "danger"))
    $("approval-list").append(card)
  }
}
function renderTools() {
  const filter = $("tool-filter").value.toLowerCase(), callerId = $("grant-caller").value
  const tools = state.tools.filter(t => `${t.name} ${t.description} ${state.sources.find(s => s.id === t.sourceId)?.name}`.toLowerCase().includes(filter))
  $("tool-list").replaceChildren()
  $("catalog-empty").hidden = tools.length > 0
  $("catalog-empty").textContent = state.tools.length ? "No tools match this filter." : "No tools yet. Register a source and discover its catalog."
  for (const [id, fingerprint] of selectedTools) if (!tools.some(t => t.id === id && t.fingerprint === fingerprint)) selectedTools.delete(id)
  updateToolSelection(tools)
  let previousSource
  for (const tool of tools) {
    if (tool.sourceId !== previousSource) {
      previousSource = tool.sourceId
      const groupTools = tools.filter(t => t.sourceId === tool.sourceId), group = document.createElement("tr"), cell = document.createElement("th")
      cell.colSpan = 5; cell.scope = "rowgroup"; group.className = "tool-group"
      const label = text("label", "", "grant-label"), check = document.createElement("input"), sourceName = state.sources.find(s => s.id === tool.sourceId)?.name ?? "Unknown"
      check.type = "checkbox"; check.disabled = !callerId; check.checked = groupTools.every(t => selectedTools.get(t.id) === t.fingerprint)
      check.indeterminate = groupTools.some(t => selectedTools.has(t.id)) && !check.checked
      check.setAttribute("aria-label", `Select all ${sourceName} tools`)
      check.addEventListener("change", () => { for (const t of groupTools) { if (check.checked) selectedTools.set(t.id, t.fingerprint); else selectedTools.delete(t.id) } renderTools() })
      label.append(check, text("span", `${sourceName} · ${groupTools.length} tools`)); cell.append(label); group.append(cell); $("tool-list").append(group)
    }
    const row = document.createElement("tr"), name = document.createElement("td")
    const selection = document.createElement("td"), select = document.createElement("input")
    select.type = "checkbox"; select.disabled = !callerId; select.checked = selectedTools.get(tool.id) === tool.fingerprint; select.setAttribute("aria-label", `Select ${tool.name}`)
    select.addEventListener("change", () => { if (select.checked) selectedTools.set(tool.id, tool.fingerprint); else selectedTools.delete(tool.id); renderTools() })
    selection.append(select); row.append(selection)
    name.append(text("code", tool.name), text("p", tool.description)); row.append(name)
    const source = state.sources.find(s => s.id === tool.sourceId), sourceCell = text("td", "")
    sourceCell.append(text("div", source?.name ?? "Unknown"), text("p", source?.enabled ? "Enabled" : "Disabled")); row.append(sourceCell)
    const schema = document.createElement("td"); schema.append(button("View schema", async () => { $("schema-content").textContent = JSON.stringify(tool, null, 2); $("schema-dialog").showModal() })); row.append(schema)
    const access = document.createElement("td"), label = text("label", "", "grant-label"), checkbox = document.createElement("input")
    const grant = state.grants.find(g => g.callerId === callerId && g.toolId === tool.id)
    checkbox.type = "checkbox"; checkbox.checked = !!grant && grant.policy?.mode !== "deny"; checkbox.disabled = !callerId
    checkbox.setAttribute("aria-label", `Grant ${tool.name}`)
    checkbox.addEventListener("change", () => {
      if (busy) { renderTools(); return }
      const granted = checkbox.checked
      action(async () => { try {
        if (granted && grant?.policy?.mode === "deny") await api(`callers/${callerId}/policies`, "PUT", { tools: [{ id: tool.id, fingerprint: tool.fingerprint }], policy: { mode: "ask" } })
        else await api(`callers/${callerId}/grants`, "PUT", { toolId: tool.id, granted })
        await reload(); notify(granted ? `Access granted: ${tool.name}` : `Access revoked: ${tool.name}`)
      } catch (error) { renderTools(); throw error } })
    })
    label.append(checkbox, text("span", callerId ? (grant ? policyLabel(grant.policy?.mode ?? "legacy") : "Not granted") : "Select caller")); access.append(label)
    if (grant?.policy?.mode === "scope") access.append(text("p", `Until ${new Date(grant.policy.expiresAt).toLocaleString()} · equals ${JSON.stringify(grant.policy.equals)}`))
    row.append(access); $("tool-list").append(row)
  }
}
function updateToolSelection(tools) {
  $("selected-count").textContent = `${selectedTools.size} selected`
  $("select-tools").disabled = !$("grant-caller").value || !tools.length
  $("select-tools").checked = tools.length > 0 && tools.every(t => selectedTools.get(t.id) === t.fingerprint)
  $("select-tools").indeterminate = tools.some(t => selectedTools.has(t.id)) && !$("select-tools").checked
  $("apply-policy").disabled = !$("grant-caller").value || !selectedTools.size
}
function openConsole(message) {
  $("admin-token").value = ""; $("login").hidden = true; $("disconnect").hidden = false; $("dashboard").hidden = false; $("reload").disabled = false
  $("connection-heading").textContent = "Administration connected"
  notify(message)
  startInbox()
}
function lockLocal() {
  epoch++; inboxVersion++; token = ""; connected = false; clearTimeout(inboxTimer)
  selectedTools.clear(); selectedApprovals.clear()
  state = { sources: [], tools: [], callers: [], grants: [], receipts: [], approvals: [] }
  $("dashboard").hidden = true; $("login").hidden = false; $("disconnect").hidden = true; $("reload").disabled = true
  $("admin-token").value = ""; $("issued-token").textContent = ""; $("issued").hidden = true; $("schema-content").textContent = ""
  for (const id of ["source-list", "pack-list", "tool-list", "caller-list", "receipt-list", "approval-list"]) $(id).replaceChildren()
  $("grant-caller").replaceChildren(new Option("Choose a caller", "")); $("scope-equals").value = ""; $("scope-expiry").value = ""
  $("schema-dialog").close(); $("connection-heading").textContent = "Connect as administrator"
  $("inbox-sync").textContent = "Live updates stopped · console locked."
}
$("login").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  epoch++; token = $("admin-token").value.trim()
  try { await api("session", "POST") } finally { token = ""; $("admin-token").value = "" }
  connected = true; await reload()
  openConsole("Connected. This browser stays signed in for 7 days; Lock console signs out.")
}) })
$("disconnect").addEventListener("click", async () => {
  lockLocal()
  const current = epoch, submit = $("login").querySelector("button")
  submit.disabled = true; notify("Signing out and revoking this browser session…")
  try {
    await api("session", "DELETE")
    if (current === epoch) notify("Console locked. Browser session revoked; sign in to reconnect.")
  } catch {
    if (current === epoch) notify("Console cleared, but sign-out could not be confirmed. Reconnect and lock again; refreshing may restore the old session.", true)
  } finally { submit.disabled = false }
})
$("reload").addEventListener("click", () => action(async () => { await reload(); notify("Registry view refreshed.") }))
$("show-add").addEventListener("click", () => { $("source-form").hidden = false; $("source-name").focus() })
$("cancel-add").addEventListener("click", () => { $("source-form").hidden = true })
$("source-kind").addEventListener("change", () => { const remote = $("source-kind").value === "mcp"; document.querySelectorAll(".remote-field").forEach(node => { node.hidden = !remote }); $("source-url").required = remote })
$("source-form").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const config = $("source-kind").value === "demo" ? { kind: "demo" } : { kind: "mcp", url: $("source-url").value.trim(), ...($("source-env").value.trim() ? { bearerEnv: $("source-env").value.trim() } : {}) }
  await api("sources", "POST", { name: $("source-name").value, config }); $("source-form").hidden = true; $("source-name").value = ""; await reload(); notify("Source registered, disabled and without grants.")
}) })
$("caller-form").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  const { caller } = await api("callers", "POST", { name: $("caller-name").value }); $("issued-token").textContent = caller.token; $("issued").hidden = false; $("caller-name").value = ""; await reload(); $("grant-caller").value = caller.id; renderTools(); notify("Caller created with no grants. Save its key, then select capabilities.")
}) })
$("dismiss-token").addEventListener("click", () => { $("issued-token").textContent = ""; $("issued").hidden = true })
$("tool-filter").addEventListener("input", renderTools)
$("grant-caller").addEventListener("change", () => { selectedTools.clear(); renderTools() })
$("close-schema").addEventListener("click", () => $("schema-dialog").close())
$("select-tools").addEventListener("change", () => {
  const filter = $("tool-filter").value.toLowerCase()
  for (const tool of state.tools.filter(t => `${t.name} ${t.description} ${state.sources.find(s => s.id === t.sourceId)?.name}`.toLowerCase().includes(filter))) {
    if ($("select-tools").checked) selectedTools.set(tool.id, tool.fingerprint); else selectedTools.delete(tool.id)
  }
  renderTools()
})
$("policy-mode").addEventListener("change", () => { $("scope-fields").hidden = $("policy-mode").value !== "scope" })
$("apply-policy").addEventListener("click", () => action(async () => {
  const callerId = $("grant-caller").value, mode = $("policy-mode").value
  const policy = mode === "scope" ? { mode, equals: JSON.parse($("scope-equals").value), expiresAt: new Date($("scope-expiry").value).getTime() } : { mode }
  const tools = [...selectedTools].map(([id, fingerprint]) => ({ id, fingerprint }))
  await api(`callers/${callerId}/policies`, "PUT", { tools, policy })
  selectedTools.clear(); await reload(); notify(`${policyLabel(mode)} applied to ${tools.length} selected tools. Nothing executed.`)
}))
$("select-approvals").addEventListener("change", () => {
  for (const approval of state.approvals ?? []) if (approval.status === "pending") {
    if ($("select-approvals").checked) selectedApprovals.add(approval.id); else selectedApprovals.delete(approval.id)
  }
  renderApprovals()
})
for (const [id, decision] of [["approve-selected", "approved"], ["deny-selected", "denied"]]) $(id).addEventListener("click", () => action(async () => {
  const ids = [...selectedApprovals]
  await api("approvals", "POST", { ids, decision }); selectedApprovals.clear(); await reload()
  notify(`${ids.length} requests ${decision}. No calls dispatched.`)
}))
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncInbox() })
window.addEventListener("focus", () => syncInbox())
action(async () => {
  try {
    await api("session")
    connected = true; await reload()
    openConsole("Browser session restored. No token re-entry needed; Lock console signs out.")
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) notify("Could not restore the browser connection. Refresh to retry; the saved session has not been removed.", true)
  }
})
