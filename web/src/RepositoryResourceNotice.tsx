import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Preview = { path: string; rules: string[]; content?: string; note?: string };
type Repository = { repository: string; revision: string; error?: string;
  blocked_resources?: { files: Preview[]; truncated: boolean } };

/** Informational only: reading blocked text never selects or enables it. */
export function RepositoryResourceNotice({ repositories, baseline }: { repositories: string[]; baseline?: string }) {
  const [rules, setRules] = useState<string[]>([]);
  const [policyError, setPolicyError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<Repository[] | null>(null);
  const scan = useRef<AbortController | null>(null);
  const repoKey = JSON.stringify([...new Set(repositories.map(repo => repo.trim()).filter(Boolean))]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/repository-resource-policy", { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(value => setRules(value.rules ?? []))
      .catch(() => { if (!controller.signal.aborted) setPolicyError(true); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    scan.current?.abort(); setBusy(false); setResults(null); setError("");
    return () => scan.current?.abort();
  }, [repoKey, baseline]);
  const close = () => { scan.current?.abort(); setBusy(false); setOpen(false); };
  async function inspect() {
    scan.current?.abort();
    const controller = new AbortController(); scan.current = controller;
    setBusy(true); setError(""); setResults(null);
    try {
      const response = await fetch("/repository-skills/scan", { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositories: JSON.parse(repoKey), baseline: baseline?.trim() || undefined, preview_blocked: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "读取失败");
      if (!controller.signal.aborted) setResults(data.repositories);
    } catch (cause) { if (!controller.signal.aborted) setError(String((cause as Error).message)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (policyError) return <small role="status">暂未读到平台资源屏蔽配置,不影响发起。</small>;
  if (!rules.length) return null;
  return <>
    {/* 提示条(2026-09-14 设计审查 04):原 ghost 文字钮带 inline style
        硬编码字号,在登记表单两列网格里独占左半格,右侧空半格像孤儿;
        改一行细提示条(与凭据门禁条同款语义:左说明右动作),样式走
        工具类轨道,跨全列由调用侧网格落位。 */}
    <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-line bg-surface-muted px-3.5 py-2.5 text-[13px] leading-normal text-muted-foreground">
      <span>本任务将按平台 {rules.length} 条规则屏蔽仓库 Skill/指令文件</span>
      <Button type="button" variant="outline" size="sm" className="border-current text-inherit"
        onClick={() => setOpen(true)}>
        查看详情
      </Button>
    </div>
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="tw-root sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>仓库资源屏蔽</DialogTitle>
          <DialogDescription>以下资源不作为 Agent 执行指令加载,仓库文件仍保留。查看正文不会解除屏蔽。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-auto flex flex-col gap-2">
          <ul className="flex flex-col gap-1">{rules.map(rule => <li key={rule}><code>{rule}</code></li>)}</ul>
        <Button type="button" variant="outline" className="self-start" disabled={busy || JSON.parse(repoKey).length === 0} onClick={() => void inspect()}>
          {busy ? "正在读取…" : "查看当前仓库中被屏蔽的内容"}
        </Button>
        {JSON.parse(repoKey).length === 0 && <p>填写代码仓或选择业务模块后,可查看命中文件。</p>}
        <p><small>读取所选基线的远端仓库内容;拉取后才注入的文件无法在发起前预览,但仍按上述规则屏蔽。</small></p>
        {error && <p role="alert">{error},可重试;不影响发起。</p>}
        {results?.map(repo => <section key={repo.repository}>
          <h4 title={repo.repository}>{repo.repository.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "")}</h4>
          {repo.error ? <p role="alert">{repo.error}</p> : <>
            <small>仓库版本 {repo.revision.slice(0, 12)}</small>
            {!repo.blocked_resources?.files.length && <p>此版本未发现命中文件。</p>}
            {repo.blocked_resources?.files.map(file => <details key={file.path}>
              <summary>{file.path}</summary>
              <small>命中规则:{file.rules.join("、")}</small>
              {file.note && <p>{file.note}</p>}
              {file.content !== undefined && <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-[1.6] text-inherit">{file.content || "(空文件)"}</pre>}
            </details>)}
            {repo.blocked_resources?.truncated && <p>命中较多,仅展示前 30 个文件。</p>}
          </>}
        </section>)}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
