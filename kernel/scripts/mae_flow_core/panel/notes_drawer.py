"""批注清单:右下角展开,逐条改、逐条删、点一下跳回原位。

为什么单独一层:annotate 负责"圈点"(在 diff 行和文档块上落下批注),
这里负责"管账"。检视是来回的——先圈十几处,再回头看哪条写重了、
哪条措辞太含糊。没有清单就只能满页找那几道紫边。

跳转优先于编辑:改批注前人几乎总要再看一眼上下文,所以每条都能
"定位"回原处并高亮。清单只读写 localStorage,和面板其余部分一样
不碰任何状态。
"""

CSS = r"""
#notes-drawer{position:fixed;right:22px;bottom:74px;z-index:60;display:none;
  flex-direction:column;width:min(460px,calc(100vw - 44px));
  max-height:min(64vh,620px);background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:12px;overflow:hidden;
  box-shadow:0 14px 44px rgba(0,0,0,.28)}
#notes-drawer.on{display:flex}
#notes-drawer > header{display:flex;align-items:center;gap:8px;
  padding:10px 12px;border-bottom:1px solid var(--line);font-size:12.5px}
#notes-drawer > header b{flex:1;font-weight:600;font-size:13px}
#notes-drawer > header button{font:inherit;font-size:11.5px;padding:4px 10px;
  cursor:pointer;border:1px solid var(--line);border-radius:6px;
  background:var(--card);color:var(--dim)}
#notes-drawer > header button.primary{color:#fff;background:var(--accent);
  border-color:var(--accent)}
#notes-list{overflow:auto;padding-bottom:6px}
#notes-list .empty{padding:22px 16px;color:var(--dim);font-size:12.5px;
  line-height:1.8}
#notes-list .empty b{display:block;color:var(--ink);font-size:13px;
  margin-bottom:4px}
.nt-file{position:sticky;top:0;background:var(--card);padding:9px 12px 3px;
  font-size:11.5px;color:var(--dim);word-break:break-all}
.nt{padding:6px 12px 10px;border-bottom:1px solid var(--line)}
.nt-head{display:flex;align-items:baseline;gap:6px;font-size:11.5px;
  color:var(--dim)}
.nt-head b{color:var(--accent);font-weight:600}
.nt-head .sp{flex:1}
.nt-head button{font:inherit;font-size:11px;color:var(--dim);background:none;
  border:0;cursor:pointer;text-decoration:underline;padding:0 2px}
.nt-quote{font-size:11.5px;color:var(--dim);margin:4px 0 3px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nt-note{font-size:13px;line-height:1.55;white-space:pre-wrap}
.nt textarea{width:100%;min-height:54px;font:inherit;font-size:12.5px;
  margin-top:4px;padding:6px 8px;border:1px solid var(--accent);
  border-radius:6px;resize:vertical;background:var(--card);color:var(--ink)}
.dr.flash,.md [data-l].flash{outline:2px solid var(--accent);
  outline-offset:1px;background:var(--accent-bg)}
"""

JS = r"""
// ── 批注清单 ────────────────────────────────────────────────
// 靠 window.__notes(annotate.py 暴露的小 API)读写,自己不碰存储格式。
(function(){
  var api = window.__notes;
  var drawer = document.getElementById('notes-drawer');
  var listBox = document.getElementById('notes-list');
  var badge = document.getElementById('notes-badge');
  var title = document.getElementById('notes-title');
  var copyAll = document.getElementById('notes-copy');
  if (!api || !drawer || !listBox) { return; }

  function el(tag, cls, text){
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }   // 一律 textContent
    return node;
  }
  function link(text, run){
    var node = el('button', '', text);
    node.onclick = run;
    return node;
  }
  function editing(on){ window.__panelBusy = on; }

  function row(entry){
    var item = entry.note;
    var box = el('div', 'nt');
    var head = el('div', 'nt-head');
    head.appendChild(el('b', '', '第 ' + item.line + ' 行'));
    head.appendChild(el('span', 'sp'));
    head.appendChild(link('定位', function(){ api.locate(item); }));
    head.appendChild(link('编辑', function(){ rewrite(box, entry); }));
    head.appendChild(link('删除', function(){
      api.drop(entry.at);
    }));
    box.appendChild(head);
    if (item.code){
      box.appendChild(el('div', 'nt-quote',
                         (item.doc ? '原文：' : '当前代码：') + item.code));
    }
    box.appendChild(el('div', 'nt-note', item.note));
    return box;
  }

  function rewrite(box, entry){
    if (box.querySelector('textarea')) { return; }
    editing(true);
    var shown = box.querySelector('.nt-note');
    var area = el('textarea');
    area.value = entry.note.note;
    var bar = el('div', 'nt-head');
    bar.appendChild(el('span', 'sp'));
    bar.appendChild(link('保存', function(){
      var text = area.value.trim();
      editing(false);
      if (text) { api.amend(entry.at, text); } else { api.drop(entry.at); }
    }));
    bar.appendChild(link('取消', function(){ editing(false); paint(); }));
    shown.style.display = 'none';
    box.appendChild(area);
    box.appendChild(bar);
    area.focus();
  }

  function paint(){
    var list = api.ordered();
    listBox.textContent = '';
    if (title){
      var files = [];
      list.forEach(function(entry){
        if (files.indexOf(entry.note.file) < 0) { files.push(entry.note.file); }
      });
      title.textContent = list.length
        ? ('检视批注 ' + list.length + ' 条 · ' + files.length + ' 个文件')
        : '检视批注';
    }
    if (copyAll) { copyAll.disabled = !list.length; }
    if (!list.length){
      var tip = el('div', 'empty');
      tip.appendChild(el('b', '', '还没有批注'));
      tip.appendChild(document.createTextNode(
        '检视时看到哪里要改，就在那一行上点一下——代码的 diff 行、'
        + '文档的段落和条目都可以。写下要改什么，攒够了从这里一次'
        + '复制给 Agent，它拿到的是带文件和行号的清单。'));
      listBox.appendChild(tip);
      return;
    }
    var seen = '';
    list.forEach(function(entry){
      if (entry.note.file !== seen){
        seen = entry.note.file;
        listBox.appendChild(el('div', 'nt-file', seen));
      }
      listBox.appendChild(row(entry));
    });
  }

  function toggle(){
    var on = !drawer.classList.contains('on');
    drawer.classList.toggle('on', on);
    if (on) { paint(); } else { editing(false); }
  }
  if (badge) { badge.onclick = toggle; }
  var close = document.getElementById('notes-close');
  if (close) { close.onclick = function(){ drawer.classList.remove('on'); }; }
  if (copyAll) { copyAll.onclick = function(){ api.copy(); }; }
  document.addEventListener('keydown', function(event){
    if (event.key === 'Escape' && drawer.classList.contains('on')){
      editing(false);
      drawer.classList.remove('on');
    }
  });
  // 面板每几秒可能重生成:清单跟着批注一起重画,不留旧账。
  window.__panelPaintDrawer = function(){
    if (drawer.classList.contains('on')) { paint(); }
  };
})();
"""
