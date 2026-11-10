/**
 * 环境新增/编辑弹层(从 EnvironmentRegistry 抽出的共用件,2026-09-10):
 * 台账页签与「环境快选」(EnvironmentPicker 的「找不到就新建」)共用
 * 同一张表单——字段、校验、409 引导、测试连接只有一份。
 *
 * 新增路径 onSaved 会带回创建成功的台账视图:快选侧用它「录完即选中」;
 * 台账页签忽略入参只刷新列表。编辑路径不回传条目(调用方自行刷新)。
 *
 * 密码纪律(ADR-0020):表单永不回显密码——编辑时后台密码只显示"已配置"
 * 占位,留空 = 不变;root 密码留空 = 继承后台密码,已单独配置的条目可一键
 * 清除回落继承。台账全员可读写,写操作 updated_by 由服务端记。
 */
import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  createEnvironment,
  probeEnvironment,
  testEnvironmentConnection,
  updateEnvironment,
  EnvironmentIpConflictError,
  type EnvironmentForm,
  type EnvironmentTestOutcome,
  type EnvironmentView,
} from "./api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 环境形态的页面文案(CONTEXT.md「环境形态」:虚拟化/容器化二选一)。 */
export const ENVIRONMENT_FORM_TEXT: Record<EnvironmentForm, string> = {
  virtualized: "虚拟化",
  k8s: "容器化",
};

/** 探活失败原因二分(#151):auth=密码改了,unreachable=机器关了。 */
export const PROBE_REASON_TEXT: Record<
  NonNullable<EnvironmentView["probe"]["reason"]>,
  string
> = {
  auth: "认证失败",
  unreachable: "不可达",
};

const fieldLabelClass = "text-sm font-medium text-foreground";
const fieldWrapClass = "grid gap-1.5";

const tagChipRemoveClass =
  "ml-0.5 inline-flex size-4 items-center justify-center rounded-full hover:bg-accent";

