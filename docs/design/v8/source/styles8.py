# styles8.py — Nyra v8：只在 v6.2（桌面）/ v6.3（手机）令牌之上加新组件，颜色、字体一律沿用，不新增色值。
import sys
sys.path.insert(0, "/workspace/nyra-design/v6/out-6.2")
sys.path.insert(0, "/workspace/nyra-design/v6/out-6.3")
from styles62 import FONTFACE, CSS as CSS62
from styles63 import CSS as CSS63

# ---------------- 共用（桌面 + 手机） ----------------
COMMON = '''
.prop{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,148,18,.45);color:var(--warn);font-size:12px;font-weight:600;line-height:16px;white-space:nowrap;flex:none}
.soon8{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--ring);color:var(--t3);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;flex:none}
/* 审批模式胶囊：普通档中性，完全访问用警示色描边 */
.mcap{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 9px;border-radius:999px;background:var(--hover);color:var(--t2);font-size:13px;font-weight:500;white-space:nowrap;flex:none}
.mcap.full{background:var(--warns);color:var(--warn);box-shadow:inset 0 0 0 1px rgba(255,148,18,.55)}
/* 工作中：一行实时状态 */
.live{gap:8px;height:32px;padding:0 12px 0 4px;font-size:14px;color:var(--t3);white-space:nowrap}
.live .who{color:var(--ny);font-weight:500}
.live .now{background:linear-gradient(90deg,var(--t2) 0%,var(--t2) 38%,var(--t1) 50%,var(--t2) 62%,var(--t2) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.live .sec{font-family:var(--mono);font-size:13px;color:var(--t3)}
.live .verb{color:var(--t2);margin-right:-8px}
/* 显示过程（收起） */
.proc{gap:6px;height:28px;padding:0 12px;color:var(--t3);font-size:14px;white-space:nowrap}
.proc .ok{color:var(--ok)}
/* 每轮收尾交代 + 用时 token */
.wrap8{gap:8px;padding:2px 12px 0;font-size:14px;line-height:20px;color:var(--t2)}
.wrap8 .ico{color:var(--t3);display:grid;place-items:center}
.wrap8 .lnk{color:var(--t1);font-weight:500;text-decoration:underline;text-decoration-color:var(--t4);text-underline-offset:3px}
.rmeta{gap:6px;padding:0 12px;font-size:13px;line-height:18px;color:var(--t3);white-space:nowrap}
.rmeta .cp{color:var(--t3);display:grid;place-items:center;margin-left:4px}
/* 范围框：这一步能动到什么 */
.scope{border-radius:12px;background:var(--raised);box-shadow:inset 0 0 0 1px var(--b);padding:10px 12px 8px}
.scope .sh{font-size:13px;font-weight:600;line-height:18px;color:var(--t2);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.scope .sr{display:grid;grid-template-columns:72px minmax(0,1fr) auto;column-gap:10px;align-items:center;min-height:28px;font-size:14px;line-height:20px}
.scope .sr .k{display:flex;align-items:center;gap:6px;color:var(--t3);white-space:nowrap}
.scope .sr .v{color:var(--t1);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scope .sr .v.no{color:var(--t2)}
.scope .sr .v.mono{font-size:13px}
.scope .sr .x{color:var(--t3);font-size:13px;white-space:nowrap}
.scope .sr+.sr{border-top:1px solid var(--line)}
.add{color:var(--ok)} .del{color:var(--bad)}
'''

