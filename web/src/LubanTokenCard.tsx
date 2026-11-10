/**
 * 个人通知令牌(小鲁班),与 Git 令牌并排的一根细条。
 *
 * 为什么按人配而不是服务级配一个:那个接口**以令牌对应的人的身份
 * 发消息**——服务号统一发,大家收到的都是同一个机器人;各人配自己
 * 的,既能接收自己的任务提醒，也能主动通知所选 Committer。
 * 同样只写不读:输入框永远从空白开始,配没配只看服务端给的掩码。
 */

import { useState } from "react";
import {
  putLubanToken,
  testLubanConnection,
  type AuthUser,
} from "./api";
import { Input } from "@/components/ui/input";
import { cn } from "cn";

export function LubanTokenCard({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged?: (credential: { luban_token_hint?: string }) => void;
}) {
  const [hint, setHint] = useState(session.luban_token_hint);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(clear = false) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await putLubanToken(clear ? "" : token);
      setHint(result.luban_token_hint);
      onChanged?.({ luban_token_hint: result.luban_token_hint });
      setToken("");
      setMessage(clear
        ? "小鲁班通知已关闭。"
        : "已保存，任务需要你处理时会通过小鲁班提醒。");
      if (clear) setOpen(false);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  async function testConnection() {
    setTesting(true); setMessage(""); setError("");
    try {
      const result = await testLubanConnection();
      setMessage(result.message);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setTesting(false); }
  }

  return <section aria-label="小鲁班通知"
    className={cn("flex min-h-[252px] min-w-0 flex-col rounded-xl border bg-surface p-[18px] shadow-xs transition-colors",
      hint ? "border-line hover:border-success/30" : "border-line hover:border-primary/30")}>
    <header className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[11px]">
      <span aria-hidden className="grid size-9 place-items-center rounded-[10px] border border-merge/25 bg-merge/10 text-merge">
        <svg viewBox="0 0 24 24" className="size-[19px] fill-none stroke-current stroke-[1.55]"><path d="M5 6.5h14v10H9l-4 3z"/><path d="M9 10h6M9 13h4"/></svg>
      </span>
      <div className="grid min-w-0 gap-[3px]">
        <strong className="text-[15.5px] text-text-strong">小鲁班通知</strong>
      </div>
      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[13px] font-bold",
        hint ? "border-success/25 bg-success/10 text-success" : "border-attention/25 bg-attention/10 text-attention")}>
        <i aria-hidden className="size-[5px] rounded-full bg-current" />{hint ? "已配置" : "待配置"}</span>
    </header>
    <p className="mb-3.5 mt-[13px] text-[13px] leading-[1.65] text-muted-foreground">用于发送任务提醒：自己的待办发给自己，邀请检视时发给所选 Committer 工号。</p>

    <dl className="m-0 grid grid-cols-1 gap-[7px]">
      <div className="grid min-w-0 gap-[3px] rounded-lg border border-line/80 bg-surface-2/70 px-2.5 py-[9px]">
        <dt className="text-[13px] font-bold tracking-[0.04em] text-faint">小鲁班 Token</dt>
        <dd className="m-0 truncate text-[13px] text-text">{hint ? <code className="text-[13px] text-primary">{hint}</code> : "未设置"}</dd></div>
    </dl>
    {/* 提示行:标签与说明允许各自换行收窄(p min-w-0 + 行 flex-wrap),
        窄卡/窄屏下文字完整可读,不再贴右缘裁字。 */}
    <div className="mt-[7px] flex min-w-0 flex-wrap items-center justify-between gap-x-2.5 gap-y-[3px] rounded-lg border border-merge/15 bg-merge/[0.055] px-2.5 py-2 text-[13px] text-muted-foreground">
      <span className="shrink-0 font-bold text-merge">如何获取</span>
      <p className="m-0 min-w-0 max-w-full">向小鲁班发送：<code className="font-mono text-xs font-semibold text-text-strong">“获取发送token”</code></p>
    </div>
    <div className="mt-[7px] flex min-w-0 flex-wrap items-center justify-between gap-x-2.5 gap-y-[3px] rounded-lg border border-merge/15 bg-merge/[0.055] px-2.5 py-2 text-[13px] text-muted-foreground">
      <span className="shrink-0 font-bold text-merge">手机回复</span>
      <p className="m-0 min-w-0 max-w-full">先输入 <code className="font-mono text-xs font-semibold text-text-strong">/mfc</code> 激活 Mae-Flow 插件，再按通知提示回复。</p>
    </div>

    <div className="mt-auto grid gap-2 pt-[15px]">
      {message && <span className="text-[13px] leading-[1.45] text-success">{message}</span>}
      {error && <span className="text-[13px] leading-[1.45] text-danger">{error}</span>}
      {!open && <div className="flex items-center gap-2.5">
        <button type="button" className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-primary bg-primary px-[13px] text-[13px] font-bold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50" disabled={testing}
          onClick={() => {
          setOpen(true); setMessage(""); setError("");
        }}>{hint ? "更新 Token" : "配置小鲁班"}</button>
        {hint && <button type="button" className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-line bg-transparent px-[13px] text-[13px] font-bold text-text hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || testing} onClick={() => void testConnection()}>
          {testing ? "测试中…" : "测试连通性"}
        </button>}
        {hint && <button type="button" className="min-h-[34px] cursor-pointer border-0 bg-transparent px-1 text-[13px] font-bold text-muted-foreground hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || testing}
          onClick={() => void save(true)}>清除</button>}
      </div>}
    </div>

    {open && <form className="mt-3.5 grid content-start gap-[11px] border-t border-line pt-3.5" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label className="grid gap-[5px]"><span className="text-[13px] font-bold text-text">小鲁班 Token</span>
          <Input type="password" value={token} required autoComplete="new-password"
            placeholder="粘贴小鲁班发送 Token"
            onChange={(event) => setToken(event.target.value)} />
          <small className="text-[13px] leading-[1.45] text-faint">保存后不会回显完整内容，仅显示末 4 位。</small>
        </label>
        <footer className="flex justify-end gap-2">
          <button type="button" className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-line bg-transparent px-[13px] text-[13px] font-bold text-text hover:border-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={busy}
            onClick={() => { setOpen(false); setToken(""); setError(""); }}>取消</button>
          <button type="submit" className="inline-flex min-h-[34px] cursor-pointer items-center rounded-lg border border-primary bg-primary px-[13px] text-[13px] font-bold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || !token.trim()}>
            {busy ? "保存中…" : "保存配置"}</button>
        </footer>
      </form>}
  </section>;
}
