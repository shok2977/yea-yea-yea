# UI test for TubeStream: pagination click latency, thumbnail failures, completeness
from playwright.sync_api import sync_playwright
import time, re, json

BASE = "http://localhost:3080"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    console_msgs, failed_requests = [], []
    page.on("console", lambda m: console_msgs.append(f"{m.type}: {m.text[:160]}"))
    page.on("response", lambda r: failed_requests.append((r.status, r.url[:140])) if r.status >= 400 else None)

    t0 = time.time()
    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector(".video-card, .card, img", timeout=30000)
    print("HOME first cards:", round(time.time() - t0, 2), "s")

    # count cards & loaded thumbs on home
    cards = page.locator('.video-card, .card').count()
    time.sleep(3)  # give thumbs a chance
    imgs = page.locator(".video-card img, .card img")
    n_img = imgs.count()
    n_loaded = imgs.evaluate_all("els => els.filter(e => e.complete && e.naturalWidth > 0).length")
    print(f"HOME cards={cards} imgs={n_img} loaded_ok={n_loaded}")

    # failed thumb responses?
    thumb_fails = [f for f in failed_requests if "/api/thumb" in f[1]]
    print("HOME thumb failures:", len(thumb_fails), thumb_fails[:5])

    # 2. RANDOM pagination click — click page 4 (or '4' button)
    t1 = time.time()
    btn = page.locator(".page-num", has_text=re.compile(r"^4$")).first
    if btn.count() == 0:
        # may need more pages in pagination window; use next page arrow a few times
        print("no page-4 button; trying next-page arrow")
        nxt = page.locator("#nextPage, .next-page, button:has-text('›')").first
        for _ in range(3):
            nxt.click()
        btn = page.locator(".page-num.active")
    else:
        btn.click()
    # wait until active page changes / cards render
    try:
        page.wait_for_function("document.querySelectorAll('.page-num.active').length && document.querySelector('.page-num.active').textContent.trim()==='4'", timeout=25000)
    except Exception as e:
        pass
    # wait for cards after skeleton
    try:
        page.wait_for_function("!document.querySelector('.skeleton-card')", timeout=30000)
        print("PAGE-4 load:", round(time.time() - t1, 2), "s")
    except Exception:
        print("PAGE-4 load:", round(time.time() - t1, 2), "s (skeleton may persist)")
    cards4 = page.locator(".video-card, .card").count()
    time.sleep(3)
    imgs4 = page.locator(".video-card img, .card img")
    n4 = imgs4.count()
    ok4 = imgs4.evaluate_all("els => els.filter(e => e.complete && e.naturalWidth > 0).length")
    print(f"PAGE-4 cards={cards4} imgs={n4} loaded_ok={ok4}")
    thumb_fails4 = [f for f in failed_requests if "/api/thumb" in f[1]]
    print("PAGE-4 thumb failures:", len(thumb_fails4), thumb_fails4[:5])

    # what's the active page + badge text
    active = page.locator(".page-num.active").all_inner_texts()
    badge = page.locator("#countBadge, .count-badge").first.inner_text() if page.locator("#countBadge, .count-badge").first.count() else "?"
    print("active page button:", active, "| badge:", badge)

    # screenshot for evidence
    page.screenshot(path="pw-page4.png", full_page=False)
    print("screenshot saved: pw-page4.png")
    print("console errors:", [m for m in console_msgs if m.startswith("error")][:10])
    print("any >=400 responses:", failed_requests[:10])
    browser.close()
