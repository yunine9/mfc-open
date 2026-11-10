import { useEffect, useRef, useState } from "react";
import {
  archiveBusinessKnowledgeAsset,
  getBusinessKnowledgeAsset,
  getBusinessModules,
  publishBusinessKnowledgeAsset,
  type BusinessKnowledgeAsset,
  type BusinessModule,
  type BusinessModuleCatalog,
} from "./api";
import {
  knowledgeAssetElementId,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";
import { confirmDialog } from "./ConfirmDialog";
import { Alert } from "@/components/Alert";
import { Empty, EmptyTitle, EmptyDescription } from "@/components/Empty";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "cn";

type BusinessAssetFocus = Extract<KnowledgeAssetFocus, { kind: "business" }>;

/* 库内裸按钮的统一工具类配方(原 .business-module-library button 家族)。 */
const BTN = "inline-flex min-h-[31px] cursor-pointer items-center rounded-[7px] border border-line bg-surface px-2.5 text-[13px] font-bold text-muted-foreground hover:border-line-strong hover:text-text disabled:cursor-default disabled:opacity-55";
const BTN_PRIMARY = "inline-flex min-h-[31px] cursor-pointer items-center rounded-[7px] border border-primary bg-primary px-2.5 text-[13px] font-bold text-primary-foreground hover:bg-primary/90 disabled:cursor-default disabled:opacity-55";
const BTN_DANGER = "inline-flex min-h-[31px] cursor-pointer items-center rounded-[7px] border border-danger/35 bg-surface px-2.5 text-[13px] font-bold text-danger hover:bg-danger/10 disabled:cursor-default disabled:opacity-55";
const LABEL = "grid min-w-0 gap-[5px]";
const LABEL_SPAN = "text-[13px] font-bold text-muted-foreground";
const FORM_GRID = "grid gap-2.5 max-[700px]:grid-cols-1 sm:grid-cols-2";
const FORM_ACTIONS = "flex items-center justify-end gap-2";

async function sha256(content: string): Promise<string> {
  const value = await globalThis.crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(value)]
    .map((item) => item.toString(16).padStart(2, "0")).join("");
}

