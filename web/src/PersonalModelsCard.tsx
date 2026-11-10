/**
 * 个人模型网关(ADR-0068):成员在个人设置自配模型接入的四字段卡,
 * 表单惯例与管理页模型网关(SettingsView.ModelsCard)同一套。
 *
 * 语义:四字段配齐即整体生效——本人名下任务的主模型调用都走这套
 * 自己的接入,消耗记在自己的密钥账上;清空或删掉配置,即回落管理
 * 员配置的平台网关。生效于下一个新会话,进行中的任务不换道。
 * 密钥纪律同个人令牌:只写不读,输入框永远从空白开始,留空=沿用
 * 已存,界面只见末 4 位掩码。
 */

import { useState } from "react";
import {
  clearPersonalModels,
  postPersonalModelsCheck,
  putPersonalModels,
  type AuthUser,
  type PersonalModelsView,
  type SystemCheckResult,
} from "./api";
import { confirmDialog } from "./ConfirmDialog";
import { CheckItems, Feedback, useMessage } from "./SettingsView";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/** 字段排布同 SettingsView:grid + 6px 间距。 */
const fieldWrapClass = "grid gap-1.5";

/** 连通性结论徽标:与设置页自检同一色板。 */
const CHECK_VARIANT = {
  ok: "success", warning: "warning", error: "destructive",
} as const;

