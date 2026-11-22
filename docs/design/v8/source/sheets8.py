# sheets8.py — overview.png：v8 全部 11 屏
from PIL import Image, ImageDraw, ImageFont
D = "/workspace/nyra-design/v8"
FN = "/workspace/nyra-design/v5/fonts/NotoSansSC.ttf"
def font(sz, w=500):
    f = ImageFont.truetype(FN, sz)
    try: f.set_variation_by_axes([w])
    except Exception: pass
    return f
BG = (13, 13, 13); T1 = (255, 255, 255); T3 = (151, 151, 151); WARN = (255, 148, 18)
def fit(im, w): return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
def fith(im, h): return im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
def rounded(im, r):
    m = Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.width - 1, im.height - 1], r, fill=255)
    out = Image.new("RGBA", im.size); out.paste(im.convert("RGB"), (0, 0), m); return out
def paste(S, im, xy, r=18):
    rr = rounded(im, r); S.paste(rr, xy, rr)

PCS = [("pc-33", "pc-33 会话 · 等你确认：收起的过程、收尾交代、用时 token、新审批卡"),
       ("pc-33b", "pc-33b 会话 · 工作中：一行实时状态；顶栏「完全访问」警示色"),
       ("pc-34", "pc-34 会话 + 右侧抽屉 · 改动（「更多」菜单展开）"),
       ("pc-35", "pc-35 会话 + 右侧抽屉 · 计划"),
       ("pc-36", "pc-36 会话 + 右侧抽屉 · 终端"),
       ("pc-39", "pc-39 技能 / 自动化确认卡（设计提议）"),
       ("pc-03", "pc-03 项目页：项目记忆改成文件列表 + 来源")]
MS = [("m-16", "m-16 会话"), ("m-16e", "m-16e 新对话"), ("m-17", "m-17 首页"), ("m-20a", "m-20a 等你确认")]

W = 3600; pad = 80; gap = 48; lab = 60
cw = (W - 2 * pad - gap) // 2
ims = [fit(Image.open(f"{D}/{n}.png"), cw) for n, _ in PCS]
ch = ims[0].height
mh = 0
mg = 28
mw = (cw - 3 * mg) // 4
mims = [fit(Image.open(f"{D}/{n}.png"), mw) for n, _ in MS]
mh = mims[0].height
row = ch + lab + gap
H = pad + 190 + 3 * row + max(ch, mh) + lab + pad
S = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(S)
d.text((pad, pad), "Nyra 设计稿 · v8", font=font(64, 600), fill=T1)
d.text((pad, pad + 104), "会话常驻左侧 + 右侧抽屉；工作状态一行；审批卡先说要做什么、再列能动到什么。logo、团子头像、颜色沿用 v6.2，全部为示例数据。", font=font(30, 400), fill=T3)
y0 = pad + 190
for k, ((n, lb), im) in enumerate(zip(PCS, ims)):
    x = pad + (k % 2) * (cw + gap); y = y0 + (k // 2) * row
    d.text((x, y), lb, font=font(28, 500), fill=T1); paste(S, im, (x, y + 46))
x0 = pad + cw + gap; y = y0 + 3 * row
for k, ((n, lb), im) in enumerate(zip(MS, mims)):
    x = x0 + k * (mw + mg)
    d.text((x, y), lb, font=font(26, 500), fill=T1); paste(S, im, (x, y + 46), r=36)
S.save(f"{D}/overview.png", optimize=True)
print("overview", S.size)
