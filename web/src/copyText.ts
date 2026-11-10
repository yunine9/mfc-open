/** 内网 HTTP 常没有 Clipboard API；保留浏览器原生选中复制的回退。 */
export async function copyText(text: string): Promise<void> {
  const browser = globalThis as unknown as {
    navigator: { clipboard?: { writeText(text: string): Promise<void> } };
    document: {
      activeElement?: { focus?(): void };
      fullscreenElement?: { appendChild(element: unknown): void };
      body: { appendChild(element: unknown): void };
      createElement(tag: string): {
        value: string; readOnly: boolean; style: { position: string; left: string };
        focus(): void; select(): void; remove(): void;
      };
      execCommand(command: string): boolean;
    };
  };
  if (browser.navigator.clipboard?.writeText) {
    try { await browser.navigator.clipboard.writeText(text); return; }
    catch { /* 浏览器拒绝时尝试选中复制。 */ }
  }
  const doc = browser.document;
  const previous = doc.activeElement;
  const input = doc.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  (doc.fullscreenElement ?? doc.body).appendChild(input);
  try {
    input.focus(); input.select();
    if (!doc.execCommand("copy")) throw new Error("复制失败，请展开源码后手动复制");
  } finally { input.remove(); previous?.focus?.(); }
}
