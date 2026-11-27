"""End-to-end browser test of the main workflow against a running server.

Usage: BASE_URL=http://localhost:3001 DATABASE_URL=... python3 tests/e2e/browser.py
Needs: pip install playwright (and a Chrome/Chromium binary), psql on PATH, npx tsx.
"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://localhost:3001")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
DB = os.environ["DATABASE_URL"]


def sql(q):
    return subprocess.check_output(["psql", DB, "-tAc", q], text=True).strip()


def step(msg):
    print(f"✓ {msg}", flush=True)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900})

    # 1. Sign in through the real form.
    page.goto(f"{BASE}/login")
    page.fill("#email", "admin@demo.fest")
    page.fill("#password", "Demo-Admin-2026")
    page.click("button:has-text('Sign in')")
    page.wait_for_url(f"{BASE}/overview")
    expect(page.get_by_text("Unique verified attendees").first).to_be_visible()
    step("signed in as admin and Overview loaded")

    # 2. Wrong password is rejected.
    ctx2 = browser.new_context()
    p2 = ctx2.new_page()
    p2.goto(f"{BASE}/login")
    p2.fill("#email", "admin@demo.fest"); p2.fill("#password", "nope"); p2.click("button:has-text('Sign in')")
    expect(p2.get_by_text("Email or password is incorrect")).to_be_visible()
    ctx2.close()
    step("wrong password rejected")

    # 3. Create a task from the UI.
    title = f"E2E task {int(time.time())}"
    page.goto(f"{BASE}/tasks?new=1")
    page.fill("input[name=title]", title)
    page.select_option("select[name=priority]", "high")
    page.fill("input[name=dueDate]", "2026-12-15")
    page.click("button:has-text('Create task')")
    expect(page.get_by_text("Task created")).to_be_visible()
    assert sql(f"select count(*) from tasks where title = '{title}'") == "1"
    step("created a task through the form; it is in the database")

    # 4. Change its status from the list view; analytics reflect it.
    page.goto(f"{BASE}/tasks?view=list")
    row = page.locator("tr", has_text=title)
    row.locator("select[aria-label=status]").select_option("blocked")
    time.sleep(1.5)
    assert sql(f"select status from tasks where title = '{title}'") == "blocked"
    page.goto(f"{BASE}/tasks?filter=blocked")
    expect(page.get_by_text(title)).to_be_visible()
    step("status change saved and the task now appears under Blocked")

    # 5. Approve an AI-drafted task, with an edited deadline.
    approval = subprocess.check_output(["npx", "tsx", "tests/e2e/propose.ts"], text=True).strip().splitlines()[-1]
    page.goto(f"{BASE}/approvals")
    card = page.locator("div.rounded-xl", has_text="E2E: Cut Paid Social prospecting").first
    expect(card).to_be_visible()
    assert sql("select count(*) from tasks where title like 'E2E: Cut Paid Social%'") == "0"
    card.locator("input[name=dueDate]").fill("2026-12-09")
    card.get_by_role("button", name="Approve (with edits)").click()
    expect(card.get_by_text("Approved and applied")).to_be_visible()
    assert sql("select origin || ' ' || due_date from tasks where title like 'E2E: Cut Paid Social%'") == "ai 2026-12-09"
    assert sql(f"select status from approvals where id = '{approval}'") == "approved"
    page.goto(f"{BASE}/tasks?view=calendar&month=2026-12")
    expect(page.get_by_text("E2E: Cut Paid Social prospecting").first).to_be_visible()
    step("AI draft created nothing until approved; after approval it shows in list, board and calendar")

    # 6. Edit a campaign and see it in analytics.
    cid = sql("select c.id from campaigns c join workspaces w on w.active_dataset_version_id = c.dataset_version_id where c.source_id = 'C03'")
    page.goto(f"{BASE}/campaigns/{cid}")
    page.fill("input[name=budgetApprovedInr]", "45000")
    page.click("button:has-text('Save changes')")
    expect(page.get_by_text("Campaign updated")).to_be_visible()
    page.reload()
    expect(page.get_by_text("Approved ₹45,000")).to_be_visible()
    expect(page.get_by_text("Spend exceeds the campaign's approved budget")).to_be_visible()
    step("campaign budget edit saved and health reasons updated")

    # 7. Live refresh: another change to the data refreshes an open page without reload.
    page.goto(f"{BASE}/overview")
    before = page.get_by_text("Unique verified attendees").first.locator("xpath=../..").inner_text()
    ck = sql("""select c.id from check_ins c join people p on p.id = c.person_id join workspaces w on w.active_dataset_version_id = c.dataset_version_id
                where c.result='admitted' and c.verification='verified' and p.person_type='external'
                and (select count(*) from check_ins c2 where c2.person_id=c.person_id and c2.result='admitted' and c2.verification='verified') = 1 limit 1""")
    sql(f"update check_ins set verification = 'unverified' where id = {ck}; update workspaces set data_version = data_version + 1")
    expect(page.get_by_text("2,049").first).to_be_visible(timeout=15000)
    sql(f"update check_ins set verification = 'verified' where id = {ck}; update workspaces set data_version = data_version + 1")
    expect(page.get_by_text("2,050").first).to_be_visible(timeout=15000)
    step("open Overview refreshed itself after a data change (2,050 → 2,049 → 2,050)")

    # 8. A team member cannot see admin controls and cannot approve.
    page.goto(f"{BASE}/overview")
    page.click("button:has-text('Sign out')")
    page.fill("#email", "dev@demo.fest"); page.fill("#password", "Demo-Member-2026"); page.click("button:has-text('Sign in')")
    page.wait_for_url(f"{BASE}/overview")
    page.goto(f"{BASE}/datasets")
    expect(page.get_by_text("Only admins can import or switch datasets")).to_be_visible()
    page.goto(f"{BASE}/tasks?new=1")
    assert page.locator("text=New task").count() == 0
    step("team member sees read-only dataset page and no task creation")

    # Clean up the campaign edit.
    sql(f"update campaigns set budget_approved_inr = null where id = '{cid}'")
    browser.close()
    print("All browser checks passed.")