# ---------------- 桌面 ----------------
DX = COMMON + '''
.chead .mcap{margin-right:4px}
.chead .ib.on{background:var(--active);color:var(--t1)}
.appr8{width:min(560px,100%);background:var(--surface);border-radius:22px;padding:16px 16px 12px;display:flex;flex-direction:column;gap:12px;margin:8px 0 6px;position:relative}
.appr8 .ah{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:2px}
.appr8 .ah h3{font-size:15.5px;font-weight:600;line-height:22px;letter-spacing:-.1px}
.appr8 .ah p{grid-column:1/-1;font-size:14px;line-height:20px;color:var(--t3)}
.appr8 .ah .bdg{grid-row:1;grid-column:2;border-radius:8px;gap:6px}
.appr8 .ft{display:flex;align-items:center;gap:8px}
.appr8 .ft .acts{display:flex;gap:8px;margin-left:auto}
.appr8 .ft .more{color:var(--t2);padding:0 10px 0 12px;background:transparent;box-shadow:inset 0 0 0 1px var(--ring)}
.appr8 .peek{height:32px;padding:0 12px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--t2);background:transparent;white-space:nowrap}
.appr8 .peek .mono{font-size:13px}
/* 更多菜单 */
.menu{position:absolute;z-index:5;width:288px;background:var(--raised);border-radius:14px;padding:6px;box-shadow:inset 0 0 0 1px var(--ring),0 12px 32px rgba(0,0,0,.55)}
.menu .mi{display:grid;grid-template-columns:22px 1fr;column-gap:8px;padding:8px 10px;border-radius:10px}
.menu .mi.on{background:var(--active)}
.menu .mi .ic{color:var(--t3);margin-top:2px}
.menu .mi b{display:block;font-size:14px;font-weight:500;line-height:20px;color:var(--t1)}
.menu .mi small{display:block;font-size:13px;line-height:18px;color:var(--t3)}
.menu hr{border:0;border-top:1px solid var(--line);margin:4px 6px}
/* 完全访问提示条（输入框上方） */
.fullbar{margin:0 6px 6px;padding:8px 12px;border-radius:12px;background:var(--warns);color:var(--warn);font-size:13.5px;line-height:20px;gap:8px}
.fullbar .lnk{color:var(--t1);text-decoration:underline;text-decoration-color:rgba(255,255,255,.35);text-underline-offset:3px;margin-left:auto;white-space:nowrap}
/* 记忆回执（设计提议） */
.rcpt{gap:8px;margin:10px 0 2px 44px;height:36px;padding:0 6px 0 12px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--line);font-size:13.5px;color:var(--t2);white-space:nowrap;align-self:flex-start}
.rcpt .ic{color:var(--t3)}
.rcpt .mono{font-size:12.5px;color:var(--t3)}
.rcpt .lnk{color:var(--t1);font-weight:500;padding:0 8px;height:28px;border-radius:999px;display:inline-flex;align-items:center;background:var(--hover)}

/* ===== 会话 + 右侧抽屉 ===== */
.conv.nar .cscroll{padding:8px 20px 20px 12px}
.conv.nar .bub,.conv.nar .ubub{max-width:100%}
.conv.nar .ubub{max-width:88%}
.drawer{width:600px;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--inset);min-width:0}
.dh{height:38px;flex:none;padding:0 10px 0 16px;gap:8px;border-bottom:1px solid var(--line)}
.dh b{font-size:15px;font-weight:600;white-space:nowrap}
.dh small{font-size:13px;color:var(--t3);white-space:nowrap}
.dseg{margin:12px 16px 0;height:40px;border-radius:12px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--b);display:grid;grid-template-columns:repeat(5,1fr);flex:none;padding:3px;gap:2px}
.dseg a{display:flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;font-size:14px;font-weight:500;color:var(--t3);white-space:nowrap;position:relative}
.dseg a.on{background:var(--active);color:var(--t1)}
.dseg a .c{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--warns);color:var(--warn);font-size:11.5px;font-weight:600;line-height:18px;text-align:center}
.dseg a .rd{width:6px;height:6px;border-radius:50%;background:var(--bad)}
.dbody{flex:1;min-height:0;overflow:hidden;padding:16px;display:flex;flex-direction:column;gap:12px;font-size:14.5px;line-height:22px;color:var(--t2)}
.dbody .ch{gap:10px}
.dbody .ch b{font-size:15px;font-weight:600;color:var(--t1)}
.dbody .lead{font-size:14.5px;line-height:22px;color:var(--t2)}
.dbody .lead code{font-family:var(--mono);font-size:13px;background:var(--active);padding:1px 5px;border-radius:5px}
.dbody .bigdiff{font-size:13px;line-height:23px}
.dbody .bigdiff .l{padding:0 12px}
.dbody .bigdiff .l b{width:24px}
.dbody .bigdiff .l b+b{margin-right:10px}
.dbody .tty{font-size:13px;line-height:22px}
.dfoot{flex:none;padding:12px 16px 14px;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;position:relative}
.dfoot .acts{margin-left:auto;display:flex;gap:8px}
.dfoot .more{color:var(--t2);padding:0 10px 0 12px;background:transparent;box-shadow:inset 0 0 0 1px var(--ring)}
.dfoot .more.open{background:var(--active);color:var(--t1)}
.dfoot small{font-size:13px;color:var(--t3);white-space:nowrap}
/* 会话里的紧凑卡：内容在面板里看 */
.slim{width:100%;background:var(--surface);border-radius:18px;padding:12px 12px 12px 14px;display:flex;flex-direction:column;gap:10px;margin:6px 0 4px;box-shadow:inset 0 0 0 1px rgba(255,148,18,.28)}
.slim .t{display:flex;align-items:flex-start;gap:10px}
.slim .t b{flex:1;font-size:15px;font-weight:600;line-height:22px}
.slim .s{font-size:13.5px;line-height:20px;color:var(--t3)}
.slim .f{display:flex;align-items:center;gap:8px}
.slim .f .sp{flex:1}
.slim .here{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--t2);white-space:nowrap}
.plan li{padding:12px 0}

/* ===== 自动化 / 技能确认卡（设计提议） ===== */
.rule{font-size:15px;line-height:26px;color:var(--t1)}
.rule .slot{display:inline;padding:2px 8px;border-radius:8px;background:var(--active);color:var(--t1);box-shadow:inset 0 0 0 1px var(--ring);white-space:nowrap}
.rule .edit{font-size:13px;color:var(--t3);margin-left:6px;white-space:nowrap}
.ac-kind{width:32px;height:32px;border-radius:10px;background:var(--active);color:var(--t2);display:grid;place-items:center;flex:none}
.appr8 .hd2{display:flex;align-items:center;gap:10px}
.appr8 .hd2 h3{font-size:15.5px;font-weight:600;line-height:22px;flex:1}
.appr8 .note8{gap:6px;font-size:13px;line-height:20px;color:var(--t3)}
.steps8{counter-reset:s;display:flex;flex-direction:column;gap:2px;font-size:14px;line-height:22px;color:var(--t2)}
.steps8 li{list-style:none;display:flex;gap:8px}
.steps8 li::before{counter-increment:s;content:counter(s);width:20px;height:20px;margin-top:1px;border-radius:50%;background:var(--active);color:var(--t3);font-size:11.5px;font-weight:600;line-height:20px;text-align:center;flex:none}

.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;width:100%;max-width:1000px;align-items:start}
.pair .appr8{width:auto;margin:8px 0 0}
/* ===== pc-03 项目页 ===== */
.proj{flex:1;min-height:0;display:flex;gap:28px;padding:28px 32px 24px}
.pmain{flex:1;min-width:0;display:flex;flex-direction:column}
.phero{gap:14px;align-items:center}
.phero .fi{width:48px;height:48px;border-radius:14px;background:var(--surface);display:grid;place-items:center;color:var(--t2);flex:none}
.phero h1{font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.3px}
.phero .sub{font-size:14px;line-height:20px;color:var(--t3);margin-top:2px}
.pfil{gap:8px;margin:22px 0 10px}
.pfil .f{height:32px;padding:0 14px;border-radius:999px;background:var(--surface);color:var(--t2);font-size:14px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pfil .f.on{background:var(--light);color:var(--onlight);font-weight:500}
.pfil .f i{color:var(--t3);font-size:13px}
.pfil .f.on i{color:#5a5a5a}
.prow{display:grid;grid-template-columns:40px minmax(0,1fr) auto;column-gap:12px;align-items:center;padding:12px 8px;border-bottom:1px solid var(--line)}
.prow b{display:block;font-size:15px;font-weight:500;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prow p{font-size:14px;line-height:20px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prow time{font-size:13px;color:var(--t3);white-space:nowrap}
.pside{width:420px;flex:none;display:flex;flex-direction:column;gap:14px}
.pcard{background:var(--surface);border-radius:18px;padding:14px 16px 12px}
.pcard .h{gap:8px;margin-bottom:8px}
.pcard .h b{font-size:15px;font-weight:600}
.pcard .h small{font-size:13px;color:var(--t3)}
.pcard .h .ic{color:var(--t3)}
.mf{display:grid;grid-template-columns:28px minmax(0,1fr) auto;column-gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--line)}
.mf .fi{width:28px;height:28px;border-radius:8px;background:var(--active);color:var(--t3);display:grid;place-items:center}
.mf .fn{font-family:var(--mono);font-size:13px;line-height:18px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mf .fd{font-size:13px;line-height:18px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;align-items:center;padding:7px 0 7px 38px;border-top:1px dashed var(--line)}
.me p{font-size:14px;line-height:20px;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me small{display:block;font-size:12.5px;line-height:17px;color:var(--t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.me.new p::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ny);margin-right:7px;vertical-align:2px}
.tb{height:28px;padding:0 10px;border-radius:999px;background:var(--hover);color:var(--t2);font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.tb.q{background:transparent;color:var(--t3);box-shadow:inset 0 0 0 1px var(--line)}
.pnote{gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:13px;line-height:18px;color:var(--t3)}
.kv{display:flex;align-items:center;padding:7px 0;border-top:1px solid var(--line);font-size:14px;color:var(--t2)}
.kv b{margin-left:auto;font-weight:500;color:var(--t1);font-size:14px}
.chips8{display:flex;flex-wrap:wrap;gap:6px}
.chips8 span{height:28px;padding:0 10px;border-radius:999px;background:var(--active);color:var(--t2);font-size:13px;display:inline-flex;align-items:center}
'''

