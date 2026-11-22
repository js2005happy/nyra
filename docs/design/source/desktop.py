from kit import *
SIDE='''<div class="side">
 <div class="si"><i>✎</i>New thread<span class="k">⌘N</span></div>
 <div class="si"><i>⌕</i>Search<span class="k">⌘K</span></div>
 <div class="si"><i>◷</i>Automations</div>
 <div class="si"><i>❖</i>Skills</div>
 <div class="si"><i>⌁</i>MCP servers</div>
 <div class="sh"><span>Projects</span><span>＋</span></div>
 <div class="pr"><span style="color:var(--mu)">▾</span>app</div>
 <div class="th on"><span class="spin"></span>Fix login timeout<span class="t">now</span></div>
 <div class="th"><span class="dot" style="background:#E3B341"></span>Flaky checkout test<span class="t">12m</span></div>
 <div class="th">Add dark mode tokens<span class="t">2h</span></div>
 <div class="pr"><span style="color:var(--mu)">▾</span>nyra</div>
 <div class="th">Upgrade MCP protocol<span class="t">1d</span></div>
 <div class="th">Migrate config to v2<span class="t">1d</span></div>
 <div class="pr"><span style="color:var(--mu)">▸</span>dotfiles</div>
 <div class="sh"><span>Chats</span></div>
 <div class="th" style="padding-left:10px">Summarise GitHub trending<span class="t">9:12</span></div>
 <div style="flex:1"></div>
 <div class="si"><i>⚙</i>Settings</div>
</div>'''
def mac():
    inner=f'''<div class="win">
<div class="top" style="padding-left:16px"><span style="display:flex;gap:8px;margin-right:14px"><i style="width:12px;height:12px;border-radius:50%;background:#FF5F57;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#FEBC2E;display:block"></i><i style="width:12px;height:12px;border-radius:50%;background:#28C840;display:block"></i></span>
<span class="crumb">app</span><span class="crumb">/</span><b>Fix login timeout</b><span style="flex:1"></span>
<div class="tbtn">⎇ fix/login-timeout</div><div class="tbtn">↗ Open in editor</div><div class="tbtn p">Commit</div></div>
<div class="body">{SIDE}
<div class="main"><div class="cols"><div class="conv"><div class="feed"><div class="col">
 <div class="u">Login hangs for 30s on slow networks. Find the cause and fix it. Show me the diff before anything runs.</div>
 <div class="log"><div class="h">▾ Worked for 48s</div>
  <div class="r">◇ Read <span class="c">src/accounts.ts</span></div>
  <div class="r">⌕ Searched <span class="c">"http.post"</span> · 3 matches</div>
  <div class="r">◫ Saved 2 sources to evidence</div>
  <div class="r">✎ Edited <span class="c">src/accounts.ts</span>, <span class="c">tests/node/test-accounts.test.ts</span></div></div>
 <div class="p">The login call in <code>src/accounts.ts</code> had no timeout, so a stalled socket blocked the UI thread. I added a 10 s timeout with one retry, moved the call onto the worker queue, and wrote a regression test that simulates a stalled socket.</div>
 <div class="files"><div class="fr"><span class="mono" style="font-size:12px">src/accounts.ts</span><span style="margin-left:auto" class="add">+6</span><span class="del">−2</span></div><div class="fr"><span class="mono" style="font-size:12px">tests/node/test-accounts.test.ts</span><span style="margin-left:auto" class="add">+24</span><span class="del">−0</span></div></div>
 <div class="files" style="border-color:var(--line2)"><div class="fr" style="gap:12px"><span>▷</span><div><div>Run <span class="mono" style="font-size:12px">bun test tests/node/test-accounts.test.ts</span></div><div style="color:var(--mu);font-size:12px;margin-top:2px">Shell needs your approval · runs in this checkout</div></div>
  <span style="margin-left:auto;display:flex;gap:6px"><span class="tbtn">Deny</span><span class="tbtn">Always</span><span class="tbtn p">Run once</span></span></div></div>
</div></div>
 <div class="comp"><div class="ph">Ask for follow-up changes</div><div class="rw"><span class="pk g">＋</span><span class="pk">◎ strong</span><span class="pk">⛨ Ask before writes</span><span class="pk">▢ Local</span><span class="pk g">/ commands</span><span class="send">↑</span></div></div>
</div>
<div class="review"><div class="rt"><span class="tab on">Diff</span><span class="tab">Plan</span><span class="tab">Evidence 2</span><span class="tab">Terminal</span><span style="margin-left:auto;color:var(--mu);font-size:12px">2 files · <span class="add">+30</span> <span class="del">−2</span></span></div>
 <div class="fh"><span>src/accounts.ts</span><span style="margin-left:auto" class="add">+6</span><span class="del">−2</span></div>
 <div class="code">
  <div class="ln"><span class="n">40</span>def login(user, password):</div>
  <div class="ln"><span class="n">41</span>    payload = encode(user, password)</div>
  <div class="ln d"><span class="n">42</span>-   resp = http.post(url, data=payload)</div>
  <div class="ln a"><span class="n">42</span>+   for attempt in range(2):</div>
  <div class="ln a"><span class="n">43</span>+       try:</div>
  <div class="ln a"><span class="n">44</span>+           resp = http.post(url, data=payload, timeout=10)</div>
  <div class="ln a"><span class="n">45</span>+           break</div>
  <div class="ln a"><span class="n">46</span>+       except TimeoutError:</div>
  <div class="ln a"><span class="n">47</span>+           if attempt: raise LoginTimeout()</div>
  <div class="cm"><b style="font-weight:600">You</b> <span style="color:var(--mu)">· line 44</span><div style="margin-top:4px">Make the timeout configurable from settings.</div></div>
  <div class="ln d"><span class="n">48</span>-   return parse(resp)</div>
  <div class="ln a"><span class="n">48</span>+   return parse(resp)  # off the UI thread now</div>
 </div>
 <div class="term">$ bun test tests/node/test-accounts.test.ts<br><span style="color:var(--mu2)">waiting for approval…</span></div>
</div></div>
<div class="status"><span>⎇ fix/login-timeout</span><span>↺ Checkpoint 3 · /undo</span><span>◔ Context 38%</span><span>12.5k in · 1.9k out</span><span style="margin-left:auto"><span class="dot" style="background:#3FB950"></span>MCP · 2 connected</span></div>
</div></div></div>'''
    return page(DARK,'Nyra for macOS <small>dark · threads by project · review pane</small>',inner)

