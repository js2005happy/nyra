# build8.py — Nyra 设计稿 v8：会话 + 右侧抽屉、实时状态、新审批卡、自动化/技能确认卡、项目记忆文件列表、手机 m-16/m-17/m-20a。
# 结构参考见 ../v7/TURNSTONE-REFS.md；只借结构，视觉全部沿用 v6.2 / v6.3（颜色、字体、图标、团子头像、logo 不变）。
# 用法：python3 build8.py → html/*.html；python3 render8.py → *.png；python3 check8.py；python3 sheets8.py → overview.png
import os, sys
sys.path.insert(0, "/workspace/nyra-design/v5")
sys.path.insert(0, "/workspace/nyra-design/v6/out-6.2")
sys.path.insert(0, "/workspace/nyra-design/v6/out-6.3")
from icons import ic
from styles8 import FONTFACE, DESK_CSS, MOB_CSS
import build62 as B2      # 只读引用：工作区栏、侧栏、团子头像、logo
import build63 as B3      # 只读引用：手机状态栏、会话头部、首页行

D = os.path.dirname(os.path.abspath(__file__))
bot, srail, side = B2.bot, B2.srail, B2.side
SPIN = B2.SPIN
SAMPLE = '<span class="bdg line">示例数据</span>'
PROP = '<span class="prop">设计提议</span>'
SOON = '<span class="soon8">即将推出</span>'

def dpage(title, body):
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Nyra · {title}</title>
<style>{FONTFACE}{DESK_CSS}html,body{{width:1440px;height:900px;overflow:hidden}}</style></head><body>{body}</body></html>'''

def mpage(title, body):
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Nyra · {title}</title>
<style>{FONTFACE}{MOB_CSS}html,body{{width:390px;height:844px;overflow:hidden;background:#000}}</style></head><body>{body}</body></html>'''

def i(name, s=16): return ic(name, s)

# ---------------- 侧栏（复用 v6.2 行样式，只改第一行状态） ----------------
def side8(active=0, first=None):
    html = side(active)
    if first:
        old = B2.arow("登录卡顿", "web-app", "", "想改 client.ts，等你确认", on=(active == 0), felt=1, wait=True, state="wait")
        new = B2.arow("登录卡顿", "web-app", first[0], first[1], on=(active == 0), state=first[2])
        assert old in html
        html = html.replace(old, new)
    return html

# ---------------- 共用小件 ----------------
def mcap(full=False):
    if full:
        return f'<span class="mcap full" title="审批模式">{i("shield",14)}完全访问{i("chevd",14)}</span>'
    return f'<span class="mcap" title="审批模式">{i("shield",14)}写入前先问{i("chevd",14)}</span>'

def chead(title, state="wait", full=False, panel_on=False):
    return f'''<header class="chead row"><span class="ttl row">{bot("nyra", 20, state)}<b>{title}</b></span><span class="sp"></span>
    {mcap(full)}<span class="ib">{i("search")}</span><span class="ib">{i("undo")}</span><span class="ib{' on' if panel_on else ''}">{i("panel")}</span><span class="ib">{i("more")}</span></header>'''

def proc(n): return f'<span class="proc row"><span class="ok">{i("check")}</span>显示过程（{n} 步）{i("chev")}</span>'

def wrap(text, link=None, icon="check2"):
    l = f'<span class="lnk">{link}</span>' if link else ''
    return f'<div class="wrap8 row"><span class="ico">{i(icon)}</span><span>{text}</span>{l}</div>'

def rmeta(t, tok): return f'<div class="rmeta row"><span>用时 {t}</span><span>·</span><span>{tok} token</span><span class="cp">{i("copy",14)}</span></div>'

def live(step, sec, verb="写入中", avatar=False):
    a = bot("nyra", 22, "work") if avatar else ""
    return f'<div class="live row">{a}<span class="who">Nyra</span><span>·</span><span class="verb">{verb}：</span><span class="now">{step}</span><span>·</span><span class="sec">{sec}</span></div>'

