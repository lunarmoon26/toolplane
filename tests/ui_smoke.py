"""Run against tests/ui_server.ts, never a real registry. Requires Playwright."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect

out = Path("test-results")
out.mkdir(exist_ok=True)
base = os.environ["TOOLPLANE_UI_URL"]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_load_state("networkidle")
    page.screenshot(path=str(out / "01-locked.png"), full_page=True)
    page.get_by_label("Admin token").fill("ui-test-only-admin-credential-not-for-production")
    page.get_by_role("button", name="Connect", exact=True).click()
    expect(page.locator("#dashboard")).to_be_visible()
    cookies = page.context.cookies()
    session_cookie = next(cookie for cookie in cookies if cookie["name"] == "toolplane_admin_session")
    assert session_cookie["httpOnly"] and session_cookie["sameSite"] == "Strict"
    assert session_cookie["expires"] > 0 and session_cookie["path"] == "/api/admin"
    assert "ui-test-only-admin-credential" not in session_cookie["value"]
    assert "toolplane_admin_session" not in page.evaluate("document.cookie")
    page.reload()
    expect(page.locator("#dashboard")).to_be_visible()
    expect(page.get_by_label("Admin token")).to_have_value("")
    # Browser profile restore: cookie persists without re-entering the admin key.
    reopened = browser.new_context(storage_state=page.context.storage_state())
    restored = reopened.new_page()
    restored.goto(base)
    expect(restored.locator("#dashboard")).to_be_visible()
    restored.close(); reopened.close(); page.bring_to_front()
    page.get_by_role("button", name="Register source").click()
    page.get_by_label("Name", exact=True).fill("Demo workspace")
    page.get_by_role("button", name="Create disabled registration").click()
    expect(page.locator("#source-count")).to_have_text("1")
    expect(page.locator("#source-list .pill")).to_have_text("Disabled")
    page.get_by_role("button", name="Discover tools").click()
    expect(page.locator("#tool-count")).to_have_text("2")
    page.get_by_role("button", name="Enable", exact=True).click()
    expect(page.locator("#source-list .pill")).to_have_text("Enabled")
    page.get_by_label("Caller name").fill("Research agent")
    page.get_by_role("button", name="Create caller key").click()
    expect(page.locator("#issued-token")).not_to_be_empty()
    caller_token = page.locator("#issued-token").inner_text()
    expect(page.locator("#grant-count")).to_have_text("0")
    # Clear the fixture key before any screenshot; keys are never visual evidence.
    page.get_by_role("button", name="I saved it · dismiss").click()
    page.get_by_role("checkbox", name="Grant status", exact=True).check()
    expect(page.locator("#grant-count")).to_have_text("1")
    state = page.request.get(base + "/api/admin/state", headers={
        "Authorization": "Bearer ui-test-only-admin-credential-not-for-production"
    }).json()
    status_id = next(tool["id"] for tool in state["tools"] if tool["name"] == "status")
    call = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token},
                             data={"id": status_id, "arguments": {}})
    assert call.ok, "Demo caller invocation failed"
    page.get_by_role("button", name="Refresh view").click()
    expect(page.locator("#receipt-list")).to_contain_text("succeeded")
    page.get_by_role("button", name="View schema").first.click()
    expect(page.locator("#schema-content")).to_contain_text("inputSchema")
    page.get_by_role("button", name="Close", exact=True).click()
    page.locator("#tool-filter").fill("status")
    expect(page.locator("#tool-list tr:not(.tool-group)")).to_have_count(1)
    page.locator("#tool-filter").fill("")
    # Synthetic approval path: no real endpoint or app is contacted.
    admin_headers = {"Authorization": "Bearer ui-test-only-admin-credential-not-for-production"}
    source = page.request.post(base + "/api/admin/sources", headers=admin_headers,
        data={"name": "Approval fixture", "config": {"kind": "mcp", "url": "http://127.0.0.1:1/mcp"}}).json()["source"]
    discovered = page.request.post(base + f'/api/admin/sources/{source["id"]}/refresh', headers=admin_headers).json()["tools"][0]
    page.request.patch(base + f'/api/admin/sources/{source["id"]}', headers=admin_headers, data={"enabled": True})
    caller_id = state["callers"][0]["id"]
    page.request.put(base + f'/api/admin/callers/{caller_id}/grants', headers=admin_headers,
        data={"toolId": discovered["id"], "granted": True})
    payload = {"id": discovered["id"], "arguments": {"target": "exact fixture target"}}
    queued = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload).json()["approval"]
    # No Refresh click: a request from another client appears automatically.
    page.locator("#tool-filter").fill("status")
    expect(page.locator("#approval-list")).to_contain_text("exact fixture target", timeout=8000)
    expect(page.locator("#tool-filter")).to_have_value("status")
    expect(page.locator("#pending-count")).to_have_text("1 pending")
    expect(page.locator("#approval-list")).to_contain_text(caller_id)
    page.locator("#approvals").screenshot(path=str(out / "05-approval-inbox.png"))
    page.get_by_role("button", name="Approve once", exact=True).click()
    expect(page.locator("#approval-list")).to_contain_text("APPROVED")
    payload["approvalId"] = queued["approvalId"]
    executed = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload)
    assert executed.ok and executed.json()["result"]["structuredContent"]["fixtureOnly"]
    replay = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload)
    assert replay.status == 409
    del payload["approvalId"]
    queued = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload).json()["approval"]
    expect(page.locator("#pending-count")).to_have_text("1 pending", timeout=8000)
    expect(page.get_by_role("button", name="Deny", exact=True)).to_be_visible()
    page.get_by_role("button", name="Deny", exact=True).click()
    expect(page.locator("#approval-list")).to_contain_text("DENIED")
    # Explicit snapshot bulk decisions; incoming requests are not auto-selected.
    for target in ["batch-one", "batch-two"]:
        page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token},
                          data={"id": discovered["id"], "arguments": {"target": target}})
    expect(page.locator("#pending-count")).to_have_text("2 pending", timeout=8000)
    page.locator("#select-approvals").check()
    page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token},
                      data={"id": discovered["id"], "arguments": {"target": "late-unselected"}})
    expect(page.locator("#pending-count")).to_have_text("3 pending", timeout=8000)
    assert page.locator("#select-approvals").evaluate("node => node.indeterminate")
    page.get_by_role("button", name="Approve selected once", exact=True).click()
    expect(page.locator("#pending-count")).to_have_text("1 pending")
    page.locator("#select-approvals").check()
    page.get_by_role("button", name="Deny selected", exact=True).click()
    expect(page.locator("#pending-count")).to_have_text("0 pending")
    # Group/filtered selection and durable caller policies.
    page.locator("#tool-filter").fill("Approval fixture")
    expect(page.get_by_role("checkbox", name="Select all Approval fixture tools", exact=True)).to_be_visible()
    page.get_by_role("checkbox", name="Select all Approval fixture tools", exact=True).check()
    expect(page.locator("#selected-count")).to_have_text("1 selected")
    page.locator("#policy-mode").select_option("allow")
    page.get_by_role("button", name="Apply policy to selected", exact=True).click()
    expect(page.locator("#notice")).to_contain_text("Allow from caller applied")
    auto = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload)
    assert auto.ok and "result" in auto.json() and "approval" not in auto.json()
    page.locator("#select-tools").check()
    page.locator("#policy-mode").select_option("scope")
    page.locator("#scope-equals").fill('{"target":"exact fixture target"}')
    # Use a valid near-future local timestamp without hardcoded dates.
    page.locator("#scope-expiry").fill(page.evaluate("() => { const d = new Date(Date.now()+3600000); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16) }"))
    page.get_by_role("button", name="Apply policy to selected", exact=True).click()
    expect(page.locator("#notice")).to_contain_text("Allow within scope applied")
    page.locator("#select-tools").check()
    page.locator("#policy-mode").select_option("deny")
    page.get_by_role("button", name="Apply policy to selected", exact=True).click()
    expect(page.locator("#notice")).to_contain_text("Deny applied")
    denied = page.request.post(base + "/api/call", headers={"Authorization": "Bearer " + caller_token}, data=payload)
    assert denied.status == 403
    page.locator("#tool-filter").fill("")
    page.get_by_role("button", name="Register Blender", exact=True).click()
    expect(page.get_by_role("button", name="Register Blender", exact=True)).to_be_disabled()
    blender_card = page.locator("#source-list .source-card").filter(has=page.get_by_role("heading", name="Blender", exact=True))
    expect(blender_card.locator(".pill")).to_have_text("Disabled")
    blender_card.get_by_role("button", name="Discover tools").click()
    expect(blender_card).to_contain_text("6 tools")
    page.locator("#catalog").screenshot(path=str(out / "06-grouped-catalog.png"))
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "04-preview.png"))
    page.screenshot(path=str(out / "02-registry.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "03-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows mobile viewport"
    # Failed live reads show stale status, then reconnect without a page reload.
    page.route("**/api/admin/inbox", lambda route: route.fulfill(status=503, json={"error": {"code": "fixture_unavailable", "message": "synthetic outage"}}))
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(page.locator("#inbox-sync")).to_contain_text("disconnected", timeout=8000)
    page.unroute("**/api/admin/inbox")
    expect(page.locator("#inbox-sync")).to_contain_text("Live ·", timeout=8000)
    peer = page.context.new_page()
    peer.on("pageerror", lambda error: errors.append(str(error)))
    peer.goto(base)
    expect(peer.locator("#dashboard")).to_be_visible()
    page.bring_to_front()
    # Hold a live-inbox response across locking; it must not restore private data.
    held = []
    page.route("**/api/admin/inbox", lambda route: held.append(route))
    with page.expect_request("**/api/admin/inbox", timeout=8000):
        page.evaluate("window.dispatchEvent(new Event('focus'))")
    page.get_by_role("button", name="Lock console").click()
    held[0].fulfill(status=200, json={"approvals": [{"id": "late", "status": "pending", "caller_id": caller_id,
        "source_id": source["id"], "tool_id": discovered["id"], "arguments": {"private": "late private content"},
        "expires_at": 9999999999999, "revision": 1, "fingerprint": "fixture"}]})
    page.wait_for_timeout(2500)
    expect(page.locator("#dashboard")).to_be_hidden()
    expect(page.locator("#approval-list")).to_be_empty()
    assert len(held) == 1, "Inbox kept polling after lock"
    expect(page.locator("#notice")).to_contain_text("session revoked")
    peer.bring_to_front()
    expect(peer.locator("#dashboard")).to_be_hidden(timeout=8000)
    peer.close(); page.bring_to_front()
    page.unroute("**/api/admin/inbox")
    page.reload()
    expect(page.locator("#login")).to_be_visible()
    expect(page.locator("#dashboard")).to_be_hidden()
    assert page.evaluate("localStorage.length") == 0
    assert page.evaluate("sessionStorage.length") == 0
    assert errors == [], errors
    browser.close()
print("UI passed: HttpOnly login restores after reload/profile reopen, logout persists, grouped policies, live inbox, bulk decisions, mobile layout, late-response locking; no JS errors.")
