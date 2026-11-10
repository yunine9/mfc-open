"""检视批注:在 diff 上圈出问题,一键复制成 Agent 能直接执行的清单。

为什么值得做:检视的瓶颈从来不是发现问题,是把"哪一行、要改成什么"
准确传达出去。口述"那个短信处理器里面重试那块"要模型猜三轮;
`sms_handler.py:23 + 一句意见` 它一次就到位。

代码和文档一视同仁:故事、规格、设计同样是检视对象,而且改文档往往
比改代码更早生效。markdown 渲染时给每个块打上源文件行号(data-l),
所以批注文档也能落成 `story.md:42`,不是"第三段那里"。

两个硬约束决定了形态:
- file:// 页面不能写文件,批注只能走剪贴板——你点"复制给 Agent",
  粘进会话即可,不需要任何服务;
- 面板每几秒可能重生成并自动重载,所以批注必须落在 localStorage,
  按单号分键;编辑期间禁止自动重载,不能把人写一半的字刷没。
"""

CSS = r"""
.dr{position:relative}
/* 提示标压在行尾而不是行首:行首那点空间是行号和代码的,
   9px 的字压在代码上既看不清又挡人。 */
.diff .dr:not(.hk):not(.cut):hover::after,
.md [data-l]:hover::after{
  content:"✎ 批注";position:absolute;right:6px;top:50%;
  transform:translateY(-50%);font:600 11.5px/1.5 inherit;
  color:var(--accent);background:var(--card);border:1px solid var(--accent);
  border-radius:5px;padding:1px 7px;cursor:pointer;pointer-events:none;
  box-shadow:0 1px 6px rgba(0,0,0,.12)}
.md [data-l]{position:relative}
.md [data-l]:hover{background:var(--accent-bg);border-radius:4px}
.md [data-l]:hover::after{top:4px;transform:none}
.dr.noted,.md [data-l].noted{box-shadow:inset 3px 0 var(--accent)}
.md [data-l].noted{padding-left:8px}
.note-editor{grid-column:1/-1;display:flex;gap:8px;align-items:flex-start;
  padding:8px 10px;background:var(--accent-bg);border-top:1px solid var(--accent)}
.note-editor textarea{flex:1;min-height:46px;font:inherit;font-size:12px;
  padding:6px 8px;border:1px solid var(--line);border-radius:6px;resize:vertical;
  background:var(--card);color:var(--ink)}
.note-editor button{font:inherit;font-size:11.5px;padding:4px 10px;cursor:pointer;
  border:1px solid var(--line);border-radius:6px;background:var(--card);
  color:var(--dim)}
.note-editor button.primary{color:#fff;background:var(--accent);
  border-color:var(--accent)}
.note-shown{grid-column:1/-1;padding:6px 10px 8px 26px;background:var(--accent-bg);
  color:var(--accent);font-size:12px;border-top:1px solid var(--accent)}
.note-shown button{margin-left:8px;font:inherit;font-size:10.5px;color:var(--dim);
  background:none;border:0;cursor:pointer;text-decoration:underline}
#notes-badge{position:fixed;right:22px;bottom:22px;z-index:60;display:none;
  align-items:center;gap:10px;background:var(--accent);color:#fff;
  border:0;border-radius:24px;padding:10px 18px;font:inherit;font-size:13px;
  cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25)}
#notes-badge.on{display:inline-flex}
#notes-badge span{background:rgba(255,255,255,.22);border-radius:12px;
  padding:1px 8px;font-size:12px}
/* 一条批注都没有时也留着入口,但收敛成描边,不喧宾夺主 */
#notes-badge.idle{background:var(--card);color:var(--accent);
  border:1px solid var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.14)}
#notes-badge.idle span{display:none}
#notes-toast{position:fixed;right:22px;bottom:72px;z-index:61;display:none;
  background:var(--dark);color:#f6f6f2;border-radius:8px;padding:9px 14px;
  font-size:12px;max-width:420px;box-shadow:0 6px 20px rgba(0,0,0,.3)}
#notes-toast.on{display:block}
"""