def composer(full=False, ph="回复 Nyra…"):
    chip = f'<span class="cchip row" style="color:var(--warn);background:var(--warns)">{i("shield")}完全访问{i("chevd")}</span>' if full else f'<span class="cchip row">{i("shield")}写入前先问{i("chevd")}</span>'
    return f'''<div class="cwrap"><div class="composer"><div class="ph">{ph}</div>
    <div class="ctool row"><span class="cbtn">{i("plus")}</span>{chip}<span class="cchip row">{i("list")}先出计划</span><span class="sp"></span><span class="csend">{i("up")}</span></div></div></div>'''

def scope(rows, title="这一步能动到什么", extra=""):
    rs = "".join(f'<div class="sr"><span class="k">{i(ico,14)}{k}</span><span class="v{(" " + cls) if cls else ""}">{v}</span><span class="x">{x}</span></div>' for ico, k, v, x, cls in rows)
    return f'<div class="scope"><div class="sh">{title}{extra}</div>{rs}</div>'

SCOPE_EDIT = [("file", "文件", "web-app/src/auth/client.ts", '只这一个 · <span class="add">+4</span> <span class="del">−2</span>', "mono"),
              ("term", "命令", "不跑命令", "", "no"),
              ("globe", "联网", "不联网", "", "no"),
              ("lock", "范围", "沙箱里，受保护路径不碰", "", "no")]

def more_menu(style, peek=True):
    p = f'<hr><div class="mi">{i("panel")}<div><b>在面板里看改动</b><small>右侧抽屉，对话留在左边</small></div></div>' if peek else ''
    return f'''<div class="menu" style="{style}">
  <div class="mi on">{i("check2")}<div><b>本会话总是允许</b><small>这类改动这次对话里不再问</small></div></div>
  <div class="mi">{i("plus")}<div><b>记住为规则…</b><small>选本会话或本项目，设置里随时改</small></div></div>
  {p}
</div>'''

def appr_card(menu=False):
    m = more_menu("left:16px;bottom:56px") if menu else ''
    return f'''<section class="appr8">
  <div class="ah"><h3>我要给 login() 加 10 秒超时，改 1 个文件。</h3><span class="bdg warn">{SPIN}等你确认</span>
    <p>超时后自动重试一次。改之前先存检查点，随时能退回。</p></div>
  {scope(SCOPE_EDIT)}
  <div class="ft"><button class="btn sm more">更多{i("chevd")}</button><span class="peek">{i("code")}在面板里看 <span class="mono"><span class="add">+4</span> <span class="del">−2</span></span></span>
    <span class="acts"><button class="btn sm">不行，换个做法</button><button class="btn sm pri">允许一次</button></span></div>
  {m}
</section>'''

# ---------------- pc-33 会话（等你确认） ----------------
def pc33():
    conv = f'''<main class="conv">
  {chead("登录卡顿", "wait")}
  <div class="cscroll">
    <div class="tm">今天 14:28</div>
    <div class="ubub">登录在慢网络下要卡 30 秒，帮我找到原因修掉。</div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "idle")}</span><div class="grp">
      {proc(4)}
      <div class="bub">找到了：<code>login()</code> 发请求时没设超时，网络一慢就会一直等到系统默认的 30 秒。</div>
      {wrap("只读了 3 个文件、跑了 1 条测试，没改任何文件。")}
      {rmeta("38 秒", "12.4k")}
    </div></div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "wait")}</span><div class="grp">
      <div class="bub">复现写成了测试：@<span class="fref"><span class="fb">TS</span><span class="fn">client.test.ts</span></span>，在沙箱里跑会卡满 30 秒。</div>
      {appr_card(menu=False)}
    </div></div>
  </div>
  {composer()}
</main>'''
    return dpage("pc-33", f'<div class="app">{srail()}{side(0)}{conv}</div>')

