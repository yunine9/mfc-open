import React, { useRef, useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeContentSearch } from "../../web/src/KnowledgeContentSearch";

const pause = () => new Promise(resolve => setTimeout(resolve, 80));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
function Fixture() {
  const content = useRef<HTMLDivElement>(null), [file, setFile] = useState("a"), [extra, setExtra] = useState(false);
  return <main><header><KnowledgeContentSearch contentRef={content} contentKey={file} /><button onClick={() => setFile("b")}>切换文件</button><button onClick={() => setExtra(true)}>追加正文</button></header>
    <div id="scroll" style={{ height: 280, overflow: "auto" }}><div ref={content} className="knowledge-review-notes">
      <div className="md">{file === "a" ? <><h1>订单管理</h1><p style={{ marginTop: 350 }}>确认订单状态</p><p>订<strong>单</strong>需要核对</p><p hidden>订单隐藏</p><pre>payment PAYMENT</pre><p><button className="knowledge-inline-link">结算规则</button></p></> : <p>最新订单</p>}{extra && <p>订单增量</p>}</div>
      <section aria-label="文稿审阅意见"><div className="md">订单批注</div></section>
      <div className="knowledge-review-note-list"><div className="md">订单旧批注</div></div>
    </div><footer>订单版本与来源</footer></div>
  </main>;
}
createRoot(document.getElementById("app")!).render(<Fixture />);
const highlights = () => [...CSS.highlights.entries()].filter(([key]) => key.startsWith("knowledge-find-"));
const count = () => document.querySelector('[aria-label="正文匹配结果"]')?.textContent;
async function click(label: string) { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label); check(button, `missing ${label}`); button!.click(); await pause(); }
async function search(value: string) { const input = document.querySelector<HTMLInputElement>('[aria-label="查找正文内容"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await pause(); }
async function key(key: string, shiftKey = false) { document.querySelector<HTMLInputElement>('[aria-label="查找正文内容"]')!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); await pause(); }
async function run() {
  await pause();
  check(typeof Highlight !== "undefined" && !!CSS.highlights, "CSS Custom Highlight supported by desktop browser");
  const before = document.querySelector(".knowledge-review-notes")!.innerHTML;
  const shortcut = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(shortcut); await pause();
  check(shortcut.defaultPrevented && document.activeElement?.getAttribute("aria-label") === "查找正文内容", "Ctrl F opens and focuses document search");
  await search("订单"); check(count() === "1 / 3", `Chinese matches only body, including split inline text: ${count()}`);
  const matches = highlights().find(([key]) => !key.endsWith("-active"))![1];
  check([...matches.values()].every(range => (range as Range).toString() === "订单"), "ranges have correct text offsets");
  await key("Enter"); check(count() === "2 / 3", "Enter moves to next match"); check(document.getElementById("scroll")!.scrollTop > 0, "match scrolls only body pane");
  await key("Enter", true); check(count() === "1 / 3", "Shift Enter moves to previous match");
  await click("上一处匹配"); check(count() === "3 / 3", "previous wraps to final match");
  check(document.querySelector(".knowledge-review-notes")!.innerHTML === before, "highlight does not mutate React Markdown or annotation DOM");
  await search("payment"); check(count() === "1 / 2", "case insensitive pre search without duplicate nested matches");
  await search("结算规则"); check(count() === "1 / 1", "document references rendered as links remain searchable");
  await search("订单"); await click("切换文件"); check(count() === "1 / 1", "file change reindexes and resets position");
  await click("追加正文"); check(count() === "1 / 2", `asynchronous text changes refresh results: ${count()}`);
  await search(""); check(count() === "0 / 0" && !highlights().length, "clear query removes highlights");
  await search("没有结果"); check(count() === "无结果", "empty result is explicit");
  await search("订单"); await key("Escape"); check(!document.querySelector('[aria-label="当前正文查找"]') && !highlights().length, "Escape closes and cleans highlights");
  const reopen = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(reopen); await pause(); check(reopen.defaultPrevented, "Command F supported");
  await click("关闭正文查找"); check(!highlights().length, "close button cleans highlights");
  check(!errors.length, errors.join("; ")); return { passed: true };
}
run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); }).catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