JS = r"""
// ── 检视批注 ────────────────────────────────────────────────
// 存 localStorage(按单号分键):面板可能随时重生成并自动重载,
// 批注绝不能跟着页面一起没。编辑期间禁止自动重载(见 window.__panelBusy)。
(function(){
  var ticket = document.body.dataset.ticket || 'unknown';
  var KEY = 'maeflow.notes.' + ticket;
  var badge = document.getElementById('notes-badge');
  var toast = document.getElementById('notes-toast');

  function load(){
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (err) { return []; }
  }
  function save(list){
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (err) {}
    paint();
  }
  function say(text){
    if (!toast) { return; }
    toast.textContent = text;
    toast.classList.add('on');
    setTimeout(function(){ toast.classList.remove('on'); }, 2600);
  }
  function paint(){
    var list = load();
    if (badge){
      badge.classList.add('on');          // 常驻:空清单里写着怎么用
      badge.classList.toggle('idle', list.length === 0);
      var count = badge.querySelector('span');
      if (count) { count.textContent = list.length; }
    }
    document.querySelectorAll('.dr.noted').forEach(function(row){
      row.classList.remove('noted');
    });
    document.querySelectorAll('.note-shown').forEach(function(node){
      node.remove();
    });
    list.forEach(function(item){ mark(item); });
    if (window.__panelPaintDrawer) { window.__panelPaintDrawer(); }
  }
  // 靶子有两类:diff 行,以及文档里带源行号的块(段落/条目/表格/图)。
  function targetsOf(file){
    var pane = document.querySelector('.pane[data-rel^="' + file + '"]');
    if (!pane) { return []; }
    var rows = pane.querySelectorAll('.dr');
    return rows.length ? rows : pane.querySelectorAll('.md [data-l]');
  }
  function isDoc(node){ return !node.classList.contains('dr'); }
  function lineOf(row){
    if (isDoc(row)) { return row.dataset.l || ''; }
    var cells = row.querySelectorAll('.ln');
    var right = cells.length > 1 ? cells[1].textContent.trim() : '';
    return right || (cells.length ? cells[0].textContent.trim() : '');
  }
  function fileOf(row){
    var pane = row.closest('.pane');
    var rel = pane ? (pane.dataset.rel || '') : '';
    return rel.split('（')[0];
  }
  function codeOf(row){
    if (isDoc(row)){
      var text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length > 90 ? text.slice(0, 90) + '…' : text;
    }
    var cells = row.querySelectorAll('.c');
    var right = cells.length > 1 ? cells[1].textContent : '';
    return (right || (cells.length ? cells[0].textContent : '')).trim();
  }
  function mark(item){
    targetsOf(item.file).forEach(function(row){
      if (lineOf(row) !== item.line) { return; }
      row.classList.add('noted');
      var shown = document.createElement('div');
      shown.className = 'note-shown';
      shown.textContent = '批注：' + item.note;
      var drop = document.createElement('button');
      drop.textContent = '删除';
      drop.onclick = function(event){
        event.stopPropagation();
        var at = -1;
        load().forEach(function(other, index){
          if (at < 0 && other.file === item.file && other.line === item.line
              && other.note === item.note) { at = index; }
        });
        if (at >= 0) { window.__notes.drop(at); }
      };
      shown.appendChild(drop);
      place(row, shown);
    });
  }
  // 列表项要把批注放进 li 内部:塞在 <ul> 的两个 <li> 之间是坏结构。
  function place(row, node){
    if (row.tagName === 'LI') { row.appendChild(node); }
    else { row.parentNode.insertBefore(node, row.nextSibling); }
  }
  // 改批注前人几乎总要再看一眼上下文,所以清单每条都能跳回原处。
  function locate(item){
    var pane = document.querySelector('.pane[data-rel^="' + item.file + '"]');
    if (!pane) { return; }
    if (window.show && pane.dataset.key) { window.show(pane.dataset.key); }
    else { pane.classList.add('on'); }
    setTimeout(function(){
      var hit = null;
      targetsOf(item.file).forEach(function(node){
        if (!hit && lineOf(node) === item.line) { hit = node; }
      });
      if (!hit) { return; }
      hit.scrollIntoView({block: 'center'});
      hit.classList.add('flash');
      setTimeout(function(){ hit.classList.remove('flash'); }, 1700);
    }, 60);
  }
  function edit(row){
    if (row.querySelector && row.querySelector(':scope > .note-editor')){ return; }
    if (row.nextSibling && row.nextSibling.className === 'note-editor'){ return; }
    window.__panelBusy = true;           // 写字期间不许自动重载
    var box = document.createElement('div');
    box.className = 'note-editor';
    var area = document.createElement('textarea');
    area.placeholder = '这里要改什么？例如：这个重试应该只对网关失败生效';
    var ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '记下';
    var no = document.createElement('button');
    no.textContent = '取消';
    function close(){ box.remove(); window.__panelBusy = false; }
    ok.onclick = function(){
      var text = area.value.trim();
      if (text){
        var list = load();
        list.push({file: fileOf(row), line: lineOf(row),
                   code: codeOf(row), note: text,
                   doc: isDoc(row) ? 1 : 0});
        save(list);
      }
      close();
    };
    no.onclick = close;
    box.appendChild(area);
    box.appendChild(ok);
    box.appendChild(no);
    place(row, box);
    area.focus();
  }
  document.addEventListener('click', function(event){
    if (!event.target.closest) { return; }
    if (event.target.tagName === 'BUTTON' || event.target.tagName === 'A'
        || event.target.tagName === 'TEXTAREA') { return; }
    // 划词是在读,不是要批注——有选区就别弹编辑框。
    if (String(window.getSelection() || '').trim()) { return; }
    var row = event.target.closest('.dr') || event.target.closest('.md [data-l]');
    if (!row) { return; }
    if (row.classList.contains('hk') || row.classList.contains('cut')
        || row.classList.contains('exp')) { return; }
    edit(row);
  });
  // 多条一次送:按文件分组、组内按行号升序。人是跳着圈的,Agent 却要
  // 一个文件一个文件地改——按点击顺序给它,它得来回翻。
  // 带上 at(原始下标),清单据此改某一条、删某一条。
  function ordered(){
    return load().map(function(note, at){ return {note: note, at: at}; })
      .sort(function(a, b){
        if (a.note.file !== b.note.file){
          return a.note.file < b.note.file ? -1 : 1;
        }
        return (parseInt(a.note.line, 10) || 0)
             - (parseInt(b.note.line, 10) || 0);
      });
  }
  function render(){
    var list = ordered().map(function(entry){ return entry.note; });
    var files = [];
    list.forEach(function(item){
      if (files.indexOf(item.file) < 0) { files.push(item.file); }
    });
    // 抬头要把三件事说死:这是人工检视的结论(不是讨论稿)、只改这些地方、
    // 行号会因改动偏移所以按原文定位。弱模型最容易在这三处走偏。
    var lines = [
      '这是我人工检视 ' + ticket + ' 的结果，共 ' + list.length + ' 条，涉及 '
        + files.length + ' 个文件。请按下面的意见逐条修改。',
      '',
      '几点要求：',
      '- 这是检视结论，不是征求意见。逐条落实，不要只回复"已知悉"。',
      '- 只改这些地方。确实要连带改别处，先说清为什么，再动。',
      '- 行号按你收到时的文件；你一改行号就会偏移，所以每条都附了原文，'
        + '以原文为准定位。',
      '- 逐条回我改了什么。有哪条你认为不该改，说明理由，别默默跳过。',
      ''];
    var seen = '', index = 0;
    list.forEach(function(item){
      if (item.file !== seen){
        seen = item.file;
        lines.push('【' + item.file + '】');
      }
      index += 1;
      lines.push(index + '. 第 ' + item.line + ' 行');
      if (item.code){
        lines.push('   ' + (item.doc ? '原文：' : '当前代码：') + item.code);
      }
      lines.push('   要求：' + item.note);
    });
    return lines.join('\n');
  }
  function copy(){
    var text = render();
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        say('已复制 ' + load().length + ' 条批注，粘贴进会话即可');
      }, function(){ fallback(text); });
    } else { fallback(text); }
  }
  function fallback(text){
    var area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); say('已复制，粘贴进会话即可'); }
    catch (err) { say('复制失败，请手动选中下面文本框内容'); }
    area.remove();
  }
  paint();
  window.__panelPaintNotes = paint;
  window.__notes = {
    ordered: ordered,
    locate: locate,
    copy: copy,
    render: render,
    amend: function(at, text){
      var list = load();
      if (!list[at]) { return; }
      list[at].note = text;
      save(list);
    },
    drop: function(at){
      var list = load();
      if (!list[at]) { return; }
      list.splice(at, 1);
      save(list);
    }
  };
})();
"""