def win():
    inner=f'''<div class="win" style="border-radius:8px">
<div class="top" style="padding-right:0;height:40px;background:var(--side)"><div class="mk" style="width:18px;height:18px;border-radius:5px">{LOGO}</div><b>Nyra</b><span style="flex:1"></span>
<span style="display:flex;color:var(--fg)"><span style="width:46px;text-align:center">—</span><span style="width:46px;text-align:center">☐</span><span style="width:46px;text-align:center">✕</span></span></div>
<div class="body">{SIDE.replace('<div class="th on"><span class="spin"></span>Fix login timeout<span class="t">now</span></div>','<div class="th"><span class="spin"></span>Fix login timeout<span class="t">now</span></div>').replace('⌘N','Ctrl N').replace('⌘K','Ctrl K')}
<div class="main"><div class="conv" style="justify-content:center;align-items:center">
 <div style="text-align:center;margin-top:-30px"><div class="mk" style="width:44px;height:44px;border-radius:12px;margin:0 auto 18px"><span style="display:flex;width:22px;height:22px">{LOGO}</span></div>
 <div style="font-size:28px;font-weight:600;letter-spacing:-.02em">What should we build in <span style="border-bottom:1.5px dashed var(--mu2)">app</span>?</div></div>
 <div class="comp" style="margin:28px auto 16px;width:720px"><div class="ph" style="padding-bottom:28px">Describe a task, or type / for commands</div><div class="rw"><span class="pk g">＋</span><span class="pk">◎ strong</span><span class="pk">⛨ Ask before writes</span><span class="pk">▢ Local</span><span class="pk">☰ Plan first</span><span class="send">↑</span></div></div>
 <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;width:720px">
  <div class="files" style="padding:12px 14px"><div style="font-weight:500">Explain this codebase</div><div style="color:var(--mu);font-size:12.5px;margin-top:3px">Read-only tour of the project</div></div>
  <div class="files" style="padding:12px 14px"><div style="font-weight:500">Find and fix a bug</div><div style="color:var(--mu);font-size:12.5px;margin-top:3px">Plan first, diff before writing</div></div>
  <div class="files" style="padding:12px 14px"><div style="font-weight:500">Research with sources</div><div style="color:var(--mu);font-size:12.5px;margin-top:3px">Every claim saved as evidence</div></div>
  <div class="files" style="padding:12px 14px"><div style="font-weight:500">Schedule a daily task</div><div style="color:var(--mu);font-size:12.5px;margin-top:3px">Runs on its own, reports back</div></div>
 </div>
 <div style="width:720px;margin-top:26px"><div style="color:var(--mu);font-size:12px;margin-bottom:8px">Automations</div>
  <div class="files"><div class="fr"><span class="dot" style="background:var(--add)"></span>Clean Downloads folder<span style="margin-left:auto;color:var(--mu)">Daily 22:00</span></div><div class="fr"><span class="dot" style="background:var(--add)"></span>Summarise GitHub trending<span style="margin-left:auto;color:var(--mu)">Daily 09:00</span></div><div class="fr"><span class="dot" style="background:var(--mu2)"></span>Weekly repo report<span style="margin-left:auto;color:var(--mu)">Paused</span></div></div></div>
</div>
<div class="status"><span>▢ Local · Windows 11</span><span>◎ Profile strong</span><span style="margin-left:auto"><span class="dot" style="background:var(--add)"></span>MCP · 2 connected</span></div>
</div></div></div>'''
    return page(LIGHT,'Nyra for Windows <small>light · new thread · automations</small>',inner)
open('mac.html','w').write(mac()); open('windows.html','w').write(win())
