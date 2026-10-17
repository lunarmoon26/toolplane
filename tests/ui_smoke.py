"""Run against tests/ui_server.ts, never a real registry. Requires Playwright."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect

out = Path("test-results")
out.mkdir(exist_ok=True)
base = os.environ["TOOLPLANE_UI_URL"]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_load_state("networkidle")
    page.screenshot(path=str(out / "01-locked.png"), full_page=True)
    page.get_by_label("Admin token").fill("ui-test-only-admin-credential-not-for-production")
    page.get_by_role("button", name="Connect", exact=True).click()
    expect(page.locator("#dashboard")).to_be_visible()
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
    expect(page.locator("#tool-list tr")).to_have_count(1)
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
    page.get_by_role("button", name="Refresh view").click()
    expect(page.locator("#approval-list")).to_contain_text("exact fixture target")
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
    page.get_by_role("button", name="Refresh view").click()
    page.get_by_role("button", name="Deny", exact=True).click()
    expect(page.locator("#approval-list")).to_contain_text("DENIED")
    page.get_by_role("button", name="Register Blender", exact=True).click()
    expect(page.get_by_role("button", name="Register Blender", exact=True)).to_be_disabled()
    blender_card = page.locator("#source-list .source-card").filter(has=page.get_by_role("heading", name="Blender", exact=True))
    expect(blender_card.locator(".pill")).to_have_text("Disabled")
    blender_card.get_by_role("button", name="Discover tools").click()
    expect(blender_card).to_contain_text("6 tools")
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "04-preview.png"))
    page.screenshot(path=str(out / "02-registry.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(out / "03-mobile.png"), full_page=True)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows mobile viewport"
    page.get_by_role("button", name="Lock console").click()
    expect(page.locator("#dashboard")).to_be_hidden()
    expect(page.locator("#approval-list")).to_be_empty()
    assert page.evaluate("localStorage.length") == 0
    assert errors == [], errors
    browser.close()
print("UI workflow passed: register, discover, grant, invoke, exact-argument approve/deny, replay rejection, pack registration, mobile layout, lock; no JS errors.")