# ---------------- pc-33b 会话（工作中 · 完全访问） ----------------
def pc33b():
    conv = f'''<main class="conv">
  {chead("登录卡顿", "work", full=True)}
  <div class="cscroll">
    <div class="tm">今天 14:31</div>
    <div class="ent" style="margin-top:0"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "done")}</span><div class="grp">
      {proc(6)}
      <div class="bub">改好了：<code>login()</code> 现在 10 秒超时，超时重试一次；auth 测试 13 条全部通过。</div>
      {wrap("改了 1 个文件，没推送，检查点 14:32 可退回。", "退回", icon="undo")}
      {rmeta("1 分 12 秒", "18.6k")}
    </div></div>
    <div class="rcpt row">{i("mem",14)}<span>记住了：改 auth 前先跑 auth 测试</span><span class="mono">MEMORY.md</span><span class="lnk">打开</span><span class="lnk">撤销</span>{PROP}</div>
    <div class="tm" style="margin-top:18px">14:36</div>
    <div class="ubub">session.ts 的刷新也一样，加上超时。</div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "work")}</span><div class="grp">
      <div class="bub">好，同样的做法：先在 <code>refresh()</code> 加 10 秒超时，再重跑 auth 测试。</div>
      {live("改 src/auth/session.ts", "12s")}
    </div></div>
  </div>
  <div class="fullbar row">{i("shield")}<span>完全访问：这次运行里写文件、跑命令都不再问你。</span><span class="lnk">切回写入前先问</span></div>
  {composer(full=True)}
</main>'''
    return dpage("pc-33b", f'<div class="app">{srail()}{side8(0, ("14:36", "正在改 session.ts…", "work"))}{conv}</div>')

# ---------------- pc-34/35/36 会话常驻左侧 + 右侧抽屉 ----------------
TABS = [("概览", ""), ("改动", '<i class="c">1</i>'), ("计划", ""), ("证据", ""), ("终端", '<i class="rd"></i>')]

def dseg(on): return '<div class="dseg">' + "".join(f'<a class="{"on" if t == on else ""}">{t}{x}</a>' for t, x in TABS) + '</div>'

def narrow_conv():
    return f'''<main class="conv nar">
  {chead("登录卡顿", "wait", panel_on=True)}
  <div class="cscroll">
    <div class="tm">今天 14:28</div>
    <div class="ubub">登录在慢网络下要卡 30 秒，帮我找到原因修掉。</div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "idle")}</span><div class="grp">
      {proc(4)}
      <div class="bub">找到了：<code>login()</code> 没设超时，网络一慢就等满 30 秒。</div>
      {wrap("只读了 3 个文件、跑了 1 条测试，没改文件。")}
      {rmeta("38 秒", "12.4k")}
    </div></div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "wait")}</span><div class="grp">
      <section class="slim">
        <div class="t"><b>我要给 login() 加 10 秒超时，改 1 个文件。</b><span class="bdg warn">{SPIN}等你确认</span></div>
        <div class="s">能动到：client.ts 一个文件 · 不跑命令 · 不联网 · 在沙箱里</div>
        <div class="f"><span class="here">{i("panel",14)}在右侧面板里看</span><span class="sp"></span><button class="btn sm">不行，换个做法</button><button class="btn sm pri">允许一次</button></div>
      </section>
    </div></div>
  </div>
  {composer()}
</main>'''

def drawer(tab, body, foot):
    return f'''<aside class="drawer">
  <div class="dh row"><b>面板</b><small>登录卡顿 · web-app</small><span class="sp"></span>{SAMPLE}<span class="ib">{i("expand")}</span><span class="ib">{i("x")}</span></div>
  {dseg(tab)}
  <div class="dbody">{body}</div>
  {foot}
</aside>'''

def appr_foot(menu=False):
    m = more_menu("left:16px;bottom:58px", peek=False) if menu else ''
    return f'''<div class="dfoot"><button class="btn sm more open">更多{i("chevd")}</button><small>和对话里的卡片是同一个请求</small>
  <span class="acts"><button class="btn sm">不行，换个做法</button><button class="btn sm pri">允许一次</button></span>{m}</div>'''

