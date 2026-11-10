/**
 * 零构建演示页(说人话版):任务列表 + 发起任务 + 审批卡直接点。
 *
 * 这是阶段 1 的演示壳,不是正式前端(正式版 React/Vite,主 spec §4);
 * 它存在的理由是"凡请用户检视的东西,必须能在页面直接查看"——
 * 从第一天起整条环就要能在浏览器里走完,而不是只活在 curl 里。
 * 页面不推断状态:一切文案来自任务 API 的镜像。
 */

export const WEB_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mae-Flow 云端任务</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px;
         margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.3rem; }
  form { display: flex; gap: .5rem; margin: 1rem 0; }
  input[type=text] { flex: 1; padding: .5rem; }
  button { padding: .45rem .9rem; cursor: pointer; }
  .task { border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
          border-radius: 8px; padding: .8rem 1rem; margin: .8rem 0; }
  .status { font-size: .85rem; padding: .1rem .5rem; border-radius: 99px;
            border: 1px solid currentColor; }
  .waiting { border-left: 4px solid #d97706; padding-left: .8rem;
             margin-top: .6rem; }
  .muted { opacity: .7; font-size: .9rem; }
  pre { background: color-mix(in srgb, currentColor 8%, transparent);
        padding: .6rem; border-radius: 6px; overflow-x: auto;
        max-height: 16rem; font-size: .8rem; }
</style>
</head>
<body>
<h1>Mae-Flow 云端任务</h1>
<form id="create">
  <input type="text" id="requirement" placeholder="用一句话描述需求,例如:交付 REQ2026xxxx …" required>
  <input type="text" id="account" placeholder="小鲁班账号(可选)" style="max-width:11rem">
  <button type="submit">发起任务</button>
</form>
<div id="tasks"></div>
<script>
const STATUS_TEXT = {
  queued: "排队中", running: "进行中", pausing: "正在暂停",
  paused: "已暂停", waiting_for_human: "等你决定",
  completed: "已完成", canceled: "已取消", failed: "出错了",
  verifying: "代码已提交,流水线验证中", await_merge: "已提合入请求,等待合入",
};

async function refresh() {
  const tasks = await fetch("/tasks").then((r) => r.json());
  const box = document.getElementById("tasks");
  box.innerHTML = "";
  if (!tasks.length) {
    box.innerHTML = '<p class="muted">还没有任务。上面发起一个试试。</p>';
  }
  for (const task of tasks) {
    const el = document.createElement("div");
    el.className = "task";
    let html = '<b>' + task.id + '</b> <span class="status">'
      + (STATUS_TEXT[task.status] || task.status) + '</span>'
      + '<div class="muted">' + escapeHtml(task.requirement) + '</div>';
    if (task.status === "failed" && task.detail) {
      html += '<div class="muted">原因:' + escapeHtml(task.detail) + '</div>';
    }
    if (task.delivery) {
      if (task.delivery.mr_url) {
        html += '<div>合入请求:<a href="' + escapeHtml(task.delivery.mr_url)
          + '" target="_blank">' + escapeHtml(task.delivery.mr_url) + '</a>'
          + '(' + escapeHtml(task.delivery.mr_state || "") + ')</div>';
      } else if (task.delivery.skipped) {
        html += '<div class="muted">交付情况:'
          + escapeHtml(task.delivery.skipped) + '</div>';
      }
    }
    if (task.notify && !task.notify.delivered && task.notify.attempts > 0) {
      html += '<div style="color:#dc2626">⚠ 小鲁班通知没送到'
        + '(已试 ' + task.notify.attempts + ' 次)——待办仍在,请在本页处理。</div>';
    }
    if (task.status !== "queued") {
      html += '<div><a href="/tasks/' + task.id + '/panel" target="_blank">'
        + '打开现场面板</a><span class="muted">(检视材料都在里面)</span></div>';
    }
    el.innerHTML = html;
    if (task.status === "waiting_for_human" && task.waiting) {
      el.appendChild(waitingCard(task));
    }
    const log = document.createElement("details");
    log.innerHTML = '<summary class="muted">过程记录</summary><pre></pre>';
    el.appendChild(log);
    log.addEventListener("toggle", () => {
      if (log.open) tail(task.id, log.querySelector("pre"));
    }, { once: true });
    box.appendChild(el);
  }
}

function waitingCard(task) {
  const card = document.createElement("div");
  card.className = "waiting";
  const questions = (task.waiting.question || {}).questions || [];
  const picked = {};
  for (const item of questions) {
    const block = document.createElement("div");
    block.innerHTML = "<div><b>" + escapeHtml(item.question || "需要你确认")
      + "</b></div>";
    for (const option of item.options || []) {
      const button = document.createElement("button");
      button.textContent = option;
      button.style.margin = "0 .5rem .4rem 0";
      button.onclick = () => {
        picked[item.question] = option;
        for (const sibling of block.querySelectorAll("button")) {
          sibling.style.fontWeight =
            sibling.textContent === option ? "bold" : "normal";
        }
        maybeEnable();
      };
      block.appendChild(button);
    }
    card.appendChild(block);
  }
  const submit = document.createElement("button");
  submit.textContent = "提交决定";
  submit.disabled = true;
  submit.onclick = async () => {
    const response = await fetch("/tasks/" + task.id + "/decision", {
      method: "POST",
      body: JSON.stringify({
        state_version: task.waiting.state_version,
        answers: picked,
      }),
    });
    if (response.status === 409) alert("任务状态已变化:别人已经先做了决定。");
    refresh();
  };
  function maybeEnable() {
    submit.disabled =
      Object.keys(picked).length < questions.length;
  }
  card.appendChild(submit);
  return card;
}

function tail(id, pre) {
  const source = new EventSource("/tasks/" + id + "/events");
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    pre.textContent += event.kind + "  " +
      JSON.stringify(event.payload).slice(0, 160) + "\\n";
    pre.scrollTop = pre.scrollHeight;
  };
  source.onerror = () => source.close();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

document.getElementById("create").onsubmit = async (submit) => {
  submit.preventDefault();
  const input = document.getElementById("requirement");
  const account = document.getElementById("account");
  await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      requirement: input.value,
      account: account.value || undefined,
    }),
  });
  input.value = "";
  refresh();
};

refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;
