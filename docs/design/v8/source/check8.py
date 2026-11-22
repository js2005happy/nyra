# check8.py（由 check63 改路径）：溢出、裁切、对比度、缺字、孤字、手机触控≥44；另加整词检查旧名
# check2.py（第二轮，加了新字体的缺字检查） — 逐屏检查：溢出 / 裁切（OUT、CLIPX、CLIPY）、文字对比度（LOW，浅深色都按 WCAG AA：正文 4.5，大字 3）、
# 缺字方框（TOFU：字符不在 Inter / 思源黑体 / JBM / Newsreader / 思源宋体 任何一款里）、
# 孤字换行（ORPHAN，v4.3 新增：一段文字折行后最后一行只剩 1 个字，标点不算字）。
# 用法：python3 work/check.py [屏名…]；不给屏名就查 html/ 下全部 pc-*、m-*。
import sys, asyncio, os, glob, re, html as H
from playwright.async_api import async_playwright
from fontTools.ttLib import TTFont
D = "/workspace/nyra-design/v8"; FD = "/workspace/nyra-design/v5/fonts"
JS = r"""
() => {
 const H = innerHeight, W = innerWidth, out = [];
 const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return [p[0],p[1],p[2],p.length>3?p[3]:1]; };
 const lum = ([r,g,b]) => { const f = v => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
 const blend = (fg, bg) => [0,1,2].map(i => fg[i]*fg[3] + bg[i]*(1-fg[3]));
 const bgOf = e => { const stack=[]; for (let n=e; n; n=n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3]>0) { stack.push(c); if (c[3]>=1) break; } }
   let base = [255,255,255]; for (let i=stack.length-1;i>=0;i--) base = blend(stack[i], base); return base; };
 for (const e of document.querySelectorAll('body *')) {
   const r = e.getBoundingClientRect();
   if (!r.width || !r.height) continue;
   const cs = getComputedStyle(e);
   const txt = (e.innerText||'').trim().slice(0,40).replace(/\n/g,' ');
   if (e.children.length===0 && txt && (r.bottom > H+0.5 || r.right > W+0.5)) out.push('OUT '+e.tagName+'.'+e.className+' '+txt+' b='+Math.round(r.bottom)+' r='+Math.round(r.right));
   if (e.scrollWidth > e.clientWidth+1 && ['hidden','clip'].includes(cs.overflowX) && txt) out.push('CLIPX '+e.className+' '+txt);
   if (e.scrollHeight > e.clientHeight+1 && ['hidden','clip'].includes(cs.overflowY) && e.clientHeight>0 && txt && !['HTML','BODY'].includes(e.tagName)) out.push('CLIPY '+e.className+' '+txt+' '+e.scrollHeight+'>'+e.clientHeight);
   // 对比度：只看自己直接带文字、且在最上层（没被弹层遮住）的元素
   const own = [...e.childNodes].filter(n => n.nodeType===3 && n.textContent.trim()).map(n=>n.textContent.trim()).join('');
   if (!own) continue;
   const cx = Math.min(W-1, Math.max(0, r.left + Math.min(r.width/2, 6))), cy = Math.min(H-1, Math.max(0, r.top + r.height/2));
   const top = document.elementFromPoint(cx, cy); if (!top || !(e===top || e.contains(top) || top.contains(e))) continue;
   if (e.closest('[disabled],.dis,.now')) continue;  // .now 是扫光渐变字，color 透明，另行目测   // 禁用态按规范允许降到 ink3
   const fg = parse(cs.color); if (!fg) continue;
   const bg = bgOf(e); const f = blend(fg, bg);
   const L1 = lum(f), L2 = lum(bg); const cr = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
   const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight)>=600;
   const need = 4.5;
   if (cr < need) out.push('LOW '+cr.toFixed(2)+' <'+need+' '+e.tagName+'.'+e.className+' "'+own.slice(0,24)+'"');
 }
 // 孤字换行：按块级祖先汇总所有字符的行位置，最后一行去掉标点后只剩 ≤1 个字就报
 const blocks = new Map();
 const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
 const blockOf = n => { let e = n.parentElement; while (e && getComputedStyle(e).display.startsWith('inline')) e = e.parentElement; return e; };
 for (let n; (n = tw.nextNode());) {
   if (!n.textContent.trim()) continue;
   const b = blockOf(n); if (!b || b.closest('svg')) continue;
   if (!blocks.has(b)) blocks.set(b, []);
   const arr = blocks.get(b), rg = document.createRange();
   for (let i = 0; i < n.textContent.length; i++) {
     const ch = n.textContent[i]; if (/\s/.test(ch)) continue;
     rg.setStart(n, i); rg.setEnd(n, i + 1);
     const rs = rg.getClientRects(); if (!rs.length) continue;
     arr.push([Math.round(rs[0].top + rs[0].height / 2), ch]);
   }
 }
 for (const [b, arr] of blocks) {
   if (arr.length < 4) continue;
   const lines = [];
   for (const [y, ch] of arr) { const L = lines.find(l => Math.abs(l.y - y) < 6); if (L) L.t += ch; else lines.push({y, t: ch}); }
   if (lines.length < 2) continue;
   lines.sort((a, c) => a.y - c.y);
   const last = lines[lines.length - 1].t.replace(/[。，、？！：；）」』”’…·.,?!:;)\]›>\-—]/g, '');
   const prev = lines[lines.length - 2].t;
   if (last.length <= 1 && !/^[\u2190-\u21FF⌘↵]$/.test(last)) out.push('ORPHAN "' + prev.slice(-8) + ' / ' + lines[lines.length - 1].t + '" in ' + b.tagName + '.' + b.className);
 }
 // 触控目标：按钮、圆钮、胶囊、行尾箭头 ≥44（只查手机）
 if (W < 500) for (const e of document.querySelectorAll('button,.glass,.chip,.qc,.go,.tb,.send,.mode,.newc,.seg a,.fseg a,.seen,.chv,.host,.step2,.showmore,.more,.sbar')) {
   const r = e.getBoundingClientRect(); if (!r.width) continue;
   if (r.height < 43.5 || r.width < 43.5) out.push('TAP<44 '+e.className+' '+Math.round(r.width)+'x'+Math.round(r.height)+' '+(e.innerText||'').trim().slice(0,12));
 }
 return out;
}"""
FONTS = ["Newsreader.ttf","NotoSerifSC.ttf","InstrumentSans.ttf","Archivo.ttf","MartianMono.ttf","Figtree.ttf","Onest.ttf","InterVariable.ttf", "NotoSansSC.ttf", "JBM-Regular.ttf", "Geist.ttf", "GeistMono.ttf", "SpaceGrotesk.ttf", "IBMPlexMono-Regular.ttf"]
CMAP = set()
for f in FONTS:
    CMAP |= set(TTFont(f"{FD}/{f}", fontNumber=0).getBestCmap().keys())