def pc34():
    body = f'''<div class="ch row"><span class="mono" style="font-size:14px;color:var(--t1)">src/auth/client.ts</span><span class="mono add" style="font-size:13px">+4</span><span class="mono del" style="font-size:13px">−2</span><span class="sp"></span><span class="bdg warn">等你确认</span></div>
<p class="lead">给 <code>login()</code> 的请求加 10 秒超时，超时后自动重试一次。</p>
<div class="bigdiff">
  <div class="hunk">@@ -35,6 +35,8 @@ export async function login</div>
  <div class="l"><b>35</b><b>35</b><i> </i><span>import {{ withTimeout, retryOnce }} from "../net"</span></div>
  <div class="l"><b>36</b><b>36</b><i> </i><span></span></div>
  <div class="l"><b>37</b><b>37</b><i> </i><span>export async function login(cred: Cred) {{</span></div>
  <div class="l r"><b>38</b><b></b><i>−</i><span>  const res = await fetch(url, opts)</span></div>
  <div class="l r"><b>39</b><b></b><i>−</i><span>  return parse(res)</span></div>
  <div class="l a"><b></b><b>38</b><i>+</i><span>  const res = await withTimeout(fetch(url, opts), 10_000)</span></div>
  <div class="l a"><b></b><b>39</b><i>+</i><span>    .catch(() =&gt; retryOnce(url, opts))</span></div>
  <div class="l a"><b></b><b>40</b><i>+</i><span>  if (!res.ok) throw new LoginError(res.status)</span></div>
  <div class="l a"><b></b><b>41</b><i>+</i><span>  return parse(res)</span></div>
  <div class="l"><b>40</b><b>42</b><i> </i><span>}}</span></div>
</div>
{scope(SCOPE_EDIT)}
<div class="ckpt row">{i("undo")}<span>检查点 14:32</span><small>改动前自动保存，/undo 也能退回</small><span class="sp"></span><button class="btn sm">退回到这里</button></div>'''
    return dpage("pc-34", f'<div class="app">{srail()}{side(0)}{narrow_conv()}{drawer("改动", body, appr_foot(menu=True))}</div>')

def pc35():
    body = f'''<div class="ch row"><b>修登录卡顿 · 5 步</b><span class="bdg">先出计划</span><span class="sp"></span><span style="font-size:13px;color:var(--t3)">第 3 / 5 步</span></div>
<ol class="plan">
  <li class="done"><span class="k">{i("check")}</span><div><b>顺着登录路径读代码</b><p>看了 client.ts、session.ts、net.ts</p></div><span class="bdg ok">完成</span></li>
  <li class="done"><span class="k">{i("check")}</span><div><b>在测试里复现</b><p>网络延迟调到 35 秒，login 卡到默认超时</p></div><span class="bdg ok">完成</span></li>
  <li class="cur"><span class="k">3</span><div><b>给 login() 加 10 秒超时</b><p>要改 src/auth/client.ts，在等你确认</p></div><span class="bdg warn">等你确认</span></li>
  <li><span class="k">4</span><div><b>重跑 auth 测试</b><p>在沙箱里跑，结果放进终端页</p></div><span class="bdg line">待做</span></li>
  <li><span class="k">5</span><div><b>写一句改动说明</b><p>附上测试结果作为证据</p></div><span class="bdg line">待做</span></li>
</ol>
<div class="ckpt row">{i("shield")}<span>写文件的那一步会停下来问你</span><small>审批模式：写入前先问</small></div>
<div class="ckpt row">{i("undo")}<span>检查点 14:31</span><small>改动前已存，退回后这之后的改动都会撤掉</small><span class="sp"></span><button class="btn sm">退回</button></div>'''
    foot = f'<div class="dfoot"><button class="btn sm">改计划</button><small>对计划有意见，直接在左边对话里说</small><span class="acts"><button class="btn sm pri">去确认第 3 步</button></span></div>'
    return dpage("pc-35", f'<div class="app">{srail()}{side(0)}{narrow_conv()}{drawer("计划", body, foot)}</div>')