function AssetEditor({ module, asset, initialContent, onSaved, onCancel }: {
  module: BusinessModule;
  asset?: BusinessKnowledgeAsset;
  initialContent?: string;
  onSaved: (module: BusinessModule) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(asset?.id ?? "");
  const [title, setTitle] = useState(asset?.title ?? "");
  const [summary, setSummary] = useState(asset?.summary ?? "");
  const [whenToUse, setWhenToUse] = useState(asset?.when_to_use ?? "");
  const [form, setForm] = useState(asset?.form ?? "document");
  const [repositories, setRepositories] = useState(asset?.repositories ?? []);
  const [content, setContent] = useState(initialContent ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="mx-4 my-3 grid content-start gap-[11px] rounded-[10px] border border-line bg-surface-2 p-3.5" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      onSaved(await publishBusinessKnowledgeAsset(module.id, id, {
        title, summary, when_to_use: whenToUse, form, repositories, content,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识发布失败");
    } finally { setBusy(false); }
  }}>
    <div className={FORM_GRID}>
      <label className={LABEL}><span className={LABEL_SPAN}>资产 ID</span><Input value={id} disabled={!!asset}
        onChange={(event) => setId(event.target.value)}
        placeholder="例如 release-checklist" required /></label>
      <label className={LABEL}><span className={LABEL_SPAN}>标题</span><Input value={title}
        onChange={(event) => setTitle(event.target.value)} required /></label>
    </div>
    <label className={LABEL}><span className={LABEL_SPAN}>一句话摘要</span><Textarea rows={2} value={summary}
      onChange={(event) => setSummary(event.target.value)} required /></label>
    <label className={LABEL}><span className={LABEL_SPAN}>什么时候应该读</span><Textarea rows={2} value={whenToUse}
      onChange={(event) => setWhenToUse(event.target.value)} required /></label>
    <div className={FORM_GRID}>
      <label className={LABEL}><span className={LABEL_SPAN}>知识形态</span><Select value={form}
        items={[{ value: "document", label: "文档" }, { value: "skill", label: "Skill" }, { value: "rule", label: "规则" }, { value: "example", label: "示例" }]}
        onValueChange={(value) => setForm((value ?? form) as typeof form)}>
        <SelectTrigger className="w-full" aria-label="知识形态"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="document">文档</SelectItem>
            <SelectItem value="skill">Skill</SelectItem>
            <SelectItem value="rule">规则</SelectItem>
            <SelectItem value="example">示例</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select></label>
      <div className="grid gap-1.5">
        <span className="text-[13px] font-bold text-muted-foreground">适用代码仓（可选）</span>
        <small className="text-[13px] text-faint">不选表示适用于该模块关联的全部仓库。</small>
        {module.repositories.length ? <div className="flex flex-wrap gap-1.5">
          {module.repositories.map((repository) => <button type="button"
            key={repository} title={repository}
            aria-pressed={repositories.includes(repository)}
            className={cn("inline-flex cursor-pointer items-baseline gap-[5px] rounded-[7px] border px-[9px] py-[5px] text-[13px]",
              repositories.includes(repository)
                ? "border-primary bg-primary/10 font-bold text-primary"
                : "border-line bg-surface text-muted-foreground hover:border-line-strong")}
            onClick={() => setRepositories((current) =>
              current.includes(repository)
                ? current.filter((item) => item !== repository)
                : [...current, repository])}>
            {repository.replace(/\/+$/, "").split("/").at(-1)
              ?.replace(/\.git$/i, "") || repository}</button>)}
        </div> : <small>模块尚未关联仓库，当前知识默认对模块内全部任务适用。</small>}
      </div>
    </div>
    <label className={LABEL}><span className={LABEL_SPAN}>知识正文（Markdown）</span><Textarea className="font-mono"
      rows={12} value={content}
      onChange={(event) => setContent(event.target.value)} required /></label>
    <p className="-mt-0.5 text-[13px] text-faint">发布会产生新版本；已经发起的任务继续使用自己的固定快照。</p>
    {error && <Alert variant="destructive" role="alert" className="mx-4 my-2.5">{error}</Alert>}
    <div className={FORM_ACTIONS}>
      <button type="button" className={BTN} onClick={onCancel}>取消</button>
      <button type="submit" className={BTN_PRIMARY} disabled={busy}>
        {busy ? "发布中…" : asset ? `发布 v${asset.version + 1}` : "发布知识"}
      </button>
    </div>
  </form>;
}

export function BusinessModuleLibrary({ initialAsset }: {
  initialAsset?: BusinessAssetFocus;
}) {
  const [catalog, setCatalog] = useState<BusinessModuleCatalog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(initialAsset?.moduleId ?? "");
  const [editingAsset, setEditingAsset] = useState<{
    moduleId: string; asset?: BusinessKnowledgeAsset; content?: string }>();
  const [document, setDocument] = useState<{
    moduleId: string; assetId: string; title: string; content: string;
    version: number; digest: string }>();
  const [documentLoading, setDocumentLoading] = useState("");
  const documentRequest = useRef(0);

  const refresh = async () => {
    setLoading(true); setError("");
    try { setCatalog(await getBusinessModules()); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : "业务模块读取失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);


  const replace = (updated: BusinessModule) => setCatalog((current) =>
    current ? { ...current, modules: current.modules.map((module) =>
      module.id === updated.id ? updated : module) } : current);

  const openAsset = async (module: BusinessModule, asset: BusinessKnowledgeAsset,
    edit = false, expected?: Pick<BusinessAssetFocus, "version" | "digest">) => {
    const key = `${module.id}/${asset.id}`;
    const request = ++documentRequest.current;
    setDocumentLoading(key); setError("");
    try {
      const value = await getBusinessKnowledgeAsset(
        module.id, asset.id, expected?.version);
      const contentDigest = expected ? await sha256(value.content)
        : value.asset.digest;
      if (expected && (contentDigest !== expected.digest
          || value.asset.digest !== expected.digest
          || value.asset.version !== expected.version)) {
        throw new Error(
          `模块知识 ${asset.title} 的 v${expected.version} 正文与清单指纹不一致，`
          + "已停止展示，不能把当前内容当作同一版本");
      }
      if (documentRequest.current !== request) return;
      if (edit) {
        setEditingAsset({ moduleId: module.id, asset, content: value.content });
        setDocument(undefined);
      } else {
        setDocument({ moduleId: module.id, assetId: asset.id,
          title: value.asset.title, content: value.content,
          version: value.asset.version,
          digest: value.asset.digest });
      }
    } catch (reason) {
      if (documentRequest.current === request) {
        setDocument(undefined);
        setError(reason instanceof Error ? reason.message : "知识正文读取失败");
      }
    } finally {
      if (documentRequest.current === request) setDocumentLoading("");
    }
  };

  useEffect(() => {
    if (!initialAsset || !catalog) return;
    const module = catalog.modules.find((item) => item.id === initialAsset.moduleId);
    const asset = module?.assets.find((item) => item.id === initialAsset.assetId);
    if (!module || !asset) {
      let active = true;
      void getBusinessKnowledgeAsset(initialAsset.moduleId, initialAsset.assetId, initialAsset.version).then(value => {
        if (!active) return;
        const target = catalog.modules.find(item => item.id === value.module_id);
        const current = target?.assets.find(item => item.id === value.asset.id);
        if (!target || !current) throw new Error("要核对的模块知识已不存在，请返回发起页重新核对。");
        setExpanded(target.id);
        void openAsset(target, current, false, initialAsset);
      }).catch(error => { if (active) setError(error.message); });
      return () => { active = false; };
    }
    setExpanded(module.id);
    setDocument(undefined);
    void openAsset(module, asset, false, initialAsset);
  }, [catalog, initialAsset]);

  useEffect(() => {
    if (!initialAsset || document?.moduleId !== initialAsset.moduleId
        || document.assetId !== initialAsset.assetId) return;
    requestAnimationFrame(() => globalThis.document.getElementById(
      `${knowledgeAssetElementId("business", document.moduleId,
        document.assetId)}-document`,
    )?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [document, initialAsset]);

  return <section className="m-0 overflow-hidden rounded-[18px] border border-line bg-surface shadow-sm" aria-labelledby="business-module-library-title">
    <header className="flex items-center justify-between gap-[18px] border-b border-line bg-gradient-to-br from-surface-2 to-surface px-6 py-[21px]">
      <div className="min-w-0">
        <h3 id="business-module-library-title" className="mt-[5px] mb-1 text-[21px] tracking-[-0.025em] text-text-strong">模块知识</h3>
        <p className="m-0 text-sm leading-[1.55] text-muted-foreground">在这里上传与维护模块知识；模块及代码仓映射统一从配置中心读取。</p>
      </div>
      <div className="flex flex-none items-center gap-2"><span className="text-[13px] text-faint">{catalog?.modules.filter((item) => item.status === "active").length ?? 0} 个启用</span>
        <a className={BTN} href="/configuration?tab=modules">维护模块映射</a>
        <button type="button" className={BTN} onClick={() => void refresh()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}</button>
      </div>
    </header>

    {error && <Alert variant="destructive" role="alert" className="mx-4 my-2.5">{error}</Alert>}
    {!!catalog?.warnings.length && <Alert variant="warning" className="mx-4 my-2.5">
      {catalog.warnings.join("；")}</Alert>}
    {!loading && !catalog?.modules.length && <Empty className="mx-3.5 my-3.5 border p-5.5">
      <EmptyTitle>还没有业务模块</EmptyTitle>
      <EmptyDescription>先到配置中心创建模块，再在这里上传知识。所有成员均可维护。</EmptyDescription>
    </Empty>}

    <div className="grid">
      {(catalog?.modules ?? []).map((module) => {
        const open = expanded === module.id;
        const allLiveAssets = module.assets.filter((asset) =>
          asset.status === "published");
        const liveAssets = allLiveAssets;
        return <article key={module.id} className={cn("border-t border-line first:border-t-0", module.status === "archived" && "opacity-70")}>
          <button type="button" className="grid w-full cursor-pointer grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-[11px] border-0 bg-transparent px-4 py-3 text-left hover:bg-surface-2"
            aria-expanded={open} onClick={() => setExpanded(open ? "" : module.id)}>
            <span className="grid size-9 place-items-center rounded-[10px] bg-primary/10 text-[15px] font-extrabold text-primary">{module.name.slice(0, 1)}</span>
            <span className="grid min-w-0 gap-1"><span className="flex flex-wrap items-baseline gap-[7px]"><strong className="text-sm text-text-strong">{module.name}</strong><code className="text-xs text-faint">{module.id}</code>
              {module.status === "archived" && <em className="rounded bg-attention/10 px-[5px] py-px text-[13px] not-italic text-attention">已归档</em>}</span>
              <small className="truncate text-[13px] text-muted-foreground">{module.description}</small>
              <span className="text-[13px] text-faint">{allLiveAssets.length} 项知识 · revision {module.revision}</span>
            </span>
            <i aria-hidden className="text-[13px] not-italic text-primary">{open ? "收起" : "展开"}</i>
          </button>
          {open && <div className="grid gap-2.5 px-4 pb-4 pl-[63px]">
            <div className="grid gap-[7px] rounded-lg bg-surface-2 p-[11px]">
              <strong className="text-[13px] text-text-strong">关联范围</strong>
              <div className="flex flex-wrap gap-[5px]">{module.repositories.length ? module.repositories.map((repo) =>
                <code key={repo} className="max-w-full truncate rounded bg-surface px-1.5 py-[3px] text-xs text-muted-foreground">{repo}</code>) : <span className="text-[13px] text-faint">未关联仓库，不参与下单推荐</span>}</div>
              {!!module.maintainers.length && <small className="text-[13px] text-faint">维护者：{module.maintainers.join("、")}</small>}
            </div>
            {module.can_manage && <div className="flex justify-end gap-[7px]">
              <button type="button" className={BTN_PRIMARY} disabled={module.status !== "active"}
                onClick={() => {
                  setEditingAsset({ moduleId: module.id });
                  setDocument(undefined);
                }}>发布知识</button>
            </div>}
            {editingAsset?.moduleId === module.id && <AssetEditor module={module}
              asset={editingAsset.asset} initialContent={editingAsset.content}
              onCancel={() => setEditingAsset(undefined)}
              onSaved={(updated) => { replace(updated); setEditingAsset(undefined); }} />}
            <div className="overflow-hidden rounded-[9px] border border-line">
              <div className="flex items-baseline justify-between gap-3 bg-surface-2 px-[11px] py-2"><strong className="text-[13px] text-text-strong">已发布知识</strong>
                <small className="text-[13px] text-faint">点击名称查看正文；任务只会获得选中模块当时的固定版本。</small></div>
              {liveAssets.map((asset) => <div
                id={knowledgeAssetElementId("business", module.id, asset.id)}
                className={cn("flex items-center gap-3 border-t border-line px-[11px] py-2.5",
                  initialAsset?.moduleId === module.id && initialAsset.assetId === asset.id
                    && "scroll-mt-6 border-primary/60 ring-2 ring-primary/10")}
                key={asset.id}>
                <button type="button" className="group grid min-w-0 flex-1 cursor-pointer gap-[3px] border-0 bg-transparent p-0 text-left"
                  disabled={documentLoading === `${module.id}/${asset.id}`}
                  onClick={() => void openAsset(module, asset)}>
                  <span className="flex items-baseline gap-[7px]"><strong className="text-[13.5px] text-text-strong group-hover:underline group-hover:underline-offset-[3px]">{asset.title}</strong><code className="text-xs text-primary">v{asset.version}</code></span>
                  <small className="truncate text-[13px] text-muted-foreground">{asset.summary}</small>
                  <em className="text-[13px] not-italic text-faint">何时读：{asset.when_to_use}</em>
                  <span className="mt-[3px] flex flex-wrap items-center gap-1">
                    <em className="rounded-full border border-success/40 bg-success/10 px-1.5 py-px text-xs font-bold not-italic leading-[1.5] text-success">业务知识</em>
                    <em className="rounded-full border border-line-strong bg-surface-2 px-1.5 py-px text-xs font-bold not-italic leading-[1.5] text-muted-foreground">{{ document: "文档", skill: "Skill",
                      rule: "规则", example: "示例" }[asset.form]}</em>
                    {asset.repositories.map((repository) => <em
                      className="max-w-[180px] truncate rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-xs font-semibold not-italic leading-[1.5] text-primary" key={repository}>
                      {repository.replace(/\/+$/, "").split("/").at(-1)
                        ?.replace(/\.git$/i, "") || repository}</em>)}
                  </span>
                </button>
                {module.can_manage && <div className="flex flex-none gap-1.5">
                  <button type="button" className={BTN} onClick={() => void openAsset(module, asset, true)}>更新</button>
                  <button type="button" className={BTN_DANGER} onClick={async () => {
                    if (!await confirmDialog({
                      title: "归档知识",
                      message: `将归档知识「${asset.title}」。历史任务不受影响。`,
                      confirmLabel: "归档",
                    })) return;
                    try { replace(await archiveBusinessKnowledgeAsset(module.id, asset.id)); }
                    catch (reason) { setError(reason instanceof Error ? reason.message : "归档失败"); }
                  }}>归档</button>
                </div>}
              </div>)}
              {!liveAssets.length && <Empty className="border-t rounded-none py-4.5">
                还没有已发布知识。团队成员可以从一项明确、可复用的知识开始。</Empty>}
            </div>
            {document?.moduleId === module.id && <div
              id={`${knowledgeAssetElementId("business", document.moduleId,
                document.assetId)}-document`}
              className="overflow-hidden rounded-[9px] border border-line bg-surface-2 [scroll-margin-top:24px]"
              aria-label={`${document.title} 全文`}>
              <header className="flex items-center justify-between gap-3 border-b border-line px-[11px] py-2"><strong className="text-[13px] text-text-strong">{document.title} · 全文 · v{document.version}
                {` · 指纹 ${document.digest.slice(0, 8)} 已对拍`}</strong><button type="button"
                className="cursor-pointer border-0 bg-transparent text-[13px] text-muted-foreground"
                onClick={() => setDocument(undefined)}>关闭正文</button></header>
              <pre className="m-0 max-h-[460px] overflow-auto p-[13px] font-mono text-xs leading-[1.65] whitespace-pre-wrap text-text [overflow-wrap:anywhere]">{document.content}</pre>
            </div>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}


/** 知识库内直接复用原资产编辑器，不切换到模块管理页面。 */
export function BusinessAssetEditor({moduleId,assetId,onDone}:{moduleId:string;assetId:string;onDone:()=>void}) {
  const [module,setModule]=useState<BusinessModule>();
  const [content,setContent]=useState<string>();
  const [currentAssetId,setCurrentAssetId]=useState(assetId);
  const [error,setError]=useState("");
  useEffect(()=>{let live=true;void Promise.all([getBusinessModules(),getBusinessKnowledgeAsset(moduleId,assetId)]).then(([catalog,doc])=>{if(live){const target=catalog.modules.find(m=>m.id===doc.module_id);if(!target?.assets.some(a=>a.id===doc.asset.id)){setError("资料已不存在，请刷新列表");return;}setModule(target);setCurrentAssetId(doc.asset.id);setContent(doc.content);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[moduleId,assetId]);
  if(error)return <Alert variant="destructive">{error}</Alert>;
  const asset=module?.assets.find(a=>a.id===currentAssetId);
  return module && asset && content !== undefined ? <AssetEditor module={module} asset={asset} initialContent={content} onSaved={onDone} onCancel={onDone}/> : <p>正在读取资料…</p>;
}
