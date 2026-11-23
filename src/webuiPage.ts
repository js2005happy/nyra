// src/webuiPage.ts — 网页 UI 的 HTML 模板（第 3 阶段，nyra/webui_page.py 对应）。
// 桌面单页 + 手机 /m 共用同一套 API；手机优先：审批卡、会话、任务、设置
// 四件事在手机上都能完成。页面本身不含 token：token 从 URL ?token= 或
// localStorage（设备 token）取，每次 API 调用都带 X-Nyra-Token 头。
// CSP 与 Python 版一致：default-src 'none'，只允许同源连接与内联脚本/样式。
import { inlineMarkSvg } from "./brandMark.ts";

/** 品牌位：方块头标志（src/brandMark.ts）+ 字标。 */
const BRAND_MARK = inlineMarkSvg("brand-mark");

export const CSP =
  "default-src 'none'; manifest-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const MANIFEST = {
  name: "Nyra",
  short_name: "Nyra",
  description: "Nyra — 本地 AI 助手（网页界面）",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#FFFFFF",
  theme_color: "#0B0B0C",
  icons: [
    { src: "/nyra-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/m/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export const MOBILE_MANIFEST = {
  name: "Nyra",
  short_name: "Nyra",
  description: "Nyra — 本地 AI 助手（手机）",
  start_url: "/m",
  scope: "/m",
  display: "standalone",
  background_color: "#FFFFFF",
  theme_color: "#0B0B0C",
  icons: [
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

const SHARED_CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#0B0B0C;background:#FFF}
a{color:#0B0B0C}button{font:inherit;padding:8px 14px;border:1px solid #0B0B0C;background:#0B0B0C;color:#FFF;border-radius:8px;cursor:pointer}
button.ghost{background:#FFF;color:#0B0B0C}button.danger{background:#B3261E;border-color:#B3261E}
button:disabled{opacity:.5;cursor:default}input,textarea,select{font:inherit;padding:8px;border:1px solid #C9C9C9;border-radius:8px;width:100%}
header{position:sticky;top:0;background:#FFF;border-bottom:1px solid #E5E5E5;padding:10px 16px;display:flex;gap:12px;align-items:center;z-index:10}
header h1{font-size:18px;margin:0;display:flex;align-items:center;gap:8px}header h1 .brand-mark{width:22px;height:22px;flex:none}header .sp{flex:1}nav{display:flex;gap:4px;flex-wrap:wrap}
nav button{background:none;color:#0B0B0C;border:1px solid transparent;padding:6px 10px}
nav button.on{border-color:#0B0B0C}
main{max-width:960px;margin:0 auto;padding:16px}
.card{border:1px solid #E5E5E5;border-radius:12px;padding:14px;margin:0 0 12px}
.muted{color:#666;font-size:13px}.msg{padding:8px 0;border-bottom:1px solid #F0F0F0;white-space:pre-wrap;word-break:break-word}
.msg .role{font-weight:700;font-size:13px;color:#666}.msg .tools{font-size:13px}
.approval{border:2px solid #B3261E;border-radius:12px;padding:14px;margin:0 0 12px;background:#FFF5F5}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>*{flex:0 0 auto}.row .grow{flex:1 1 auto}
.cost{font-size:13px;color:#444}.err{color:#B3261E}
@media (max-width:640px){main{padding:10px}header{padding:8px 10px}button{padding:10px 14px}}
`;

const SHARED_JS = `
function qs(){return new URLSearchParams(location.search)}
function token(){
  let t = qs().get('token');
  if (t) { try { localStorage.setItem('nyra-token', t); } catch(e){} return t; }
  try { return localStorage.getItem('nyra-token') || localStorage.getItem('nyra-device-token') || ''; } catch(e){ return ''; }
}
async function api(path, opts){
  opts = opts || {};
  const res = await fetch(path, { ...opts, headers: { 'X-Nyra-Token': token(), 'Content-Type': 'application/json', ...(opts.headers||{}) } });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch(e){}
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
const MODE_LABELS = { readonly: '只读', auto: '自动确认', full: '全权', creator: '创造模式' };
function renderModeSelector(info){
  const modes = info.modes || ['readonly', 'auto', 'full'];
  const sel = '<p><label>模式 <select onchange="setMode(this.value)">' + modes.map(m => '<option value="' + esc(m) + '"' + (m === info.mode ? ' selected' : '') + '>' + esc(MODE_LABELS[m] || m) + '</option>').join('') + '</select></label></p>';
  const card = info.mode === 'creator'
    ? '<div class="card"><b>创造模式</b><p class="muted">一句话描述想要的功能：先对齐 spec（存 .nyra/creator/），再生成插件，验证通过、你确认后才安装。插件默认最小权限，装完可在插件列表停用或卸载。试试：做个番茄钟 / 扫描 TODO。</p></div>'
    : '';
  return sel + card;
}
async function setMode(mode){
  await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode }) });
  if (typeof loadInfo === 'function') await loadInfo();
  else if (typeof loadSettings === 'function') await loadSettings();
}
function showTab(name){
  document.querySelectorAll('[data-tab]').forEach(el => { el.style.display = el.dataset.tab === name ? '' : 'none'; });
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === name));
}
// 调研报告第 3 项：上下文补齐（学 Claude Code）——网页端在现有状态行旁展示
// /api/sessions/:id 返回的 context breakdown（接口已备，见 gateway sessionView）；
// 无 live agent 时 context 为 null，这里只清空、不编造数字。
function renderContext(v){
  const el = document.getElementById('context');
  if (!el) return;
  const c = v.context;
  if (!c) { el.textContent = ''; return; }
  const pct = (n) => c.totalChars ? Math.round(n / c.totalChars * 100) + '%' : '0%';
  let line = '上下文：系统 ' + pct(c.system) + ' · 技能 ' + pct(c.skills) + ' · 历史 ' + pct(c.history) + ' · 工具结果 ' + pct(c.toolResults) + ' · 共 ' + c.totalChars + ' 字符';
  if (c.usedTokens !== null && c.usedTokens !== undefined) line += '（' + c.usedTokens + ' token，' + (c.estimated ? '估算' : '实报') + '）';
  el.textContent = line;
}
`;

const DESKTOP_JS = SHARED_JS + `
let currentSession = null, pollTimer = null, lastNext = 0;
async function loadSessions(){
  const data = await api('/api/sessions');
  const list = document.getElementById('sessions');
  list.innerHTML = '';
  (data.sessions || []).forEach(s => {
    const div = document.createElement('div'); div.className = 'card';
    div.innerHTML = '<div><b>' + esc(s.id) + '</b> <span class="muted">' + esc(s.preview || '') + ' · ' + s.count + ' 条 · ' + esc(s.mtime || '') + '</span></div>';
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '打开';
    b.onclick = () => openSession(s.id); div.appendChild(b); list.appendChild(div);
  });
  if (!data.sessions || !data.sessions.length) list.innerHTML = '<p class="muted">暂无历史会话，先新建一个。</p>';
}
async function newSession(){
  const data = await api('/api/sessions', { method: 'POST', body: '{}' });
  await openSession(data.id); await loadSessions();
}
async function openSession(id){
  currentSession = id; lastNext = 0;
  document.getElementById('chat-title').textContent = '会话 ' + id;
  await refreshSession();
  clearInterval(pollTimer); pollTimer = setInterval(refreshSession, 1500);
}
async function refreshSession(){
  if (!currentSession) return;
  const v = await api('/api/sessions/' + encodeURIComponent(currentSession) + '?since=' + lastNext);
  lastNext = v.next;
  const box = document.getElementById('messages');
  box.innerHTML = '';
  (v.messages || []).forEach((m, i) => {
    const div = document.createElement('div'); div.className = 'msg';
    div.innerHTML = '<div class="role">' + esc(m.role) + '</div><div>' + esc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + '</div>';
    const row = document.createElement('div'); row.className = 'row tools';
    [['回退到此', 'truncate'], ['编辑重发', 'edit'], ['Fork 新会话', 'fork']].forEach(([label, action]) => {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = label;
      b.onclick = () => doRewind(i, action); row.appendChild(b);
    });
    div.appendChild(row); box.appendChild(div);
  });
  const pend = document.getElementById('pending');
  if (v.pending) {
    pend.style.display = '';
    pend.innerHTML = '<b>等待审批：' + esc(v.pending.tool) + '</b><p>' + esc(v.pending.summary || '') + '</p>';
    const row = document.createElement('div'); row.className = 'row';
    [['通过', true, false], ['拒绝', false, false]].forEach(([label, ok, always]) => {
      const b = document.createElement('button'); b.textContent = label;
      b.onclick = () => decide(v.pending.id, ok, always); row.appendChild(b);
    });
    if (v.pending.always) {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '本会话始终允许';
      b.onclick = () => decide(v.pending.id, true, true); row.appendChild(b);
    }
    pend.appendChild(row);
  } else pend.style.display = 'none';
  document.getElementById('status').textContent = '状态：' + v.status + (v.error ? '（' + v.error + '）' : '');
  renderContext(v);
  renderApprovals(); renderArtifacts(v);
}
async function renderArtifacts(v){
  const box = document.getElementById('artifacts');
  const list = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/artifacts').catch(() => ({ artifacts: [] }));
  box.innerHTML = (list.artifacts || []).map(a => '<div>· ' + esc(a.title) + '（' + esc(a.kind) + '）</div>').join('') || '<p class="muted">暂无产物。</p>';
}
async function sendMsg(){
  const input = document.getElementById('input');
  const text = input.value.trim(); if (!text || !currentSession) return;
  input.value = '';
  await api('/api/sessions/' + encodeURIComponent(currentSession) + '/messages', { method: 'POST', body: JSON.stringify({ text }) });
  await refreshSession();
}
async function sendPlan(){
  const input = document.getElementById('input');
  const text = input.value.trim(); if (!text || !currentSession) return;
  input.value = '';
  await api('/api/sessions/' + encodeURIComponent(currentSession) + '/plan', { method: 'POST', body: JSON.stringify({ text }) });
  await refreshSession();
}
async function decide(id, approve, always){
  await api('/api/approvals/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ approve, always }) });
  await refreshSession();
}
async function renderApprovals(){
  const data = await api('/api/approvals').catch(() => ({ approvals: [] }));
  document.getElementById('approval-count').textContent = (data.approvals || []).length ? ('待审批 ' + data.approvals.length + ' 项') : '';
}
async function doRewind(index, action){
  if (!currentSession) return;
  const v = await api('/api/sessions/' + encodeURIComponent(currentSession));
  const msgs = v.messages || [];
  const target = msgs[index]; if (!target) return;
  // 回退按 conversations 行 id 走：先取行 id（同一会话按顺序对应）。
  const rows = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/history').catch(() => null);
  let messageId = null;
  if (rows && rows.messages && rows.messages[index]) messageId = rows.messages[index].id;
  if (messageId === null) { alert('该消息尚未记入对话存档，刷新后再试。'); return; }
  let text = null;
  if (action === 'edit') { text = prompt('编辑后重发：', typeof target.content === 'string' ? target.content : ''); if (text === null) return; }
  const res = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/rewind', { method: 'POST', body: JSON.stringify({ message_id: messageId, action, text }) });
  if (res.new_session_id) { await openSession(res.new_session_id); }
  await refreshSession(); await loadSessions();
}
async function loadSchedule(){
  const data = await api('/api/schedule');
  const box = document.getElementById('tasks');
  box.innerHTML = (data.tasks || []).map(t =>
    '<div class="card"><b>' + esc(t.name) + '</b> <span class="muted">' + esc(t.prompt || '') + ' · ' + (t.enabled === false ? '已停用' : '启用中') + '</span> ' +
    '<button class="ghost" onclick="toggleTask(\\'' + esc(t.name) + '\\')">' + (t.enabled === false ? '启用' : '停用') + '</button> ' +
    '<button class="ghost" onclick="removeTask(\\'' + esc(t.name) + '\\')">删除</button></div>').join('') || '<p class="muted">暂无定时任务。用 nyra schedule add 添加。</p>';
}
async function toggleTask(name){ await api('/api/schedule', { method: 'POST', body: JSON.stringify({ action: 'toggle', name }) }); await loadSchedule(); }
async function removeTask(name){ if (!confirm('删除定时任务 ' + name + '？')) return; await api('/api/schedule', { method: 'POST', body: JSON.stringify({ action: 'remove', name }) }); await loadSchedule(); }
async function loadInfo(){
  const info = await api('/api/info');
  document.getElementById('info').innerHTML =
    '<p>版本 ' + esc(info.version) + ' · 模式 ' + esc(info.mode) + ' · ' + esc(info.provider || '') + ' / ' + esc(info.model || '') + '</p>' +
    '<p class="muted">兜底链：' + esc((info.fallback_chain || []).join(' → ')) + '；评审模型：' + (info.smart_approvals && info.smart_approvals.reviewer_enabled ? '已开启' : '默认关闭') + '</p>' +
    '<p class="muted">MCP 工具 ' + (info.mcp_tools || 0) + ' 个；成本上限 ' + esc(info.mcp_cost ? String(info.mcp_cost.limit_usd ?? '未设') : '未设') + '，已用 $' + esc(info.mcp_cost ? String(info.mcp_cost.spent_usd ?? 0) : '0') + '</p>' +
    renderModeSelector(info);
  const mcp = await api('/api/mcp/tools').catch(() => ({ tools: [] }));
  document.getElementById('mcp-tools').innerHTML = (mcp.tools || []).map(t =>
    '<div class="card"><b>' + esc(t.name) + '</b> <span class="cost">' + esc(t.estimate_line || '') + '</span><p class="muted">' + esc(t.description || '') + '</p></div>').join('') || '<p class="muted">暂无 MCP 工具。</p>';
  const mem = await api('/api/memory?scope=global').catch(() => null);
  if (mem) document.getElementById('memory').textContent = mem.content || '（空）';
}
async function startPairing(){
  const data = await api('/api/pair/start', { method: 'POST', body: '{}' });
  document.getElementById('pair-info').innerHTML = '<p>配对码 <b>' + esc(data.code) + '</b>（' + Math.floor(data.expires_in / 60) + ' 分钟内有效，一次性）</p><p class="muted">手机打开 ' + esc(data.url || '') + ' 并输入配对码。</p>';
}
window.addEventListener('load', async () => {
  showTab('chat');
  try { await loadSessions(); await loadSchedule(); await loadInfo(); }
  catch (e) { document.getElementById('fatal').textContent = '加载失败：' + e.message + '（请用启动时终端打印的完整链接打开，链接里含 token）'; }
});
`;

export const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nyra</title><link rel="manifest" href="/manifest.json">
<style>${SHARED_CSS}</style></head><body>
<header><h1>${BRAND_MARK}Nyra</h1><span id="approval-count" class="err"></span><span class="sp"></span>
<nav>
<button data-nav="chat" onclick="showTab('chat')">会话</button>
<button data-nav="tasks" onclick="showTab('tasks');loadSchedule()">任务</button>
<button data-nav="settings" onclick="showTab('settings');loadInfo()">设置</button>
</nav></header>
<main>
<p id="fatal" class="err"></p>
<section data-tab="chat">
<div class="row"><button onclick="newSession()">＋ 新会话</button><span id="chat-title" class="muted">未选会话</span><span id="status" class="muted"></span></div>
<div class="row"><span id="context" class="muted"></span></div>
<div id="sessions"></div>
<div id="pending" class="approval" style="display:none"></div>
<div id="messages"></div>
<div class="row"><textarea id="input" rows="2" class="grow" placeholder="输入任务…"></textarea></div>
<div class="row" style="margin-top:8px"><button onclick="sendMsg()">发送</button><button class="ghost" onclick="sendPlan()">只做计划（不执行）</button></div>
<h3>产物</h3><div id="artifacts"><p class="muted">暂无产物。</p></div>
</section>
<section data-tab="tasks" style="display:none"><h2>定时任务</h2><div id="tasks"></div>
<p class="muted">网页端新建定时任务暂缓开放（等任务队列合并后恢复）；请用 nyra schedule add 命令添加。</p></section>
<section data-tab="settings" style="display:none"><h2>设置</h2><div id="info"></div>
<h3>MCP 工具与成本</h3><div id="mcp-tools"></div>
<h3>全局记忆</h3><pre id="memory" class="card" style="white-space:pre-wrap"></pre>
<h3>手机配对</h3><div class="row"><button class="ghost" onclick="startPairing()">连接手机（生成配对码）</button></div><div id="pair-info"></div>
</section>
</main>
<script>${DESKTOP_JS}</script>
</body></html>`;

const MOBILE_JS = SHARED_JS + `
let currentSession = null, lastNext = 0, pollTimer = null;
async function pair(){
  const code = document.getElementById('pair-code').value.trim();
  if (!code) return;
  const data = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: '手机' }) }).then(r => r.json());
  if (data.token) {
    try { localStorage.setItem('nyra-device-token', data.token); } catch(e){}
    document.getElementById('pair-box').style.display = 'none';
    await boot();
  } else alert('配对失败：' + (data.error || '未知错误'));
}
async function boot(){
  await loadSessions(); await renderApprovals();
}
async function loadSessions(){
  const data = await api('/api/sessions');
  const list = document.getElementById('sessions');
  list.innerHTML = '';
  (data.sessions || []).forEach(s => {
    const b = document.createElement('button'); b.className = 'ghost'; b.style.margin = '4px 4px 4px 0';
    b.textContent = s.id + '（' + s.count + '）';
    b.onclick = () => openSession(s.id); list.appendChild(b);
  });
}
async function newSession(){
  const data = await api('/api/sessions', { method: 'POST', body: '{}' });
  await openSession(data.id); await loadSessions();
}
async function openSession(id){
  currentSession = id; lastNext = 0;
  document.getElementById('chat-title').textContent = '会话 ' + id;
  await refreshSession();
  clearInterval(pollTimer); pollTimer = setInterval(refreshSession, 2000);
}
async function refreshSession(){
  if (!currentSession) return;
  const v = await api('/api/sessions/' + encodeURIComponent(currentSession) + '?since=' + lastNext);
  lastNext = v.next;
  const box = document.getElementById('messages');
  box.innerHTML = '';
  (v.messages || []).forEach((m, i) => {
    const div = document.createElement('div'); div.className = 'msg';
    div.innerHTML = '<div class="role">' + esc(m.role) + '</div><div>' + esc(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) + '</div>';
    // 手机端与桌面端一致：每条消息都可回退 / 编辑重发 / Fork（第 3 阶段 /rewind 三端一致）。
    const row = document.createElement('div'); row.className = 'row tools';
    [['回退到此', 'truncate'], ['编辑重发', 'edit'], ['Fork 新会话', 'fork']].forEach(([label, action]) => {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = label;
      b.onclick = () => doRewind(i, action); row.appendChild(b);
    });
    div.appendChild(row); box.appendChild(div);
  });
  const pend = document.getElementById('pending');
  if (v.pending) {
    pend.style.display = '';
    pend.innerHTML = '<b>等待审批：' + esc(v.pending.tool) + '</b><p>' + esc(v.pending.summary || '') + '</p>';
    const row = document.createElement('div'); row.className = 'row';
    [['通过', true, false], ['拒绝', false, false]].forEach(([label, ok, always]) => {
      const b = document.createElement('button'); b.textContent = label;
      b.onclick = () => decide(v.pending.id, ok, always); row.appendChild(b);
    });
    if (v.pending.always) {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '本会话始终允许';
      b.onclick = () => decide(v.pending.id, true, true); row.appendChild(b);
    }
    pend.appendChild(row);
  } else pend.style.display = 'none';
  document.getElementById('status').textContent = '状态：' + v.status + (v.error ? '（' + v.error + '）' : '');
  renderContext(v);
  await renderApprovals();
}
async function sendMsg(){
  const input = document.getElementById('input');
  const text = input.value.trim(); if (!text || !currentSession) return;
  input.value = '';
  await api('/api/sessions/' + encodeURIComponent(currentSession) + '/messages', { method: 'POST', body: JSON.stringify({ text }) });
  await refreshSession();
}
async function decide(id, approve, always){
  await api('/api/approvals/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ approve, always }) });
  await refreshSession();
}

async function doRewind(index, action){
  if (!currentSession) return;
  const v = await api('/api/sessions/' + encodeURIComponent(currentSession));
  const msgs = v.messages || [];
  const target = msgs[index]; if (!target) return;
  // 回退按 conversations 行 id 走：先取行 id（同一会话按顺序对应，与桌面页同一份实现）。
  const rows = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/history').catch(() => null);
  let messageId = null;
  if (rows && rows.messages && rows.messages[index]) messageId = rows.messages[index].id;
  if (messageId === null) { alert('该消息尚未记入对话存档，刷新后再试。'); return; }
  let text = null;
  if (action === 'edit') { text = prompt('编辑后重发：', typeof target.content === 'string' ? target.content : ''); if (text === null) return; }
  const res = await api('/api/sessions/' + encodeURIComponent(currentSession) + '/rewind', { method: 'POST', body: JSON.stringify({ message_id: messageId, action, text }) });
  if (res.new_session_id) { await openSession(res.new_session_id); }
  await refreshSession(); await loadSessions();
}
async function renderApprovals(){
  const data = await api('/api/approvals').catch(() => ({ approvals: [] }));
  const list = data.approvals || [];
  document.getElementById('approval-badge').textContent = list.length ? ('待审批 ' + list.length + ' 项') : '';
  const box = document.getElementById('approvals');
  box.innerHTML = '';
  list.forEach(a => {
    const div = document.createElement('div'); div.className = 'approval';
    div.innerHTML = '<b>' + esc(a.tool) + '</b><p>' + esc(a.summary || '') + '</p>';
    const row = document.createElement('div'); row.className = 'row';
    const ok = document.createElement('button'); ok.textContent = '通过';
    ok.onclick = () => decide(a.id, true, false); row.appendChild(ok);
    const no = document.createElement('button'); no.className = 'ghost'; no.textContent = '拒绝';
    no.onclick = () => decide(a.id, false, false); row.appendChild(no);
    if (a.always) {
      const al = document.createElement('button'); al.className = 'ghost'; al.textContent = '本会话始终允许';
      al.onclick = () => decide(a.id, true, true); row.appendChild(al);
    }
    div.appendChild(row); box.appendChild(div);
  });
}
async function loadTasks(){
  const data = await api('/api/schedule');
  document.getElementById('tasks').innerHTML = (data.tasks || []).map(t =>
    '<div class="card"><b>' + esc(t.name) + '</b> <span class="muted">' + (t.enabled === false ? '已停用' : '启用中') + '</span></div>').join('') || '<p class="muted">暂无定时任务。</p>';
}
async function loadSettings(){
  const info = await api('/api/info');
  document.getElementById('info').innerHTML =
    '<p>版本 ' + esc(info.version) + ' · 模式 ' + esc(info.mode) + ' · ' + esc(info.provider || '') + ' / ' + esc(info.model || '') + '</p>' +
    '<p class="muted">评审模型：' + (info.smart_approvals && info.smart_approvals.reviewer_enabled ? '已开启' : '默认关闭') + '；MCP 成本上限 ' + esc(info.mcp_cost ? String(info.mcp_cost.limit_usd ?? '未设') : '未设') + '</p>' +
    renderModeSelector(info);
}
window.addEventListener('load', async () => {
  showTab('chat');
  const hash = location.hash || '';
  if (hash.startsWith('#pair=')) {
    document.getElementById('pair-code').value = hash.slice(6);
    document.getElementById('pair-box').style.display = '';
  }
  if (token()) { document.getElementById('pair-box').style.display = 'none'; }
  try { if (token()) await boot(); } catch (e) { document.getElementById('fatal').textContent = '加载失败：' + e.message; }
});
`;

export const MOBILE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0B0C">
<title>Nyra 手机</title><link rel="manifest" href="/m/manifest.json">
<style>${SHARED_CSS}</style></head><body>
<header><h1>${BRAND_MARK}Nyra</h1><span id="approval-badge" class="err"></span><span class="sp"></span>
<nav>
<button data-nav="chat" onclick="showTab('chat')">会话</button>
<button data-nav="approvals" onclick="showTab('approvals');renderApprovals()">审批</button>
<button data-nav="tasks" onclick="showTab('tasks');loadTasks()">任务</button>
<button data-nav="settings" onclick="showTab('settings');loadSettings()">设置</button>
</nav></header>
<main>
<p id="fatal" class="err"></p>
<div id="pair-box" class="card"><b>连接电脑上的 Nyra</b>
<p class="muted">在电脑网页“设置 → 手机”里点“连接手机”，把 6 位配对码填在这里（5 分钟内有效，一次性）。</p>
<div class="row"><input id="pair-code" inputmode="numeric" placeholder="6 位配对码" class="grow"><button onclick="pair()">配对</button></div></div>
<section data-tab="chat">
<div class="row"><button onclick="newSession()">＋ 新会话</button><span id="chat-title" class="muted">未选会话</span><span id="status" class="muted"></span></div>
<div class="row"><span id="context" class="muted"></span></div>
<div id="sessions"></div>
<div id="pending" class="approval" style="display:none"></div>
<div id="messages"></div>
<div class="row"><textarea id="input" rows="2" class="grow" placeholder="输入任务…"></textarea></div>
<div class="row" style="margin-top:8px"><button onclick="sendMsg()">发送</button></div>
</section>
<section data-tab="approvals" style="display:none"><h2>审批</h2><div id="approvals"></div></section>
<section data-tab="tasks" style="display:none"><h2>定时任务</h2><div id="tasks"></div></section>
<section data-tab="settings" style="display:none"><h2>设置</h2><div id="info"></div></section>
</main>
<script>${MOBILE_JS}</script>
</body></html>`;

import { deflateSync } from "node:zlib";

/** 生成纯色 PNG（/m 图标与启动图用；不依赖任何图片库）。 */
function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { table?: Int32Array }).table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { table?: Int32Array }).table = table;
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function solidPng(width: number, height: number, color = "#FFFFFF"): Buffer {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0;
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