def pc36():
    body = f'''<div class="ch row"><span class="mono" style="font-size:14px;color:var(--t1)">npm test -- auth</span><span class="bdg">沙箱</span><span class="sp"></span><span class="bdg bad">1 条失败</span><span style="font-size:13px;color:var(--t3)">31.1 秒</span></div>
<div class="tty"><span class="pr">❯</span> npm test -- auth
<span class="d">  auth/client.test.ts</span>
<span class="g">  ✓</span> logs in with valid credentials <span class="d">(42 ms)</span>
<span class="g">  ✓</span> rejects a wrong password <span class="d">(38 ms)</span>
<span class="g">  ✓</span> refreshes an expired session <span class="d">(51 ms)</span>
<span class="hl"><span class="r">  ✕</span> login on slow network <span class="d">(30 012 ms)</span></span><span class="d">  … 另外 9 条通过</span>

<span class="g">Tests:</span> 12 passed, <span class="r">1 failed</span>, 13 total
<span class="d">Time:  31.1 s</span></div>
<div class="fail"><div class="fh row"><span class="bdg bad">失败</span><b>login on slow network</b><span class="sp"></span><span class="mono" style="font-size:13px;color:var(--t3)">client.test.ts:58</span></div>
  <p class="mono" style="font-size:13px">Expected: resolves within 10 000 ms<br>Received: still pending after 30 000 ms</p>
  <div class="who row">{bot("nyra", 18, "wait")}Nyra</div>
  <p>这条就是你说的 30 秒卡顿：请求没设超时。<br>允许第 3 步的改动后，我会重跑这组测试。</p></div>'''
    foot = f'<div class="dfoot"><button class="btn sm">{i("refresh")}重跑</button><button class="btn sm">只看失败</button><small>命令都在沙箱里跑</small><span class="acts"><button class="btn sm pri">回到确认</button></span></div>'
    return dpage("pc-36", f'<div class="app">{srail()}{side(0)}{narrow_conv()}{drawer("终端", body, foot)}</div>')

# ---------------- pc-39 自动化 / 技能确认卡（设计提议） ----------------
def pc39():
    skill = f'''<section class="appr8">
  <div class="hd2"><span class="ac-kind">{i("spark")}</span><h3>保存为技能「发版检查」</h3>{PROP}<span class="bdg warn">{SPIN}等你确认</span></div>
  <div class="rule">以后你说<span class="slot">发版前检查一下</span>，我会按这 3 步走：</div>
  <ol class="steps8"><li>跑全部测试和类型检查</li><li>对照 CHANGELOG，看这次改动有没有漏写</li><li>列出还没合并的分支，交给你决定</li></ol>
  {scope([("file", "文件", "只读代码和 CHANGELOG", "", "no"), ("term", "命令", "pnpm test、pnpm typecheck", "在沙箱里", ""), ("shield", "改动", "不改文件；要改会另外来问你", "", "no")], title="运行时能动到什么")}
  <div class="ft"><button class="btn sm more">编辑</button><span class="acts"><button class="btn sm">不了</button><button class="btn sm pri">保存技能</button></span></div>
</section>'''
    auto = f'''<section class="appr8">
  <div class="hd2"><span class="ac-kind">{i("clock")}</span><h3>新建自动化「依赖检查」</h3>{PROP}<span class="bdg warn">{SPIN}等你确认</span></div>
  <div class="rule">每天 <span class="slot">08:00</span>，我会<span class="slot">检查 web-app 的依赖和安全公告</span>，<br>有要升级的就<span class="slot">在这个对话里告诉你</span><span class="edit">点方块可改</span></div>
  {scope([("file", "文件", "只读 package.json 和 lockfile", "", "no"), ("globe", "联网", "registry.npmjs.org", "只读", ""), ("shield", "模式", "只读：不改文件、不装包", "", "no")], title="运行时能动到什么")}
  <div class="note8 row">{i("info",14)}只在 Nyra 开着时运行。电脑关着也能跑（云电脑）{SOON}</div>
  <div class="ft"><button class="btn sm more">编辑</button><span class="acts"><button class="btn sm">不了</button><button class="btn sm pri">新建自动化</button></span></div>
</section>'''
    conv = f'''<main class="conv">
  {chead("发版前准备", "wait")}
  <div class="cscroll">
    <div class="tm">今天 16:05</div>
    <div class="ubub">以后发版前都按这几步检查一遍。另外每天早上帮我看看依赖有没有安全更新。</div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "wait")}</span><div class="grp">
      <div class="bub">好，这是两件会一直生效的事，分开各问你一次。你点确认之前，什么都不会保存。</div>
      <div class="pair">{skill}{auto}</div>
    </div></div>
  </div>
  {composer()}
</main>'''
    return dpage("pc-39", f'<div class="app">{srail()}{side(-1)}{conv}</div>')

