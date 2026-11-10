"""面板页面的样式与脚本(自包含,零外部依赖)。

设计原则(2026-08-09 高密度工作台):用细分隔线和紧凑表格承载现场事实,
过程产物作为实现依据放在一级区域,不缩成侧栏附件。阶段轨道是离散节点,
不伪造百分比,当前阶段不旋转、不竖排。

版面优先级是契约的一部分,不是审美:
当前动作 → 需求与设计资产 → 执行记录/变更 → 质量事实 → 建议/流程细节。
文档与 diff 阅读层沿用原契约;一排绿灯也不能替代真实证据。
"""

CSS = r"""
:root{
  --bg:#e9e9e6;--paper:#fafaf8;--card:#fff;--line:#d8d9d4;
  --line2:#e8e8e4;--ink:#20211f;--dim:#6d706a;--faint:#969992;
  --ok:#247253;--ok-bg:#e7f3ed;--warn:#95601c;--warn-bg:#fff1d9;
  --bad:#a5483f;--bad-bg:#f9eae8;--run:#2e648e;--run-bg:#e8f1f7;
  --accent:#6654d9;--accent-bg:#eeeaff;--dark:#292a2d;--code-bg:#f1f1ef;
  /* 等宽字体链要照顾 Windows:原来 ui-monospace/SFMono/Menlo 全是 mac 的,
     Windows 上第一个命中 Consolas——对中文回退到宋体类,粗细不匀、看着毛糙。
     Cascadia 是 Win10 1909+ 与 Terminal 自带的编程字体,优先它;
     再退 Sarasa/JetBrains(开发机常有,中文等宽对齐),最后才是 Consolas。 */
  --mono:ui-monospace,SFMono-Regular,Menlo,"Cascadia Mono","Cascadia Code",
    "Sarasa Mono SC","JetBrains Mono","Source Han Mono SC",
    "Microsoft YaHei Mono",Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#121416;--paper:#1a1d20;--card:#202428;--line:#34383b;
    --line2:#2b2f32;--ink:#e7e9e6;--dim:#a4aaa3;--faint:#777e77;
    --ok:#55c08a;--ok-bg:#183126;--warn:#e0ad58;--warn-bg:#362a12;
    --bad:#ed8d83;--bad-bg:#3a1d1c;--run:#83b5e2;--run-bg:#172b3d;
    --accent:#a597ff;--accent-bg:#2d2948;--dark:#0f1113;--code-bg:#262a2d;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.workbench{max-width:none;margin:0;min-height:100vh;background:var(--paper);
  border:0}
#stale{background:var(--warn-bg);color:var(--warn);font-size:12px;
  padding:8px 22px;border-bottom:1px solid var(--warn)}
#live{background:var(--accent-bg);color:var(--accent);font-size:12px;
  padding:8px 22px;border-bottom:1px solid var(--accent)}
#live b{font-weight:700}
#age{color:var(--faint);margin-right:8px}

/* ── 紧凑页眉与阶段轨道 ── */
header{padding:18px 22px 14px;border-bottom:1px solid var(--line)}
.header-top{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}
.eyebrow{font:11.5px var(--mono);letter-spacing:.12em;color:var(--faint)}
h1{font-size:21px;line-height:1.2;margin:3px 0 0;font-weight:710}
.header-state{font:11.5px var(--mono);color:var(--faint);padding-top:3px}
.hd-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:5px;
  color:var(--dim);font:12px var(--mono)}
.phase-track{display:grid;grid-template-columns:repeat(7,1fr);margin-top:14px}
.phase-node{position:relative;text-align:center;color:var(--faint);font-size:11px;
  padding-top:18px;white-space:nowrap}
.phase-node:before{content:"";position:absolute;z-index:2;top:2px;
  left:calc(50% - 5px);width:8px;height:8px;border-radius:50%;
  background:var(--paper);border:2px solid #bfc1bb}
.phase-node:not(:last-child):after{content:"";position:absolute;z-index:1;top:7px;
  left:calc(50% + 6px);width:calc(100% - 12px);height:2px;background:var(--line)}
.phase-node.past{color:var(--dim)}
.phase-node.past:before{background:var(--dim);border-color:var(--dim)}
.phase-node.past:after{background:var(--dim)}
.phase-node.current{color:var(--accent);font-weight:700}
.phase-node.current:before{width:10px;height:10px;top:1px;left:calc(50% - 6px);
  background:var(--accent);border-color:var(--accent-bg);box-shadow:0 0 0 3px var(--accent-bg)}

/* ── 首屏事实与当前动作 ── */
.summary-grid{display:grid;grid-template-columns:1.35fr 1fr .75fr .6fr;
  background:var(--card);border-bottom:1px solid var(--line)}
.summary-item{padding:10px 14px;border-right:1px solid var(--line2);min-width:0}
.summary-item:last-child{border-right:0}
.summary-item span{display:block;color:var(--faint);font-size:10.5px;letter-spacing:.07em}
.summary-item b{display:block;margin-top:2px;font-size:13px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}.summary-item .mono{font:12px var(--mono)}
.current-action{margin:0;border-bottom:1px solid var(--line)}
.current-action>h2{display:none}
.action-card{padding:11px 16px;background:var(--card)}
/* 有事项时轻强调:浅紫底+紫左缘。整条变黑的旧样式视觉重量与信息量
   完全不成比例——两行字撑一条横贯全屏的黑带(实战反馈)。 */
.current-action.has .action-card{background:var(--accent-bg);
  border-left:3px solid var(--accent)}
.quiet{color:var(--dim);display:grid;
  grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:8px;font-size:13px}
.quiet .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex:none}
.quiet-label{color:var(--faint);font-size:11px;letter-spacing:.06em}
.quiet-step{color:var(--ink);font-size:13px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.quiet-note{color:var(--ok);font-size:11.5px;white-space:nowrap}
.current-action.has .ask-title{font-weight:700;font-size:14px}
.current-action.has .ask-sub{color:var(--dim);font-size:12px;margin:2px 0 5px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;
  font-size:12px;margin:6px 0;padding:7px 10px;background:var(--card);
  border-radius:6px}
.kv dt{color:var(--dim)}.kv dd{margin:0;font-family:var(--mono);word-break:break-all}
.current-action .paths{margin:4px 0}
.current-action .open{border:0;background:none;color:var(--accent);padding:0;
  cursor:pointer;font:inherit;font-family:var(--mono);
  border-bottom:1px solid var(--accent)}
.current-action .open:hover{opacity:.75}

/* ── 一级过程资产 ── */
.section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:9px 13px;background:var(--code-bg);border-bottom:1px solid var(--line)}
.section-head h2{font-size:11.5px;letter-spacing:.1em;margin:0;color:var(--dim)}
.section-head span{font:11px var(--mono);color:var(--faint)}
.asset-section{border-bottom:1px solid var(--line);background:var(--card)}
.asset-head{background:var(--accent-bg)}
.asset-head h2{color:var(--accent)}
.asset-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.asset{position:relative;display:grid;grid-template-columns:1fr auto;gap:3px 8px;
  min-width:0;padding:11px 13px;border-right:1px solid var(--line2);
  border-bottom:1px solid var(--line2)}
.asset:nth-child(4n){border-right:0}.asset-kind{grid-column:1/-1;color:var(--faint);
  font:10.5px var(--mono);letter-spacing:.07em}
.asset-open{min-width:0;border:0;background:none;padding:0;text-align:left;color:var(--ink);cursor:pointer}
.asset-open b{display:block;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.asset-open span{display:block;color:var(--faint);font:10.5px var(--mono);margin-top:2px}
.asset-open:hover b,.asset-raw:hover{color:var(--accent)}
.asset-raw{align-self:center;color:var(--faint);text-decoration:none}.asset.empty{display:block;color:var(--dim)}
.asset-chain{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:6px 11px;
  color:var(--dim);font-size:11px}.asset-chain b{color:var(--accent);font-weight:600}
.asset-chain i{font-style:normal;color:var(--faint)}.chain-empty{margin-left:auto;color:var(--faint)}

/* ── 主工作区 ── */
.workspace{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,.9fr)}
.workspace main{border-right:1px solid var(--line);min-width:0}
.panel-section{margin:0;border-bottom:1px solid var(--line)}
.history-table{background:var(--card)}
.history-row{display:grid;grid-template-columns:56px minmax(0,1fr) auto;gap:10px;
  align-items:center;padding:9px 12px;border-bottom:1px solid var(--line2)}
.history-row:last-child{border-bottom:0}.history-row time{font:11px var(--mono);color:var(--faint)}
.history-step{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.history-result{font:10.5px var(--mono);color:var(--faint);white-space:nowrap}
.history-row.current{background:var(--accent-bg);box-shadow:inset 3px 0 var(--accent)}
.history-row.current .history-result{color:var(--accent)}
.commit-list{background:var(--card)}
.commit{display:flex;gap:8px;align-items:baseline;padding:8px 12px;border-bottom:1px solid var(--line2);font-size:12px}
.commit code{font:11px var(--mono);color:var(--accent)}
.commit .t{margin-left:auto;color:var(--faint);font:10.5px var(--mono);white-space:nowrap}
.gtitle{display:flex;gap:8px;align-items:baseline;padding:9px 12px 4px;background:var(--paper)}
.gtitle b{font-size:12px}.gtitle span{color:var(--faint);font:10.5px var(--mono)}
.list>*{border-bottom:1px solid var(--line2)}
.chg .f{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:9px;
  align-items:center;padding:9px 12px;border:0;border-bottom:1px solid var(--line2);
  background:var(--card);text-align:left;color:var(--ink);width:100%;cursor:pointer}
.chg .f:hover .p,.chg .f:hover .go{color:var(--accent)}
.chg .f .p{font:11.5px var(--mono);word-break:break-all}.chg .f .p i{font-style:normal;color:var(--faint)}
.chg .f .n{font:10.5px var(--mono);white-space:nowrap}.chg .f .n .a{color:var(--ok)}
.chg .f .n .d{color:var(--bad)}.chg .f .go{color:var(--faint);font-size:10.5px;white-space:nowrap}
.bar{display:inline-flex;height:7px;width:40px;border-radius:2px;overflow:hidden;background:var(--line)}
.bar i{display:block;height:100%}.bar .g{background:var(--ok)}.bar .r{background:var(--bad)}

/* ── 质量、建议、流程细节 ── */
.row{display:grid;grid-template-columns:96px 86px minmax(0,1fr);gap:9px;
  align-items:baseline;padding:9px 12px;background:var(--card)}
.row .name{font-weight:600;font-size:12px}.row .why{color:var(--dim);font-size:11px}
.tag{display:inline-block;font:700 10.5px var(--mono);padding:2px 6px;border-radius:3px;
  white-space:nowrap;font-style:normal}.t-ok{color:var(--ok);background:var(--ok-bg)}
.t-deg{color:var(--warn);background:var(--warn-bg)}.t-bad{color:var(--bad);background:var(--bad-bg)}
.t-run{color:var(--run);background:var(--run-bg)}
.deg-note{padding:9px 12px;background:var(--warn-bg);color:var(--warn);font-size:11px;
  border-left:3px solid var(--warn)}
.fineline{display:flex;align-items:center;gap:8px;padding:9px 12px;color:var(--dim);font-size:11px}
.fineline .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex:none}
.adv{list-style:none;margin:0;padding:0;background:var(--card)}
.adv li{font-size:11.5px;padding:9px 12px;border-bottom:1px solid var(--line2)}
.adv code{font:10.5px var(--mono);color:var(--warn)}
.prog .line{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;padding:10px 12px;
  background:var(--card);color:var(--dim);font-size:11px}
.prog b{font-family:var(--mono);font-weight:600;color:var(--ink)}.prog .cur{color:var(--accent)}

/* ── 低频内容与页脚 ── */
.low-frequency{display:flex;gap:20px;padding:10px 13px;border-top:1px solid var(--line)}
details.note{font-size:11.5px;color:var(--dim)}details.note summary{cursor:pointer;color:var(--faint);user-select:none}
details.note summary:hover{color:var(--accent)}details.note ul{margin:6px 0 0;padding-left:18px}
details.note li{margin:2px 0}.paths{list-style:none;margin:5px 0 0;padding:0}
.paths li{font:10.5px var(--mono);padding:2px 0}.paths a{color:var(--dim);text-decoration:none}
.paths a:hover{color:var(--accent)}
/* 待裁决卡片里"点开就地阅读"的文档按钮:链接样式,不能长成系统灰按钮 */
.paths button{background:none;border:0;padding:0;cursor:pointer;font:inherit;
  font-family:var(--mono);font-size:12px;color:var(--accent);
  border-bottom:1px solid var(--accent)}
.paths button:hover{opacity:.75}
footer{display:flex;justify-content:space-between;padding:9px 13px;border-top:1px solid var(--line);
  background:var(--code-bg);color:var(--faint);font-size:10.5px}footer code{font-family:var(--mono)}

@media (max-width:860px){
  .workbench{margin:0;border-left:0;border-right:0}.header-state{display:none}
  .phase-node{font-size:10px}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .summary-item:nth-child(2n){border-right:0}.summary-item:nth-child(n+3){border-top:1px solid var(--line2)}
  .quiet{grid-template-columns:auto auto minmax(0,1fr)}.quiet-note{grid-column:2/-1}
  .asset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.asset:nth-child(2n){border-right:0}
  .workspace{grid-template-columns:minmax(0,1fr)}.workspace main{border-right:0}
  .workspace aside{border-top:1px solid var(--line)}.low-frequency{display:block}
}

/* ── 阅读层(文档/diff 弹层) ── */
#viewer{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;
  display:none;padding:24px 16px;overflow:auto}
#viewer.on{display:block}
.vbox{max-width:min(1200px,94vw);margin:0 auto;background:var(--card);
  border:1px solid var(--line);border-radius:12px;
  box-shadow:0 16px 48px rgba(0,0,0,.25);
  display:flex;flex-direction:column;max-height:calc(100vh - 48px)}
/* 标题栏与标签行固定,滚动只发生在内容区内部——sticky 会让正文从
   弹层顶部内边距那条缝里穿到标题栏上方(实测截图确认过)。 */
.vbar{flex:none;background:var(--card);
  border-bottom:1px solid var(--line);border-radius:12px 12px 0 0;
  padding:11px 18px;display:flex;flex-wrap:wrap;align-items:center;
  gap:8px 12px}
.vbar .vt{font-weight:600;font-size:14px}
.vbar .vp{font-family:var(--mono);font-size:11px;color:var(--faint);
  word-break:break-all}
.vbar .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.vbar a,.vbar button{font-size:12px;font-family:inherit;color:var(--dim);
  background:var(--bg);border:1px solid var(--line);border-radius:7px;
  padding:4px 11px;text-decoration:none;cursor:pointer;white-space:nowrap}
.vbar a:hover,.vbar button:hover{color:var(--accent);border-color:var(--accent)}
.vtabs{flex:none;display:flex;flex-wrap:wrap;gap:5px;padding:10px 18px}
.vtabs button{font:inherit;font-size:11.5px;background:var(--bg);
  color:var(--dim);border:1px solid var(--line);border-radius:20px;
  padding:2px 11px;cursor:pointer}
.vtabs button.on{color:var(--accent);border-color:var(--accent);font-weight:600}
.pane{display:none}
.pane.on{display:block;flex:1 1 auto;min-height:0;overflow-y:auto}

/* ── 文档正文 ── */
.md{padding:8px 28px 32px;font-size:14.5px;line-height:1.74}
.md h1{font-size:21px;margin:22px 0 10px;padding-bottom:6px;
  border-bottom:1px solid var(--line)}
.md h2{font-size:17.5px;color:var(--ink);margin:26px 0 9px;letter-spacing:0;
  font-weight:650;padding-bottom:5px;border-bottom:1px solid var(--line)}
.md h3{font-size:15px;margin:20px 0 7px}
.md h4,.md h5,.md h6{font-size:13.5px;margin:16px 0 6px;color:var(--dim)}
.md p{margin:9px 0}
.md ul,.md ol{margin:8px 0;padding-left:24px}
.md li{margin:3px 0}
.md code{font-family:var(--mono);font-size:12.5px;background:var(--code-bg);
  padding:1px 5px;border-radius:4px}
.md hr{border:0;border-top:1px solid var(--line);margin:20px 0}
.md a{color:var(--accent)}
.md table{border-collapse:collapse;font-size:13px;min-width:100%}
.md th,.md td{border:1px solid var(--line);padding:6px 10px;text-align:left;
  vertical-align:top}
.md th{background:var(--bg);font-weight:600;white-space:nowrap}
.tbl{overflow-x:auto;margin:12px 0}
.fence{margin:12px 0;border:1px solid var(--line);border-radius:8px;
  overflow:hidden;background:var(--code-bg);position:relative}
.fence .fl{position:absolute;top:0;right:0;font-family:var(--mono);
  font-size:10.5px;color:var(--faint);background:var(--card);padding:1px 8px;
  border-radius:0 8px 0 7px;border-left:1px solid var(--line);
  border-bottom:1px solid var(--line)}
.fence pre{margin:0;padding:12px 14px;overflow-x:auto}
.fence code{font-family:var(--mono);font-size:12.5px;background:none;
  padding:0;white-space:pre;line-height:1.65;
  font-variant-ligatures:none;-webkit-font-smoothing:antialiased}
.pfig{margin:16px 0;padding:12px 12px 8px;border:1px solid var(--line);
  border-radius:9px;background:var(--card);overflow-x:auto}
.pfig figcaption{margin-top:8px;font-size:11px;color:var(--faint);
  font-family:var(--mono)}
.pfig.bad{background:var(--warn-bg);border-color:var(--warn)}
.pfig .fn{display:block;font-size:11.5px;color:var(--warn);margin-bottom:6px}
.pfig .praw{margin:0;padding:10px 12px;background:var(--card);
  border-radius:7px;overflow-x:auto}
.pfig .praw code{font-family:var(--mono);font-size:12px;white-space:pre;
  background:none;padding:0}
.pumls{margin-top:6px}
.pumls summary{font-size:11px;color:var(--faint);cursor:pointer;
  font-family:var(--mono)}
.pumls summary:hover{color:var(--accent)}
.pumls pre{margin:6px 0 0;padding:10px 12px;background:var(--code-bg);
  border-radius:7px;overflow-x:auto}
.pumls code{font-family:var(--mono);font-size:12px;white-space:pre;
  background:none;padding:0}

/* ── 双排 diff ── */
.dwrap{padding:14px 18px 28px}
.diff{font-family:var(--mono);font-size:12.5px;line-height:1.7;
  /* 关掉连字:diff 里 != >= -> 变成合字后,与相邻列对不齐、也不像源码。
     tabular-nums 让行号列宽度稳定;font-smoothing 治 Windows 上的毛边。 */
  font-variant-ligatures:none;font-feature-settings:"liga" 0,"calt" 0,"tnum" 1;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  border:1px solid var(--line);border-radius:8px;overflow:hidden}
.dhead{display:grid;
  grid-template-columns:38px minmax(0,1fr) 38px minmax(0,1fr);
  background:var(--bg);border-bottom:1px solid var(--line);font-size:10.5px;
  color:var(--faint)}
.dhead span{padding:4px 10px}
.dhead span:first-child{grid-column:1/3}
.dhead span:last-child{grid-column:3/5;border-left:1px solid var(--line)}
.dr{display:grid;grid-template-columns:38px minmax(0,1fr) 38px minmax(0,1fr);
  background:var(--card);border-top:1px solid var(--line)}
.dr .ln{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums;
  text-align:right;padding:0 6px;
  background:var(--bg);user-select:none}
/* 不用 word-break:break-all——它在任意字符处断行,把 False 劈成 F|alse
   (中英混排的注释里最明显,用户实测截图里就有)。break-word 只在单个词
   确实放不下时才断;中文本身可以逐字换行,不受影响。 */
.dr .c{padding:0 10px;white-space:pre-wrap;word-break:normal;
  overflow-wrap:break-word;background:none;min-width:0}
.dr .c:nth-of-type(2){border-left:1px solid var(--line)}
.dr .c.add{background:var(--ok-bg);color:var(--ok)}
.dr .c.del{background:var(--bad-bg);color:var(--bad)}
.dr .c.nil{background:var(--bg)}
.dr .c.span{grid-column:1/-1;padding:2px 10px}
.dr.hk{background:var(--run-bg)}
.dr.hk .c{color:var(--run)}
.dr.cut{background:var(--warn-bg)}
.dr.cut .c{color:var(--warn)}
.dr.exp{background:var(--run-bg);cursor:pointer}
.dr.exp .c{color:var(--run);text-align:center}
.dr.exp:hover .c{text-decoration:underline}
@media (max-width:760px){
  .dhead{display:none}
  .dr{grid-template-columns:38px minmax(0,1fr)}
  .dr .c:nth-of-type(2){border-left:0}
  .dr .c.nil{display:none}
  .doc{grid-template-columns:72px minmax(0,1fr) auto}
  .doc .raw{display:none}
}
"""

