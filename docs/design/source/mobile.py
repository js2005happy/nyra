from kit import *
MOB='''
.row{display:flex;gap:60px;margin-top:64px;position:relative;z-index:1}
.ph{width:390px;height:844px;border-radius:56px;background:#000;padding:11px;box-shadow:0 30px 90px rgba(0,0,0,.45),0 0 0 1px var(--line2)}
.ph.and{border-radius:42px;background:#1a1a1a}
.sc{width:368px;height:822px;border-radius:46px;overflow:hidden;background:var(--bg);color:var(--fg);position:relative;display:flex;flex-direction:column;font-size:15px}
.and .sc{border-radius:32px}
.sb{height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 30px 0 36px;font-weight:600;font-size:15px;flex:none;position:relative}
.isl{position:absolute;top:12px;left:50%;margin-left:-62px;width:124px;height:36px;border-radius:20px;background:#000}
.and .sb{height:38px;font-size:13px;padding:0 24px}
.cam{position:absolute;left:50%;top:12px;width:13px;height:13px;border-radius:50%;background:#000;margin-left:-6px}
.hd{display:flex;align-items:center;padding:6px 18px 8px;gap:12px}
.ib{width:36px;height:36px;border-radius:50%;background:var(--chip);display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--fg)}
.hd .tt{flex:1;text-align:center;font-weight:600}
.hd .tt small{display:block;font-weight:400;color:var(--mu);font-size:12px;margin-top:1px}
.pill{margin:0 14px 12px;border-radius:28px;background:var(--chip);padding:12px 12px 10px 18px;border:1px solid var(--line2)}
.pill .ph2{color:var(--mu);margin-bottom:12px}
.pill .r{display:flex;gap:6px;align-items:center}
.pk{height:30px;padding:0 11px;border-radius:999px;border:1px solid var(--line2);display:flex;align-items:center;gap:5px;font-size:12.5px}
.go{margin-left:auto;width:34px;height:34px;border-radius:50%;background:var(--btn);color:var(--btnfg);display:flex;align-items:center;justify-content:center}
.lst .it{display:flex;align-items:center;gap:12px;padding:12px 20px}
.lst .it b{font-weight:500;display:block}.lst .it small{color:var(--mu);font-size:13px}
.lst .it .t{margin-left:auto;color:var(--mu2);font-size:12px}
.lh{color:var(--mu);font-size:12.5px;padding:14px 20px 4px}
.feed{flex:1;padding:6px 16px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
.u{align-self:flex-end;background:var(--chip);padding:10px 14px;border-radius:20px;max-width:270px;line-height:1.4}
.p{line-height:1.5}
.lg{color:var(--mu);font-size:13.5px;display:flex;flex-direction:column;gap:6px}
.c{font-family:JBM;font-size:12px;color:var(--fg)}
.box{border:1px solid var(--line2);border-radius:18px;padding:12px 14px}
.bt{height:44px;border-radius:22px;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15px;flex:1}
.bt.p{background:var(--btn);color:var(--btnfg)}.bt.s{background:var(--chip)}
.code{font-family:JBM;font-size:11.5px;line-height:19px}
.ln{display:flex;white-space:pre;padding-right:8px}.ln .n{width:30px;text-align:right;padding-right:10px;color:var(--mu2);flex:none}
.ln.a{background:var(--addbg)}.ln.a .n{color:var(--add)}.ln.d{background:var(--rmbg)}.ln.d .n{color:var(--rm)}
.sheet{position:absolute;left:0;right:0;bottom:0;background:var(--bg);border-radius:28px 28px 0 0;padding:10px 18px 26px;box-shadow:0 -12px 40px rgba(0,0,0,.18)}
.grab{width:34px;height:4px;border-radius:2px;background:var(--line2);margin:0 auto 16px}
.dim{position:absolute;inset:0;background:rgba(0,0,0,.32)}
.nav{height:76px;border-top:1px solid var(--line);display:flex;justify-content:space-around;align-items:center;margin-top:auto;font-size:11.5px;color:var(--mu)}
.nav div{display:flex;flex-direction:column;align-items:center;gap:4px}.nav i{font-style:normal;font-size:19px;width:56px;height:30px;border-radius:15px;display:flex;align-items:center;justify-content:center}
.nav .on{color:var(--fg);font-weight:600}.nav .on i{background:var(--chip)}
.tg{margin-left:auto;width:48px;height:28px;border-radius:14px;background:var(--btn);position:relative;flex:none}.tg:after{content:"";position:absolute;right:3px;top:3px;width:22px;height:22px;border-radius:50%;background:var(--btnfg)}
.tg.off{background:var(--line2)}.tg.off:after{right:auto;left:3px;background:var(--bg)}
'''
def mpage(t,cap,inner):
    return f'<html><head><style>{css(t)}{MOB}</style></head><body><div class="stage"><div class="cap"><div class="mk">{LOGO}</div>{cap}</div>{inner}</div></body></html>'