# ---------------- pc-03 项目页（项目记忆 = 文件列表） ----------------
def pc03():
    rows = [("登录卡顿", "等你确认：改 client.ts（+4 −2）", "刚刚", "wait"),
            ("结账测试", "正在跑第 4 轮测试 · 6 分钟", "14:05", "work"),
            ("深色模式", "做完了：改了 6 个文件，没推送", "昨天", "done"),
            ("把配置读写改成原子写", "改了 2 个文件，还没跑验证", "周二", "done"),
            ("解释 provider 回退逻辑", "只读，没有改动", "上周", "idle")]
    plist = "".join(f'<div class="prow">{bot("nyra", 36, st)}<div style="min-width:0"><b>{t}</b><p>{p}</p></div><time>{tm}</time></div>' for t, p, tm, st in rows)
    def mf(icon, fn, fd, btn="打开"):
        return f'<div class="mf"><span class="fi">{i(icon,14)}</span><div style="min-width:0"><div class="fn">{fn}</div><div class="fd">{fd}</div></div><span class="tb">{btn}</span></div>'
    def me(text, src, new=False, undo=False):
        acts = '<span class="tb q">撤销</span>' if undo else '<span class="tb q">改</span>'
        return f'<div class="me{" new" if new else ""}"><div style="min-width:0"><p>{text}</p><small>{src}</small></div>{acts}</div>'
    mem = f'''<section class="pcard">
  <div class="h row">{i("mem")}<b>项目记忆</b><small>3 个文件</small><span class="sp"></span><span class="tb">{i("plus",14)}加一条</span></div>
  {mf("file", "AGENTS.md", "项目说明 · 仓库里的文件，每次对话都会读")}
  {mf("file", "~/.nyra/AGENTS.md", "全局说明 · 所有项目共用")}
  {mf("mem", "MEMORY.md", "记忆条目 14 条 · 最近 3 条在下面")}
  {me("改 auth 前先跑 auth 测试", "你在「登录卡顿」里说的 · 今天 14:33", new=True, undo=True)}
  {me("不用分号，字符串用双引号", "你在「深色模式」里说的 · 昨天")}
  {me("登录走 /api/session，会话 7 天过期", "Nyra 在「结账测试」里记下 · 周一")}
  <div class="pnote row">{PROP}<span>每条的来源标注、新写入时的回执和撤销</span></div>
</section>'''
    autos = f'''<section class="pcard"><div class="h row">{i("clock")}<b>这个项目的自动化</b></div>
  <div class="kv">依赖检查<b>每天 08:00</b></div><div class="kv">周报<b>周五 18:00</b></div></section>'''
    skills = f'''<section class="pcard"><div class="h row">{i("spark")}<b>常用技能</b></div>
  <div class="chips8"><span>修 bug</span><span>写测试</span><span>发版检查</span><span>核查式调研</span></div></section>'''
    main = f'''<main class="wpage">
  <div class="phd row"><span class="par">项目</span><span class="sep">{i("chev")}</span><span class="cur">web-app</span><span class="sp"></span>{SAMPLE}<button class="btn sm" style="margin-left:8px">{i("plus")}在这里开新对话</button></div>
  <div class="proj">
    <div class="pmain">
      <div class="phero row"><span class="fi">{i("folder",24)}</span><div><h1>web-app</h1><div class="sub">~/code/web-app · 12 个对话 · 改动都存了检查点</div></div></div>
      <div class="pfil row"><span class="f on">全部</span><span class="f">等你确认 <i>1</i></span><span class="f">进行中 <i>1</i></span><span class="f">已完成</span><span class="f">{i("search",14)}搜索这个项目</span></div>
      {plist}
    </div>
    <aside class="pside">{mem}{autos}{skills}</aside>
  </div>
</main>'''
    return dpage("pc-03", f'<div class="app">{srail()}{side(-1)}{main}</div>')