# ---------------- 手机 ----------------
MX = COMMON + '''
.acard8{border-radius:22px;background:var(--surface);padding:14px 14px 12px;display:flex;flex-direction:column;gap:10px;box-shadow:inset 0 0 0 1px rgba(255,148,18,.28)}
.acard8 .h{gap:8px;align-items:flex-start}
.acard8 .h b{flex:1;font-size:16px;font-weight:600;line-height:22px}
.acard8 .t1{font-size:16px;font-weight:600;line-height:22px;margin-top:-4px}
.m .scope{padding:8px 12px 6px}
.m .scope .sr{grid-template-columns:52px minmax(0,1fr) auto;min-height:30px;font-size:14px}
.scope .open{color:var(--acct);font-size:14px;white-space:nowrap;display:inline-flex;align-items:center;gap:2px;height:30px}
.morel{height:44px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--t2);font-size:14.5px;font-weight:500}
.mchips{gap:8px;padding:8px 12px 0;flex:none}
.mchip{height:44px;padding:0 14px;border-radius:22px;display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:500;color:var(--t2);background:var(--surface);white-space:nowrap;flex:none}
.mchip.full{background:var(--warns);color:var(--warn);box-shadow:inset 0 0 0 1px rgba(255,148,18,.55)}
.mchip .mono{font-size:13px}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 32px 40px;text-align:center;gap:14px}
.empty h2{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.2px}
.empty p{font-size:14.5px;line-height:21px;color:var(--t3)}
.empty .host{margin-top:4px}
.qcard8{margin:0 12px;border-radius:22px;background:var(--surface);padding:12px 14px;display:flex;flex-direction:column;gap:10px;flex:none}
.qcard8+.qcard8{margin-top:10px}
.qcard8 .who{gap:8px;font-size:13.5px;line-height:18px;color:var(--t3)}
.qcard8 .who b{color:var(--t2);font-weight:500}
.qcard8 h3{font-size:16px;line-height:22px;font-weight:600}
.qcard8 .scope{padding:7px 12px 4px}
.qcard8 .scope .sh{margin-bottom:0}
.qcard8 .scope .sr{grid-template-columns:40px minmax(0,1fr) auto}
.qrow8{display:grid;grid-template-columns:44px 1fr 1fr;gap:8px;align-items:center}
.qrow8 .mo{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:var(--hover);color:var(--t2)}
.list .hrow2 .pv .w{color:var(--warn)}
'''

DESK_CSS = CSS62 + DX
MOB_CSS = CSS63 + MX
