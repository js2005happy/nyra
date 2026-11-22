# render8.py — html/*.html → out/<name>.png（2x）
import sys, asyncio, os, glob
from playwright.async_api import async_playwright
D = "/workspace/nyra-design/v8"
async def main(names):
    os.makedirs(f"{D}", exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for n in names:
            w, h = (390, 844) if n.startswith("m-") else (1440, 900)
            pg = await b.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
            await pg.goto(f"file://{D}/html/{n}.html"); await pg.evaluate("document.fonts.ready"); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"{D}/{n}.png"); await pg.close()
        await b.close()
names = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(f"{D}/html/*.html") if "avatars" not in f)
asyncio.run(main(names)); print("rendered", names)