# ---------------- 手机 ----------------
status, chat_header = B3.status, B3.chat_header

def mchips(full=False):
    mode = f'<span class="mchip full">{i("shield",14)}完全访问{i("chevd",14)}</span>' if full else f'<span class="mchip">{i("shield",14)}写入前先问{i("chevd",14)}</span>'
    return f'<div class="mchips row"><span class="mchip">{i("cpu",14)}<span class="mono">deepseek-flash</span>{i("chevd",14)}</span>{mode}</div>'

def mcomp(ph="回复 Nyra…"):
    return f'<div class="comp row"><span class="tb">{i("plus",20)}</span><span class="ph">{ph}</span><span class="send">{i("up",20)}</span></div>'

def m16():
    card = f'''<div class="acard8">
  <div class="h row"><span class="bdg warn">{SPIN}等你确认</span></div>
  <b class="t1">我要给 login() 加 10 秒超时，<br>改 1 个文件。</b>
  <div class="scope"><div class="sh">这一步能动到什么</div>
    <div class="sr"><span class="k">文件</span><span class="v mono">client.ts</span><span class="open">看改动{i("chev",14)}</span></div>
    <div class="sr"><span class="k">其他</span><span class="v no">不跑命令 · 不联网 · 沙箱里</span><span class="x"></span></div></div>
  <div class="grid2"><button class="b44">不行，换个做法</button><button class="b44 pri">允许一次</button></div>
  <div class="morel">更多：本会话总是允许、记住为规则{i("chevd",16)}</div>
</div>'''
    body = f'''<div class="phone m">
  {status()}
  {chat_header()}
  <div class="clist">
    <div class="tm">今天 14:28 {B3.SAMPLE}</div>
    <div class="ubub">慢网络下登录卡 30 秒，帮我修掉。</div>
    <div class="ent"><span class="an">Nyra</span><span class="aa">{bot("nyra", 32, "wait")}</span><div class="grp">
      <span class="step2 row"><span class="ok">{i("check")}</span>显示过程（4 步）{i("chev")}</span>
      <div class="bub">找到了：login() 没设超时。</div>
      {card}
    </div></div>
  </div>
  <div class="qchips row"><span class="qc">改动 <span class="mono"><span class="add">+4</span> <span class="del">−2</span></span></span><span class="qc">计划 3/5</span><span class="qc badq">{i("term")}1 条失败</span></div>
  {mcomp()}
  {mchips()}
  <div class="safe"></div>
  <div class="hi"></div>
</div>'''
    return mpage("m-16 会话页", body)

def m16e():
    body = f'''<div class="phone m">
  {status()}
  <div class="tbar row"><span class="glass">{i("chevl",22)}</span>
    <span class="tpill row">{bot("nyra", 30, "idle")}<span class="pt"><b>新对话</b><small>Nyra · web-app</small></span></span>
    <span class="glass">{i("panel",20)}</span></div>
  <div class="empty">
    {bot("nyra", 72, "idle")}
    <h2>从手机发，Nyra 在你电脑上跑，<br>改东西前先问你</h2>
    <p>每次要写文件、跑命令，都会先在这里问你。</p>
    <span class="host row"><i class="dot ok"></i>MacBook 已连接 · web-app</span>
  </div>
  {mcomp("想让 Nyra 做什么？")}
  {mchips()}
  <div class="safe"></div>
  <div class="hi"></div>
</div>'''
    return mpage("m-16e 新对话空状态", body)

