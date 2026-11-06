# test2: how long do thumbnails actually take on a fresh pagination page
from playwright.sync_api import sync_playwright
import time, re

BASE = "http://localhost:3080"

def thumb_state(page):
    imgs = page.locator(".video-card img, .card img")
    n = imgs.count()
    ok = imgs.evaluate_all("els => els.filter(e => e.complete && e.naturalWidth > 0).length")
    pend = imgs.evaluate_all("els => els.filter(e => !e.complete).length")
    return n, ok, pend

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    req_times = []
    page.on("request", lambda r: req_times.append({"url": r.url, "t": time.time()}) if "/api/thumb" in r.url else None)
    page.on("response", lambda r: [x.update({"done": round(time.time() - x["t"], 2), "status": r.status}) for x in req_times if x["url"].split("?")[0] == r.url[:len(r.url.split("?")[0])] and x["url"] == r.url and "done" not in x] or None)

    page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector(".video-card, .card", timeout=30000)

    for pg in ["5", "6"]:
        btn = page.locator(".page-num", has_text=re.compile(rf"^{pg}$")).first
        if not btn.count():
            print(pg, "button not found"); continue
        start = time.time()
        btn.click()
        # watch thumbs trickle in over 20s
        marks = []
        for i in range(10):
            time.sleep(2)
            n, ok, pend = thumb_state(page)
            marks.append((round(2 + i*2, 1), n, ok, pend))
        print(f"PAGE {pg}: (t, imgs, loaded, pending):", marks)
        # any thumb responses still inflight?
        inflight = [x for x in req_times if "done" not in x]
        finished = [(x["status"] if "status" in x else "?", x["done"], x["url"][:90]) for x in req_times if "done" in x]
        finished.sort(key=lambda x: x[1], reverse=True)
        print("  slowest finished thumbs:", finished[:5])
        print("  still inflight:", len(inflight))
    browser.close()