def tofu(name):
    s = open(f"{D}/html/{name}.html", encoding="utf-8").read()
    body = s[s.find("<body>"):]
    body = re.sub(r"<svg.*?</svg>", "", body, flags=re.S)
    text = H.unescape(re.sub(r"<[^>]+>", "", body))
    return sorted({c for c in text if not c.isspace() and ord(c) not in CMAP})
async def main(names):
    bad = 0
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for n in names:
            w, h = (390, 844) if n.startswith("m-") else ((1600, 2485) if n == "avatars" else (1440, 900))
            pg = await b.new_page(viewport={"width": w, "height": h})
            await pg.goto(f"file://{D}/html/{n}.html"); await pg.evaluate("document.fonts.ready")
            r = await pg.evaluate(JS)
            t = tofu(n)
            if re.search(r"\bangel\b", open(f"{D}/html/{n}.html", encoding="utf-8").read(), re.I): r.append("OLDNAME 出现旧名")
            if t: r.append("TOFU " + " ".join(f"{c}(U+{ord(c):04X})" for c in t))
            bad += bool(r)
            print(n, "OK" if not r else ""); [print("   ", x) for x in r[:14]]
            await pg.close()
        await b.close()
    print(f"\n{len(names)} 屏，{bad} 屏有问题")
names = sys.argv[1:] or sorted(os.path.basename(f)[:-5] for f in glob.glob(f"{D}/html/*.html") )
asyncio.run(main(names))
