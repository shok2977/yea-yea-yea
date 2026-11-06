# UI test: random sidebar category click + random pagination click latency
from playwright.sync_api import sync_playwright
import time, re

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

    # category click — navbar ke .cat-tab se (asli UI click path)
    t1 = time.time()
    link = page.locator(".cat-tab[data-cat='stockings']").first
    if link.count() == 0:
        link = page.locator(".sidebar-item[data-cat='stockings'], .sidebar-item:has-text('Stockings')").first
    link.click()
    # wait for cards to render (skeleton clear)
    try:
        page.wait_for_function("!document.querySelector('.skeleton-card') && document.querySelectorAll('.video-card,.card').length > 0", timeout=40000)
        print("CATEGORY first cards:", round(time.time() - t1, 2), "s")
    except Exception:
        print("CATEGORY first cards:", round(time.time() - t1, 2), "s (timeout ⚠)")
    badge = page.locator("#countBadge, .count-badge").first.inner_text() if page.locator("#countBadge, .count-badge").first.count() else "?"
    print("badge:", badge)

    imgs = page.locator(".video-card img, .card img")
    time.sleep(3)
    n = imgs.count(); ok = imgs.evaluate_all("els => els.filter(e => e.complete && e.naturalWidth>0).length")
    print(f"CATP1 imgs={n} loaded_ok={ok}")

    # random deep page click — page 3
    t2 = time.time()
    btn = page.locator(".page-num", has_text=re.compile(r"^3$")).first
    if btn.count():
        btn.click()
        try:
            page.wait_for_function("!document.querySelector('.skeleton-card') && document.querySelectorAll('.video-card,.card').length > 0", timeout=40000)
            print("PAGE-3 load:", round(time.time() - t2, 2), "s")
        except Exception:
            print("PAGE-3 load:", round(time.time() - t2, 2), "s (timeout ⚠)")
        time.sleep(2)
        n3 = page.locator(".video-card img, .card img").count()
        ok3 = page.locator(".video-card img, .card img").evaluate_all("els => els.filter(e => e.complete && e.naturalWidth>0).length")
        print(f"PAGE-3 cards visible imgs={n3} loaded_ok={ok3}")
    else:
        print("page-3 button not visible")

    print("console errors:", [m for m in console_msgs if m.startswith("error")][:6])
    print(">=400 responses:", failed_requests[:6])
    page.screenshot(path="pw-cat.png", full_page=False)
    browser.close()
