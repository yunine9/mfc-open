/**
 * 个人 Git 令牌 + 署名邮箱(收进"个人设置"页的一根细条)。
 * 只写不读:令牌输入框永远从空白开始,已配置与否只看服务端给的掩码;
 * 生效边界=下一次任务启动/会话重建(在跑的任务不换凭据)。
 *
 * 口径(用户 2026-08-19 拍板):**邮箱必填**(commit 署名与平台对人都
 * 要它);**用户名不另配**——git 用户名就是登录账号名,账号由管理员按
 * 平台用户名建,再开一个字段只会造出两个可以互相不一致的真相。
 */

import { useState } from "react";
import { putGitToken, type AuthUser } from "./api";
import { Input } from "@/components/ui/input";
import { cn } from "cn";

export function GitTokenCard({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged?: (credential: { git_token_hint?: string; git_email?: string }) => void;
}) {
  const [hint, setHint] = useState(session.git_token_hint);
  const [email, setEmail] = useState(session.git_email);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [gitEmail, setGitEmail] = useState(session.git_email ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(clear = false) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await putGitToken(
        clear ? "" : token,
        clear ? undefined : gitEmail || undefined);
      setHint(result.git_token_hint);
      setEmail(result.git_email);
      onChanged?.({
        git_token_hint: result.git_token_hint,
        git_email: result.git_email,
      });
      setToken("");
      setMessage(clear
        ? "CodeHub 配置已清除。"
        : "已保存，下一次任务将使用你的身份提交代码。");
      if (clear) { setOpen(false); setGitEmail(""); }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section aria-label="CodeHub 提交身份"
    className={cn("flex min-h-[252px] min-w-0 flex-col rounded-xl border bg-surface p-[18px] shadow-xs transition-colors",
      hint ? "border-line hover:border-success/30" : "border-line hover:border-primary/30")}>
    <header className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[11px]">
      <span aria-hidden className="grid size-9 place-items-center rounded-[10px] border border-primary/25 bg-primary/10 text-primary">
        <svg viewBox="0 0 24 24" className="size-[19px] fill-none stroke-current stroke-[1.55] stroke-linecap-round stroke-linejoin-round"><path d="M8 7.5h8M8 12h8M8 16.5h5"/><path d="M5 3.5h14v17H5z"/></svg>
      </span>
      <div className="grid min-w-0 gap-[3px]">
        <strong className="text-[15.5px] text-text-strong">CodeHub 提交身份</strong>
      </div>
      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[13px] font-bold",
        hint ? "border-success/25 bg-success/10 text-success" : "border-attention/25 bg-attention/10 text-attention")}>
        <i aria-hidden className="size-[5px] rounded-full bg-current" />{hint ? "已配置" : "待配置"}</span>
    </header>
    <p className="mb-3.5 mt-[13px] text-[13px] leading-[1.65] text-muted-foreground">用于拉取、推送代码，并把 Git 提交正确归属到你。</p>

    <dl className="m-0 grid grid-cols-2 gap-[7px]">
      <div className="grid min-w-0 gap-[3px] rounded-lg border border-line/80 bg-surface-2/70 px-2.5 py-[9px]">
        <dt className="text-[13px] font-bold tracking-[0.04em] text-faint">个人邮箱</dt>
        <dd className="m-0 truncate text-[13px] text-text">{email || "未设置"}</dd></div>
      <div className="grid min-w-0 gap-[3px] rounded-lg border border-line/80 bg-surface-2/70 px-2.5 py-[9px]">
        <dt className="text-[13px] font-bold tracking-[0.04em] text-faint">CodeHub Token</dt>
        <dd className="m-0 truncate text-[13px] text-text">{hint ? <code className="text-[13px] text-primary">{hint}</code> : "未设置"}</dd></div>
    </dl>

    <div className="mt-auto grid gap-2 pt-[15px]">
      {message && <span className="text-[13px] leading-[1.45] text-success">{message}</span>}
      {error && <span className="text-[13px] leading-[1.45] text-danger">{error}</span>}
      {!open && <div className="flex items-center gap-2.5">
        <button type="button"
          className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-primary bg-primary px-[13px] text-[13px] font-bold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
          setOpen(true); setMessage(""); setError("");
        }}>{hint ? "更新配置" : "配置 CodeHub"}</button>
        {hint && <button type="button" className="min-h-[34px] cursor-pointer border-0 bg-transparent px-1 text-[13px] font-bold text-muted-foreground hover:text-danger disabled:cursor-not-allowed disabled:opacity-50" disabled={busy}
          onClick={() => void save(true)}>清除</button>}
      </div>}
    </div>

    {open && <form className="mt-3.5 grid content-start gap-[11px] border-t border-line pt-3.5" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label className="grid gap-[5px]"><span className="text-[13px] font-bold text-text">个人邮箱</span>
          <Input type="email" value={gitEmail} required autoComplete="off"
            placeholder="name@company.com"
            onChange={(event) => setGitEmail(event.target.value)} />
          <small className="text-[13px] leading-[1.45] text-faint">用于 Git commit 署名和 CodeHub 归属。</small>
        </label>
        <label className="grid gap-[5px]"><span className="text-[13px] font-bold text-text">CodeHub Token</span>
          <Input type="password" value={token} required autoComplete="new-password"
            placeholder="粘贴 CodeHub 访问 Token"
            onChange={(event) => setToken(event.target.value)} />
          <small className="text-[13px] leading-[1.45] text-faint">仅用于代码仓访问；保存后不会回显完整内容。</small>
        </label>
        <footer className="flex justify-end gap-2">
          <button type="button" className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-line bg-transparent px-[13px] text-[13px] font-bold text-text hover:border-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={busy}
            onClick={() => { setOpen(false); setToken(""); setError(""); }}>取消</button>
          <button type="submit"
            className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-primary bg-primary px-[13px] text-[13px] font-bold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || !token.trim() || !gitEmail.trim()}>
            {busy ? "保存中…" : "保存配置"}</button>
        </footer>
      </form>}
  </section>;
}