export function EnvironmentEditorDialog({
  existing,
  environments,
  onClose,
  onSaved,
  onProbed,
  onSwitchTo,
}: {
  /** 缺席 = 新增;有值 = 编辑该条。 */
  existing?: EnvironmentView;
  /** 409 引导用的台账快照(拿调用方已加载的列表,不重复拉取)。 */
  environments: EnvironmentView[];
  onClose: () => void;
  /** 新增成功带回新条目(快选侧「录完即选中」);编辑成功不带。 */
  onSaved: (created?: EnvironmentView) => void;
  /** 编辑态「测试连接」探活回传(台账页签就地刷新状态列;快选侧可缺省)。 */
  onProbed?: (entry: EnvironmentView) => void;
  /** 409 命中既有条目时引导「编辑既有条目」(快选侧同样能接;可缺省)。 */
  onSwitchTo?: (entry: EnvironmentView) => void;
}) {
  const [ip, setIp] = useState(existing?.ip ?? "");
  const [portDraft, setPortDraft] = useState(String(existing?.port ?? 22));
  const [form, setForm] = useState<EnvironmentForm>(existing?.form ?? "virtualized");
  const [backendPassword, setBackendPassword] = useState("");
  const [rootPassword, setRootPassword] = useState("");
  /** 编辑态点了"清除并回落继承":保存时 root_password 送 null。 */
  const [clearRoot, setClearRoot] = useState(false);
  const [tags, setTags] = useState<string[]>(existing?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  /** 409 命中的既有条目(表单内报"该 IP 已存在于台账"并引导编辑)。 */
  const [conflict, setConflict] = useState<EnvironmentView>();
  /** 测试连接三态:outcome 空缺 = 空闲;testing = 探测中;有 outcome = 有
   * 结论(就地内联展示,不关弹层)。 */
  const [testing, setTesting] = useState(false);
  const [testOutcome, setTestOutcome] = useState<EnvironmentTestOutcome>();
  const [testError, setTestError] = useState("");
  /** 编辑时若已单独配置 root 密码,给标记与清除入口(非密布尔,可展示)。 */
  const hasExplicitRoot = !!existing && !existing.root_password_inherited;

  function commitTagDraft(event: KeyboardEvent<HTMLInputElement>) {
    // 回车成标签;输入法组词中的回车是选字,不是提交。
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagDraft("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmedIp = ip.trim();
    if (!trimmedIp) {
      setFormError("主 IP 不能为空");
      return;
    }
    const port = portDraft.trim() === "" ? undefined : Number(portDraft);
    if (port !== undefined
        && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setFormError("端口必须是 1-65535");
      return;
    }
    if (!existing && !backendPassword) {
      setFormError("后台密码不能为空");
      return;
    }
    setBusy(true);
    setFormError("");
    setConflict(undefined);
    try {
      if (existing) {
        await updateEnvironment(existing.id, {
          ip: trimmedIp,
          ...(port !== undefined ? { port } : {}),
          form,
          tags,
          // 密码不回显、留空 = 不变:空串就不进 payload(缺席语义)。
          ...(backendPassword ? { backend_password: backendPassword } : {}),
          // root:清除了显式值送 null 回落继承;填了新值送值;都没动就缺席。
          ...(clearRoot ? { root_password: null }
            : rootPassword ? { root_password: rootPassword } : {}),
        });
        onSaved();
      } else {
        const created = await createEnvironment({
          ip: trimmedIp,
          ...(port !== undefined ? { port } : {}),
          form,
          backend_password: backendPassword,
          ...(rootPassword ? { root_password: rootPassword } : {}),
          tags,
        });
        onSaved(created);
      }
    } catch (cause) {
      if (cause instanceof EnvironmentIpConflictError) {
        setConflict(
          environments.find((entry) => entry.id === cause.existingId));
        setFormError("该 IP 已经登记过(环境管理里已有这台环境)");
      } else {
        setFormError(cause instanceof Error ? cause.message : "保存失败");
      }
    } finally {
      setBusy(false);
    }
  }

  /** 测试连接(#151)的调用分野:新增态用表单当前值走 /environments/test
   * (只探测不落库,后台密码必须已填);编辑态前端无密码,直接对已存条目
   * 探活走 /:id/probe,结论持久化进台账、状态列随 onProbed 就地刷新。
   * 探测失败是结论不是错误:正常/异常+原因都内联展示,弹层不关。 */
  async function runTestConnection() {
    if (testing) return;
    setTestOutcome(undefined);
    setTestError("");
    let port: number | undefined;
    if (!existing) {
      const trimmedIp = ip.trim();
      if (!trimmedIp) {
        setTestError("主 IP 不能为空");
        return;
      }
      port = portDraft.trim() === "" ? undefined : Number(portDraft);
      if (port !== undefined
          && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        setTestError("端口必须是 1-65535");
        return;
      }
      if (!backendPassword) {
        setTestError("后台密码不能为空");
        return;
      }
    }
    setTesting(true);
    try {
      if (existing) {
        const updated = await probeEnvironment(existing.id);
        onProbed?.(updated);
        setTestOutcome(updated.probe.state === "failed"
          ? { ok: false, reason: updated.probe.reason ?? "unreachable" }
          : { ok: true });
      } else {
        setTestOutcome(await testEnvironmentConnection({
          ip: ip.trim(),
          ...(port !== undefined ? { port } : {}),
          backend_password: backendPassword,
        }));
      }
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : "测试连接失败");
    } finally {
      setTesting(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="tw-root sm:max-w-lg"
      aria-labelledby="environment-editor-title">
      <DialogHeader>
        <DialogTitle id="environment-editor-title">
          {existing ? `编辑环境 ${existing.ip}` : "新增环境"}
        </DialogTitle>
        <DialogDescription>
          {existing
            ? "密码留空表示保持不变;root 密码留空表示继续沿用后台密码。"
            : "同一 IP 只登记一台;root 密码留空时与后台密码相同。"}
        </DialogDescription>
      </DialogHeader>
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className={fieldWrapClass}>
            <span className={fieldLabelClass}>主 IP</span>
            <Input value={ip}
              onChange={(event) => setIp(event.target.value)}
              placeholder="例如 192.0.2.12" autoFocus required />
          </label>
          <label className={fieldWrapClass}>
            <span className={fieldLabelClass}>端口</span>
            <Input type="number" min={1}
              max={65535} value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              placeholder="22" />
          </label>
        </div>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>环境形态</span>
          <Select value={form}
            items={{
              virtualized: "虚拟化(经网管节点)",
              k8s: "容器化(经 OM 节点)",
            }}
            onValueChange={(next) => setForm((next ?? "virtualized") as EnvironmentForm)}>
            <SelectTrigger className="w-full" aria-label="环境形态">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectItem value="virtualized">虚拟化(经网管节点)</SelectItem>
              <SelectItem value="k8s">容器化(经 OM 节点)</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>后台密码</span>
          {/* 永不回显:编辑时只给"已配置"占位,值永远不进 value/URL/列表。 */}
          <Input type="password"
            value={backendPassword}
            onChange={(event) => setBackendPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={existing ? "已配置——留空表示不变" : "operator 三账号共用的密码"}
            required={!existing} />
        </label>
        <label className={fieldWrapClass}>
          <span className={fieldLabelClass}>root 密码(可选)</span>
          <Input type="password"
            value={clearRoot ? "" : rootPassword}
            onChange={(event) => {
              setRootPassword(event.target.value);
              setClearRoot(false);
            }}
            autoComplete="new-password"
            placeholder="留空时与后台密码相同"
            disabled={clearRoot} />
        </label>
        {hasExplicitRoot && !clearRoot && <div className="flex items-center gap-2">
          <Badge variant="outline">已单独配置 root 密码</Badge>
          <Button type="button" variant="ghost" size="xs"
            onClick={() => setClearRoot(true)}>清除,改回与后台密码相同</Button>
        </div>}
        {clearRoot && <p className="text-xs text-muted-foreground">
          保存后 root 密码将与后台密码相同。
          <button type="button"
            className="ml-1 text-ink underline underline-offset-4"
            onClick={() => setClearRoot(false)}>撤销</button>
        </p>}
        <div className={fieldWrapClass}>
          <span className={fieldLabelClass}>标签</span>
          <Input value={tagDraft}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={commitTagDraft}
            placeholder="自由输入,回车成标签(如 华为云、v6版本)" />
          {tags.length > 0 && <div className="flex flex-wrap gap-1">
            {tags.map((tag) => <Badge key={tag} variant="secondary">
              {tag}
              <button type="button" className={tagChipRemoveClass}
                aria-label={`移除标签 ${tag}`}
                onClick={() => setTags(tags.filter((item) => item !== tag))}>
                ×
              </button>
            </Badge>)}
          </div>}
        </div>
        {/* 测试连接(#151):结果就地内联展示(正常/异常+原因),不关弹层;
             编辑态走台账已存密码探活,结论顺带持久化进台账。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            disabled={testing}
            onClick={() => void runTestConnection()}>
            {testing ? "探测中…" : "测试连接"}
          </Button>
          {testOutcome?.ok && <Badge variant="outline"
            className="border-success/40 bg-success-soft text-success">连接正常</Badge>}
          {testOutcome && !testOutcome.ok && <span
            className="text-sm text-danger">
            连接异常:{PROBE_REASON_TEXT[testOutcome.reason] ?? testOutcome.reason}
          </span>}
          {testError && <span className="text-sm text-danger">{testError}</span>}
        </div>
        <p className="text-xs text-muted-foreground">
          密码加密保存在服务端,不会明文出现在页面或事件记录里;
          问题处理用到这台环境时,会由服务端解密并明文提供给当前 AI 会话。
          请仅使用现场专用或演示口令,不要使用个人复用或生产口令。
        </p>
        {(formError || conflict) && <div role="alert"
          className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          <p>{formError}</p>
          {conflict && onSwitchTo && <p className="mt-1">
            <button type="button"
              className="text-ink underline underline-offset-4"
              onClick={() => onSwitchTo(conflict)}>编辑既有条目({conflict.ip})</button>
          </p>}
        </div>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : existing ? "保存修改" : "保存"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
