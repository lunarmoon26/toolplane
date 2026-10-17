const $ = id => document.getElementById(id)
let token = ""
let state = { sources: [], tools: [], callers: [], grants: [], receipts: [] }
let busy = false
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node }
const notify = (message, error = false) => { $("notice").textContent = message; $("notice").className = error ? "error" : "" }
async function api(path, method = "GET", body) {
  const response = await fetch(`/api/admin/${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result
}
async function action(fn) {
  if (busy) return
  busy = true
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
async function reload() { state = await api("state"); render() }
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
  $("grant-count").textContent = state.grants.length
  const list = $("source-list"); list.replaceChildren()
  if (!state.sources.length) list.append(text("p", "Start with the built-in demo, or register a trusted remote MCP server.", "empty"))
  for (const source of state.sources) {
    const row = text("div", "", "source-card"); row.append(text("div", source.config.kind === "demo" ? "◇" : "↗", "source-icon"))
    const details = text("div", "", "source-details"); details.append(text("h3", source.name), text("p", source.config.kind === "demo" ? "Built-in demo · no external effects" : source.config.kind === "pack" ? `First-party ${source.config.pack} · per-call write approval` : source.config.url), text("p", `${state.tools.filter(t => t.sourceId === source.id).length} tools · ${source.refreshedAt ? `Last discovery ${new Date(source.refreshedAt).toLocaleString()}` : "Not discovered yet"}`)); row.append(details)
    const actions = text("div", "", "source-actions"); actions.append(text("span", source.enabled ? "Enabled" : "Disabled", `pill${source.enabled ? " enabled" : ""}`), button("Discover tools", async () => { notify("Discovering catalog…"); await api(`sources/${source.id}/refresh`, "POST"); await reload(); notify("Catalog refreshed. Changed contracts require new grants.") }), button(source.enabled ? "Disable" : "Enable", async () => { await api(`sources/${source.id}`, "PATCH", { enabled: !source.enabled }); await reload(); notify(source.enabled ? "Source disabled. Already-dispatched calls may still complete." : "Source enabled. Only explicitly granted tools can be called.") })); row.append(actions); list.append(row)
  }
  const selected = $("grant-caller").value
  $("grant-caller").replaceChildren(new Option("Choose a caller", ""), ...state.callers.filter(c => !c.revoked).map(c => new Option(c.name, c.id)))
  if (state.callers.some(c => c.id === selected && !c.revoked)) $("grant-caller").value = selected
  renderTools()
  $("caller-list").replaceChildren()
  for (const caller of state.callers) {
    const row = text("div", "", "caller-row"), info = text("div", "")
    info.append(text("strong", caller.name), text("small", caller.revoked ? "Revoked" : `${state.grants.filter(g => g.callerId === caller.id).length} explicit grants · caller only`)); row.append(info)
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
  $("approval-list").replaceChildren()
  if (!state.approvals?.length) $("approval-list").append(text("p", "No approval requests. Writes remain blocked until explicitly approved.", "empty"))
  for (const approval of state.approvals ?? []) {
    const card = text("div", "", "inset")
    const caller = state.callers.find(c => c.id === approval.caller_id)
    const source = state.sources.find(s => s.id === approval.source_id)
    card.append(text("h3", `${approval.status.toUpperCase()} · ${state.tools.find(t => t.id === approval.tool_id)?.name ?? approval.tool_id}`),
      text("p", `Caller: ${caller?.name ?? approval.caller_id} (${approval.caller_id})`),
      text("p", `Source: ${source?.name ?? approval.source_id} (${approval.source_id}) · revision ${approval.revision}`),
      text("p", `Contract fingerprint: ${approval.fingerprint}`), text("p", `Expires: ${new Date(approval.expires_at).toLocaleString()}`))
    if (approval.arguments) card.append(text("pre", JSON.stringify(approval.arguments, null, 2)))
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
  for (const tool of tools) {
    const row = document.createElement("tr"), name = document.createElement("td")
    name.append(text("code", tool.name), text("p", tool.description)); row.append(name)
    const source = state.sources.find(s => s.id === tool.sourceId), sourceCell = text("td", "")
    sourceCell.append(text("div", source?.name ?? "Unknown"), text("p", source?.enabled ? "Enabled" : "Disabled")); row.append(sourceCell)
    const schema = document.createElement("td"); schema.append(button("View schema", async () => { $("schema-content").textContent = JSON.stringify(tool, null, 2); $("schema-dialog").showModal() })); row.append(schema)
    const access = document.createElement("td"), label = text("label", "", "grant-label"), checkbox = document.createElement("input")
    checkbox.type = "checkbox"; checkbox.checked = state.grants.some(g => g.callerId === callerId && g.toolId === tool.id); checkbox.disabled = !callerId
    checkbox.setAttribute("aria-label", `Grant ${tool.name}`)
    checkbox.addEventListener("change", () => {
      if (busy) { renderTools(); return }
      const granted = checkbox.checked
      action(async () => { try { await api(`callers/${callerId}/grants`, "PUT", { toolId: tool.id, granted }); await reload(); notify(granted ? `Access granted: ${tool.name}` : `Access revoked: ${tool.name}`) } catch (error) { renderTools(); throw error } })
    })
    label.append(checkbox, text("span", callerId ? (checkbox.checked ? "Granted" : "Not granted") : "Select caller")); access.append(label); row.append(access); $("tool-list").append(row)
  }
}
$("login").addEventListener("submit", event => { event.preventDefault(); action(async () => {
  token = $("admin-token").value.trim()
  try { await reload() } catch (error) { token = ""; throw error }
  $("admin-token").value = ""; $("login").hidden = true; $("disconnect").hidden = false; $("dashboard").hidden = false; $("reload").disabled = false
  $("connection-heading").textContent = "Administration connected"
  notify("Connected. Changes apply immediately to new calls.")
}) })
$("disconnect").addEventListener("click", () => { token = ""; state = { sources: [], tools: [], callers: [], grants: [], receipts: [] }; $("dashboard").hidden = true; $("login").hidden = false; $("disconnect").hidden = true; $("reload").disabled = true; $("issued-token").textContent = ""; $("issued").hidden = true; $("schema-content").textContent = ""; $("connection-heading").textContent = "Connect as administrator"; notify("Console locked. Credentials are not retained in browser storage.") })
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
$("grant-caller").addEventListener("change", renderTools)
$("close-schema").addEventListener("click", () => $("schema-dialog").close())
$("disconnect").addEventListener("click", () => { $("approval-list").replaceChildren(); $("schema-dialog").close() })