JS = r"""
// 展开被折叠的未改动行。diffview 生成的展开行写着 onclick="dx(this)",
// 而这个函数从来没被定义过——点了毫无反应,这个功能自始至终没工作过。
// 折叠内容就在紧邻的下一个兄弟节点里(<div hidden>…</div>),点一下去掉 hidden、
// 把展开行自己隐去即可;再点相邻的展开行不受影响。
function dx(row){
  var hidden = row && row.nextElementSibling;
  if (!hidden || !hidden.hasAttribute('hidden')) { return; }
  hidden.removeAttribute('hidden');
  row.setAttribute('hidden', '');
  // 展开会改变高度,批注的行标记要跟着重画(它按行号定位)
  if (window.__panelPaintNotes) { window.__panelPaintNotes(); }
}

var V = document.getElementById('viewer');
function show(key){
  var panes = document.querySelectorAll('.pane');
  for (var i = 0; i < panes.length; i++){
    panes[i].classList.toggle('on', panes[i].dataset.key === key);
  }
  var pane = document.querySelector('.pane[data-key="' + key + '"]');
  if (!pane) { return; }
  var group = pane.dataset.group;
  var tabs = document.querySelectorAll('.vtabs button');
  for (var j = 0; j < tabs.length; j++){
    tabs[j].style.display = (tabs[j].dataset.group === group) ? '' : 'none';
    tabs[j].classList.toggle('on', tabs[j].dataset.key === key);
  }
  document.getElementById('vtitle').textContent = pane.dataset.title;
  document.getElementById('vraw').href = pane.dataset.raw;
  document.getElementById('vpath').textContent = pane.dataset.rel;
  V.classList.add('on');
  V.scrollTop = 0;
  pane.scrollTop = 0;          // 滚动在内容区内部,切换文件回到顶部
}
function hide(){
  V.classList.remove('on');
  // 关掉阅读层后补查一次:读文档期间攒下的更新此刻可以安全落地
  if (window.__panelProbe) { window.__panelProbe(); }
  if (window.__panelPaintNotes) { window.__panelPaintNotes(); }
}
// 自动发现更新:file:// 不能 fetch 同目录文件,但能用 script src 加载。
// 流程每次重生成面板都会更新 panel-stamp.js,页面探到更新即自动重载——
// 用户不必记得点任何按钮,也就不会看到与当前阶段不符的旧现场。
// 独立成段:不与陈旧横幅共用守卫,横幅缺失也不能让自动重载失效。
(function(){
  var born = Number(document.body.dataset.born || 0) * 1000;
  if (!born) { return; }
  function probe(){
    var tag = document.createElement('script');
    tag.src = 'panel-stamp.js?t=' + Date.now();
    tag.onload = function(){
      var latest = Number(window.__panelStamp || 0) * 1000;
      // 同一个新版本只重载一次:万一读不到更新后的页面,
      // 也不能把用户困在无限刷新里。
      var acted = Number(sessionStorage.getItem('panelReloadedAt') || 0);
      // 正在写批注同样不打断:重载会把没提交的文字冲掉
      var reading = (V && V.classList.contains('on')) || window.__panelBusy;
      // 读到一半不打扰:重载会关掉阅读层。关闭弹层时会再探一次(见 hide)。
      if (latest > born && latest > acted && !reading) {
        sessionStorage.setItem('panelReloadedAt', String(latest));
        location.reload();
      }
      tag.remove();
    };
    tag.onerror = function(){ tag.remove(); };
    document.head.appendChild(tag);
  }
  window.__panelProbe = probe;
  // 状态脉冲:轻量事实每两秒一次,页眉与阶段随流程实时变化;
  // 重内容(文档/diff)仍等整页重生成——脉冲只报事实,不假装自己有内容。
  var mark = document.body.dataset.pulse || '';
  var live = document.getElementById('live');
  function pulse(){
    var tag = document.createElement('script');
    tag.src = 'panel-pulse.js?t=' + Date.now();
    tag.onload = function(){
      var p = window.__panelPulse;
      tag.remove();
      if (!p || !live) { return; }
      var now = p.step + '|' + p.revision;
      if (now === mark) { live.hidden = true; return; }
      live.innerHTML = '● 流程已推进到 <b>' + (p.step_title || p.step) +
        '</b>（' + (p.phase || '') + '）' +
        (p.waiting ? ' — <b>正在等你确认</b>' : '') +
        ' · 本页文档与 diff 仍是上一次生成的，重内容会在下个节点自动更新';
      live.hidden = false;
    };
    tag.onerror = function(){ tag.remove(); };
    document.head.appendChild(tag);
  }
  setInterval(pulse, 2000);
  pulse();
  setInterval(probe, 5000);
  // 切回本标签时立刻查一次:人回来的那一刻最该看到最新现场,不等轮询。
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) { probe(); }
  });
  probe();
})();
// 陈旧兜底:自动重载在个别浏览器/设置下可能不工作,那就按时间诚实提示。
(function(){
  var born = Number(document.body.dataset.born || 0) * 1000;
  var bar = document.getElementById('stale');
  var age = document.getElementById('age');
  if (!born) { return; }
  function tick(){
    var mins = Math.floor((Date.now() - born) / 60000);
    if (age) {
      age.textContent = mins < 1 ? '刚刚生成 · '
        : (mins < 60 ? mins + ' 分钟前 · '
          : Math.floor(mins / 60) + ' 小时前 · ');
    }
    if (bar && mins >= 10) {
      bar.textContent = '⚠ 本页是 ' + mins + ' 分钟前的快照。面板会在流程'
        + '重新生成时自动更新；若长时间没动静，可能是流程还没走到会更新'
        + '面板的节点——以会话里的最新输出为准。';
      bar.hidden = false;
    }
  }
  tick();
  setInterval(tick, 60000);
})();
"""
