/**
 * 需求文档一轮修改的对比:统一 diff 直接摊在页面上。
 *
 * 不用 GitDiff:那是给代码检视的并排画布,带文件树、专注审阅弹层、
 * 交付勾选。需求原文只有一个文件、几十行,套上去要先点"进入专注审阅"
 * 才看得到一行改动(实测)。这里只做一件事:删了什么、加了什么、上下文
 * 是什么,一眼看完。
 */

interface DiffRow {
  kind: "hunk" | "ctx" | "add" | "del";
  text: string;
  /** 新文件行号;删除行没有。 */
  line?: number;
}

export function parseRequirementDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let cursor = 0;
  for (const raw of text.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cursor = Number(hunk[1]);
      rows.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!cursor || /^diff --git |^index |^--- |^\+\+\+ |^\\ No newline/.test(raw)) {
      continue;
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), line: cursor });
      cursor += 1;
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1) });
    } else if (raw === "") {
      // git 输出末尾的空行,不是文件内容。
    } else {
      rows.push({ kind: "ctx", text: raw.slice(1), line: cursor });
      cursor += 1;
    }
  }
  return rows;
}

export function RequirementDiff({ text }: { text: string }) {
  const rows = parseRequirementDiff(text);
  if (!rows.length) {
    return <p className="requirement-revision-missing">这一轮没有产生文本差异。</p>;
  }
  return <div className="requirement-diff" role="table" aria-label="需求原文修改对比">
    {rows.map((row, index) => (
      <div key={index} className={`requirement-diff-row ${row.kind}`} role="row">
        <span className="requirement-diff-mark" aria-hidden>
          {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
        </span>
        <span className="requirement-diff-line">{row.line ?? ""}</span>
        <span className="requirement-diff-text">{row.text}</span>
      </div>
    ))}
  </div>;
}