IOSB='<div class="isl"></div><div class="sb"><span>9:41</span><span>▮▮▮ ▭</span></div>'
ios=f'''<div class="row">
<div class="ph"><div class="sc">{IOSB}
 <div class="hd"><span class="ib">☰</span><span class="tt"></span><span class="ib">✎</span></div>
 <div style="text-align:center;margin-top:120px"><div class="mk" style="width:46px;height:46px;border-radius:14px;margin:0 auto 18px;background:var(--fg)"><span style="display:flex;width:22px;height:22px">{LOGO}</span></div>
 <div style="font-size:26px;font-weight:600;letter-spacing:-.02em">Evening, Sheng</div><div style="color:var(--mu);margin-top:6px">Your Mac is online · 1 thread running</div></div>
 <div style="flex:1"></div>
 <div style="display:flex;gap:8px;padding:0 14px 12px;overflow:hidden;white-space:nowrap"><span class="pk">Explain this repo</span><span class="pk">Fix a bug</span><span class="pk">Research</span></div>
 <div class="pill"><div class="ph2">Ask Nyra anything</div><div class="r"><span class="pk">＋</span><span class="pk">◎ strong</span><span class="pk">▢ Mac</span><span class="go">↑</span></div></div>
</div></div>
<div class="ph"><div class="sc">{IOSB}
 <div class="hd"><span class="ib">‹</span><span class="tt">Fix login timeout<small>app · on your Mac</small></span><span class="ib">◫</span></div>
 <div class="feed">
  <div class="u">Login hangs 30s on slow networks. Fix it, diff first.</div>
  <div class="lg"><span>▾ Worked for 48s</span><span>◇ Read <span class="c">src/accounts.ts</span></span><span>✎ Edited 2 files <span style="color:var(--add)">+30</span> <span style="color:var(--rm)">−2</span></span></div>
  <div class="p">No timeout on the login call, so a stalled socket froze the UI. Added a 10 s timeout, one retry, and a regression test.</div>
  <div class="box"><div style="font-weight:600">Run tests?</div><div class="c" style="margin:6px 0 2px">bun test tests/node/test-accounts.test.ts</div><div style="color:var(--mu);font-size:13px">Shell · runs on your Mac</div>
   <div style="display:flex;gap:8px;margin-top:12px"><span class="bt s">Deny</span><span class="bt p">Run once</span></div></div>
 </div>
 <div class="pill" style="margin-top:8px"><div class="ph2">Follow up</div><div class="r"><span class="pk">＋</span><span class="pk">⛨ Ask first</span><span class="go">↑</span></div></div>
</div></div>
<div class="ph"><div class="sc">{IOSB}
 <div class="hd"><span class="ib">✕</span><span class="tt">Review changes<small>2 files · <span style="color:var(--add)">+30</span> <span style="color:var(--rm)">−2</span></small></span><span class="ib">⋯</span></div>
 <div style="display:flex;gap:6px;padding:4px 16px 12px"><span class="pk" style="background:var(--chip)">accounts.ts</span><span class="pk">test-accounts.test.ts</span></div>
 <div class="code">
  <div class="ln"><span class="n">41</span>payload = encode(user, pw)</div>
  <div class="ln d"><span class="n">42</span>- resp = http.post(url, data=payload)</div>
  <div class="ln a"><span class="n">42</span>+ for attempt in range(2):</div>
  <div class="ln a"><span class="n">43</span>+     try:</div>
  <div class="ln a"><span class="n">44</span>+         resp = http.post(</div>
  <div class="ln a"><span class="n">45</span>+             url, data=payload,</div>
  <div class="ln a"><span class="n">46</span>+             timeout=10)</div>
  <div class="ln a"><span class="n">47</span>+         break</div>
  <div class="ln a"><span class="n">48</span>+     except TimeoutError:</div>
  <div class="ln a"><span class="n">49</span>+         if attempt: raise</div>
 </div>
 <div class="box" style="margin:14px 16px 0;font-size:14px"><span style="color:var(--mu)">Comment on line 46</span><div style="margin-top:4px">Make the timeout configurable.</div></div>
 <div style="flex:1"></div>
 <div style="display:flex;gap:8px;padding:0 16px 30px"><span class="bt s">↺ Undo</span><span class="bt p">Commit</span></div>
</div></div>
</div>'''
open('ios.html','w').write(mpage(DARK,'Nyra for iOS <small>dark · remote for your desktop agent</small>',ios))
ANB='<div class="sb"><span>9:41</span><div class="cam"></div><span>▲ ▮▮ 87%</span></div>'
NAV=lambda k:''.join(f'<div class="{"on" if n==k else ""}"><i>{i}</i>{n}</div>' for i,n in [("✦","Threads"),("◷","Automations"),("❖","Skills"),("⚙","Settings")])
andr=f'''<div class="row">
<div class="ph and"><div class="sc">{ANB}
 <div class="hd" style="padding-top:10px"><span style="font-size:22px;font-weight:600;flex:1">Threads</span><span class="ib">⌕</span></div>
 <div class="lst">
  <div class="lh">app</div>
  <div class="it"><span class="spin" style="width:12px;height:12px"></span><div><b>Fix login timeout</b><small>Waiting for approval</small></div><span class="t">now</span></div>
  <div class="it"><span class="dot" style="background:#E3B341;width:8px;height:8px"></span><div><b>Flaky checkout test</b><small>Ready to review · +12 −4</small></div><span class="t">12m</span></div>
  <div class="it"><span class="dot" style="background:var(--line2);width:8px;height:8px"></span><div><b>Add dark mode tokens</b><small>Committed</small></div><span class="t">2h</span></div>
  <div class="lh">nyra</div>
  <div class="it"><span class="dot" style="background:var(--line2);width:8px;height:8px"></span><div><b>Upgrade MCP protocol</b><small>Plan · 7 steps</small></div><span class="t">1d</span></div>
  <div class="it"><span class="dot" style="background:var(--line2);width:8px;height:8px"></span><div><b>Migrate config to v2</b><small>Plan approved</small></div><span class="t">1d</span></div>
 </div>
 <div style="position:absolute;right:16px;bottom:92px;height:56px;border-radius:18px;background:var(--btn);color:var(--btnfg);display:flex;align-items:center;gap:8px;padding:0 20px;font-weight:600;box-shadow:0 6px 16px rgba(0,0,0,.2)">✎ New thread</div>
 <div class="nav">{NAV("Threads")}</div>
</div></div>
<div class="ph and"><div class="sc">{ANB}
 <div class="hd"><span class="ib">←</span><span class="tt" style="text-align:left">Fix login timeout<small>app · on your PC</small></span><span class="ib">⋮</span></div>
 <div class="feed">
  <div class="u">Login hangs 30s on slow networks. Fix it, diff first.</div>
  <div class="lg"><span>▸ Worked for 48s · 4 steps</span></div>
  <div class="p">No timeout on the login call. Added a 10 s timeout, one retry, and a test.</div>
 </div>
 <div class="dim"></div>
 <div class="sheet"><div class="grab"></div><div style="font-size:20px;font-weight:600">Allow this edit?</div><div style="color:var(--mu);font-size:13.5px;margin:4px 0 12px">write_file · src/accounts.ts · <span style="color:var(--add)">+6</span> <span style="color:var(--rm)">−2</span></div>
  <div class="code" style="border:1px solid var(--line2);border-radius:14px;overflow:hidden;padding:6px 0">
   <div class="ln d"><span class="n">42</span>- resp = http.post(url, data=p)</div>
   <div class="ln a"><span class="n">44</span>+ resp = http.post(url, data=p,</div>
   <div class="ln a"><span class="n">45</span>+                  timeout=10)</div></div>
  <div style="display:flex;gap:8px;margin-top:14px"><span class="bt s">Deny</span><span class="bt s">Always</span><span class="bt p">Allow once</span></div>
  <div style="text-align:center;color:var(--mu);font-size:12.5px;margin-top:12px">A checkpoint is saved first · /undo anytime</div></div>
</div></div>
<div class="ph and"><div class="sc">{ANB}
 <div class="hd" style="padding-top:10px"><span style="font-size:22px;font-weight:600;flex:1">Automations</span><span class="ib">＋</span></div>
 <div class="lst">
  <div class="it"><div><b>Clean Downloads folder</b><small>Daily 22:00 · next in 3 h</small></div><span class="tg"></span></div>
  <div class="it"><div><b>Summarise GitHub trending</b><small>Daily 09:00 · profile fast</small></div><span class="tg"></span></div>
  <div class="it"><div><b>Check MCP spec changes</b><small>Mondays 10:00</small></div><span class="tg"></span></div>
  <div class="it"><div><b>Weekly repo report</b><small>Paused</small></div><span class="tg off"></span></div>
  <div class="lh">Last run</div>
  <div class="it"><span style="color:var(--add)">✓</span><div><b>Summarise GitHub trending</b><small>Today 09:00 · 4 sources saved</small></div></div>
 </div>
 <div class="nav">{NAV("Automations")}</div>
</div></div>
</div>'''
open('android.html','w').write(mpage(LIGHT,'Nyra for Android <small>light · Material 3, monochrome</small>',andr))