export function PersonalModelsCard({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged?: (patch: Partial<AuthUser>) => void;
}) {
  const initial = session.personal_models;
  const [saved, setSaved] = useState<PersonalModelsView>(
    initial ?? { configured: false });
  // 接口格式默认 OpenAI Chat,与管理页表单同拍板(2026-08-26)。
  const [apiFormat, setApiFormat] = useState(
    initial?.api ?? "openai-completions");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useMessage();
  const [testing, setTesting] = useState(false);
  const [checkResult, setCheckResult] = useState<SystemCheckResult>();
  const [checkError, setCheckError] = useState("");

  /** 保存/清除后对齐三处事实:本人视图(父级 session)、本地掩码态、
   * 表单字段——表单永远显示服务端刚确认过的配置,密钥回到空白。 */
  function applyView(next: PersonalModelsView) {
    setSaved(next);
    onChanged?.({ personal_models: next });
    setUrl(next.url ?? "");
    setModel(next.model ?? "");
    setApiFormat(next.api ?? "openai-completions");
    setApiKey("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    try {
      applyView(await putPersonalModels({
        url: url.trim(),
        api_key: apiKey.trim(),
        model: model.trim(),
        api: apiFormat,
      }));
      setMessage({ kind: "success",
        text: "已保存；你名下任务从下一个新会话起走这套接入，运行中的任务不受影响。可点「测试连通」验证。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  // 测的是当前表单值(未保存也能测);密钥留空时服务端沿用已存的,
  // 与保存的合并口径一致——界面永远不回填明文。
  async function runCheck() {
    setTesting(true); setCheckError(""); setCheckResult(undefined);
    try {
      setCheckResult(await postPersonalModelsCheck({
        url: url.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        api: apiFormat,
      }));
    } catch (cause) {
      setCheckError(String((cause as Error).message ?? cause));
    } finally { setTesting(false); }
  }

  async function clear() {
    if (!await confirmDialog({
      title: "清除个人模型网关",
      message: "将删除你名下的个人模型接入配置（含已保存的密钥）。删除后，你名下的任务从下一个新会话起回落使用管理员配置的平台网关，运行中的任务不受影响。",
      confirmLabel: "清除配置",
      danger: true,
    })) return;
    setBusy(true); setMessage(null);
    try {
      applyView(await clearPersonalModels());
      setMessage({ kind: "success",
        text: "已清除；你名下任务从下一个新会话起走平台网关。" });
    } catch (error) {
      setMessage({ kind: "error", text: String((error as Error).message ?? error) });
    } finally { setBusy(false); }
  }

  return <div id="personal-models"
    className="col-span-full grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
    <div className="bg-surface-2 p-7 text-muted-foreground">
      <h3 className="mb-2 text-[17px] font-bold text-text-strong">个人模型网关</h3>
      <p className="m-0 text-sm leading-[1.7]">配一套你自己的模型接入（地址、密钥、模型名称）。配齐后，你名下任务的模型调用都走你自己的接入，消耗记在你的密钥上；没配或清空，就统一用管理员配置的平台网关。API Key 保存后不会回显明文。</p>
      <span className={cn("mt-3.5 inline-flex w-fit items-center gap-1.5 rounded-full border px-[9px] py-[5px] text-[13px] font-bold",
        saved.configured
          ? "border-success/25 bg-success/10 text-success"
          : "border-line bg-surface-2 text-muted-foreground")}>
        <i aria-hidden className="size-1.5 rounded-full bg-current" />{saved.configured
          ? `已配置${saved.key_hint ? ` · Key ${saved.key_hint}` : ""}`
          : "未配置 · 走平台网关"}
      </span>
    </div>
    <form className="grid content-start gap-[15px] p-[26px]" onSubmit={submit}>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">网关地址</span>
        <Input value={url} type="url" required spellCheck={false}
          placeholder={apiFormat === "anthropic-messages"
            ? "例如：https://model-gateway.internal/api/anthropic"
            : "例如：https://model-gateway.internal/v1"}
          onChange={(event) => setUrl(event.target.value)} />
        <small className="text-[13px] leading-normal text-muted-foreground">
          {apiFormat === "anthropic-messages"
            ? "Anthropic Messages 兼容接口(请求发往 地址/v1/messages)。"
            : "OpenAI Chat 兼容接口(请求发往 地址/chat/completions)。"}
        </small>
      </label>
      <label className={cn("col-span-full", fieldWrapClass)}>
        <span className="text-[13px] font-medium text-muted-foreground">API Key</span>
        <Input value={apiKey} type="password" autoComplete="new-password"
          required={!saved.configured}
          placeholder={saved.configured
            ? `已保存 ${saved.key_hint ?? "密钥"}，留空保持不变`
            : "请输入你的模型网关 API Key"}
          onChange={(event) => setApiKey(event.target.value)} />
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">模型名称</span>
        <Input value={model} required spellCheck={false}
          placeholder="例如：glm-5.1"
          onChange={(event) => setModel(event.target.value)} />
      </label>
      <label className={fieldWrapClass}>
        <span className="text-[13px] font-medium text-muted-foreground">接口格式</span>
        <Select value={apiFormat}
          items={[{ value: "openai-completions", label: "OpenAI Chat" }, { value: "anthropic-messages", label: "Anthropic" }]}
          onValueChange={(value) => setApiFormat(value ?? "openai-completions")}>
          <SelectTrigger className="w-full" aria-label="接口格式"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="openai-completions">OpenAI Chat</SelectItem>
              <SelectItem value="anthropic-messages">Anthropic</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <small className="text-[13px] leading-normal text-muted-foreground">按网关实际提供的接口协议选择</small>
      </label>
      <div className="col-span-full flex flex-wrap items-center gap-2.5">
        <Button type="submit" disabled={busy || testing}>
          {busy ? "正在保存…" : "保存个人网关"}</Button>
        <Button type="button" variant="outline" disabled={busy || testing}
          onClick={() => void runCheck()}>
          {testing ? "测试中…" : "测试连通"}</Button>
        {saved.configured && <Button type="button" variant="destructive"
          disabled={busy || testing} onClick={() => void clear()}>
          清除配置</Button>}
      </div>
      <small className="text-[13px] leading-normal text-muted-foreground">测试使用当前表单值向网关发送一条极小请求（密钥留空时沿用已保存的）。清除配置后，你名下的任务回落走管理员配置的平台网关。</small>
      <Feedback message={message} />
      {checkError && <div className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{checkError}</div>}
      {testing && !checkResult && !checkError
        && <div className="text-sm text-muted-foreground">正在连通网关并等待模型回复…</div>}
      {checkResult && <>
        <Badge variant={CHECK_VARIANT[checkResult.overall]}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
          {checkResult.overall === "ok"
            ? "网络与模型问答均正常" : "存在问题，见下方明细"}
        </Badge>
        <CheckItems result={checkResult} />
      </>}
    </form>
  </div>;
}