def m17():
    hrow = B3.hrow
    body = f'''<div class="phone">
  {status()}
  <div class="tbar row"><span class="glass">{i("list",22)}</span><span class="sp"></span>
    <span class="host row"><i class="dot ok"></i>MacBook 已连接</span></div>
  <div class="htitle row"><h1>对话</h1><small>Nyra</small><span class="sp"></span><span style="padding-bottom:8px">{B3.SAMPLE}</span></div>
  <div class="chips row"><span class="chip on">全部</span><span class="chip">web-app</span><span class="chip">docs</span><span class="chip">自动化</span></div>
  <div class="sech warnh row">{i("shield",14)}<span>等你确认 · 2</span><span class="sp"></span><span class="row" style="color:#dcdcdc;font-weight:500;gap:2px;height:44px;margin:-13px -6px -13px 0;padding:0 6px">全部{i("chev",14)}</span></div>
  <div class="pin">
    {hrow("登录卡顿", "web-app · 14:31", "", "等你确认：改 client.ts（+4 −2）", "wait", go=True)}
    {hrow("结账测试", "web-app · 14:20", "", "等你确认：运行 pnpm test:e2e", "wait", go=True)}
  </div>
  <div class="sech row"><span>进行中 · 1</span></div>
  <div class="list">{hrow("依赖升级", "web-app", "3 分钟", "正在跑第 2 轮测试 · 已过 3 个", "work")}</div>
  <div class="sech row"><span>今天</span></div>
  <div class="list">
    {hrow("深色模式", "web-app", "11:02", "跑完了：改了 6 个文件，没推送", "done")}
    {hrow("快速上手", "docs", "09:15", "初稿写好了，2 处要你看", "done")}
    {hrow("依赖检查", "自动化 · 08:00 按计划运行", "08:00", "没有要升级的包", "idle")}
  </div>
  <div class="fade"></div>
  <div class="hbot row"><span class="sbar row">{i("search",20)}<span>搜索对话</span></span><span class="newc">{i("pencil",22)}</span></div>
  <div class="hi"></div>
</div>'''
    return mpage("m-17 首页", body)

def qcard(conv, proj, t, title, rows):
    rs = "".join(f'<div class="sr"><span class="k">{k}</span><span class="v{(" " + c) if c else ""}">{v}</span><span class="x">{x}</span></div>' for k, v, x, c in rows)
    return f'''<div class="qcard8">
  <div class="who row">{bot("nyra", 24, "wait")}<b>{conv}</b><span>· {proj}</span><span class="sp"></span><span>{t}</span></div>
  <h3>{title}</h3>
  <div class="scope"><div class="sh">这一步能动到什么</div>{rs}</div>
  <div class="qrow8"><span class="mo">{i("more",20)}</span><button class="b44">不行，换个做法</button><button class="b44 pri">允许一次</button></div>
</div>'''

def m20a():
    body = f'''<div class="phone">
  {status()}
  <div class="tbar row"><span class="glass">{i("chevl",22)}</span><span class="sp"></span>{B3.SAMPLE}</div>
  <div class="htitle row" style="padding-bottom:2px"><h1>等你确认</h1><small>3 件 · 来自 3 个对话</small></div>
  <p style="padding:0 20px 10px;font-size:14px;line-height:20px;color:#979797">每件单独点，没有「全部允许」。··· 里是更多选项。</p>
  {qcard("登录卡顿", "web-app", "14:31", "我要给 login() 加超时，改 1 个文件", [("文件", '<span class="mono" style="font-size:13px">client.ts</span> · 不跑命令 · 不联网', '<span class="add">+4</span> <span class="del">−2</span>', "")])}
  {qcard("结账测试", "web-app", "14:20", "我要跑一遍结账的端到端测试", [("命令", '<span class="mono" style="font-size:13px">pnpm test:e2e</span> · 不改文件', "沙箱", "")])}
  {qcard("依赖检查", "自动化", "08:02", "我要联网查依赖的最新版本", [("联网", '<span class="mono" style="font-size:13px">registry.npmjs.org</span> · 不装包', "只读", "")])}
  <div class="hi"></div>
</div>'''
    return mpage("m-20a 等你确认队列", body)

SCREENS = [("pc-33", pc33), ("pc-33b", pc33b), ("pc-34", pc34), ("pc-35", pc35), ("pc-36", pc36), ("pc-39", pc39), ("pc-03", pc03),
           ("m-16", m16), ("m-16e", m16e), ("m-17", m17), ("m-20a", m20a)]

if __name__ == "__main__":
    os.makedirs(f"{D}/html", exist_ok=True)
    for n, f in SCREENS:
        open(f"{D}/html/{n}.html", "w").write(f())
    print("built v8:", [n for n, _ in SCREENS])
