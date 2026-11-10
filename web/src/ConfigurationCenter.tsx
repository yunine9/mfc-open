import { WorkflowAssetWorkspace } from "./workflows";
import { ComponentRepositories } from "./ComponentRepositories";
import { TechnologyStacks } from "./TechnologyStackSettings";
import { useEffect, useState } from "react";
import { EnvironmentRegistry } from "./EnvironmentRegistry";
import { getBusinessModules, createBusinessModule, updateBusinessModule, previewBusinessModuleMigration, migrateBusinessModule, type BusinessModuleMigrationPreview,
  productVersionRequest, knowledgeRepoRequest, listPeople,
  type BusinessModule, type MrParticipants, type PersonIdentity, type ProductVersion, type KnowledgeRepoConfig } from "./api";
import { UserPicker } from "./UserPicker";
import { MR_PARTICIPANT_ACCOUNT_PATTERN } from "../../src/mrParticipants";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { confirmDialog } from "./ConfirmDialog";

const PAGE_SIZE = 10;
const defaultKnowledgePath = (name: string) => {
  const readable = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^[. ]+|[. ]+$/g, "") || "领域知识";
  return `Function_Knowledge/Access Function/${readable}`;
};
const MR_ROLES: Array<[keyof MrParticipants, string]> = [
  ["reviewers", "默认检视人"], ["approval_approvers", "审批人"],
];
type MrParticipantInputs = Record<keyof MrParticipants, string>;
const participantInputs = (people?: MrParticipants): MrParticipantInputs => ({
  reviewers: people?.reviewers.join(", ") ?? "",
  approval_approvers: people?.approval_approvers.join(", ") ?? "",
});
const participantAccounts = (value = "") => [...new Set(value.split(/[\s,，;；、]+/).filter(Boolean))];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortRepo = (repo: string) => repo.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "") || repo;
export function ConfigurationCenter({ admin = false }: { admin?: boolean }) {
  const [tab, setTab] = useState(() => { const tab = new URLSearchParams(location.search).get("tab"); return tab === "workflows" || tab === "components" || tab === "technologies" || tab === "modules" || tab === "versions" || (admin && tab === "knowledge") ? tab : "environments"; });
  const tabs: Array<[string, string]> = [["environments", "环境管理"], ["versions", "版本与分支"], ["modules", "模块与代码仓"], ["technologies", "技术栈"], ["components", "基础组件仓"], ["workflows", "团队工作流"],
    // 知识仓(#286):全局强制的运营决策,仅管理员可见可维护(ADR-0033)。
    ...(admin ? [["knowledge", "知识仓"] as [string, string]] : [])];
  return <section className="tw-root grid gap-5 text-base">
    <nav aria-label="配置分类" className="page-tabs">
      {tabs.map(([id, label]) =>
        <Button key={id} variant={tab === id ? "default" : "ghost"}
          aria-pressed={tab === id} onClick={() => { setTab(id); history.replaceState(history.state, "", `/configuration?tab=${id}`); }}>{label}</Button>)}
    </nav>
    {tab === "workflows" ? <WorkflowAssetWorkspace initialWorkflowId={new URLSearchParams(location.search).get("workflow") || undefined} /> : tab === "technologies" ? <TechnologyStacks /> : tab === "components" ? <ComponentRepositories /> : tab === "environments" ? <EnvironmentRegistry /> : tab === "knowledge" ? <KnowledgeRepoPane /> : <MappingList key={tab} kind={tab} />}
  </section>;
}

/** 知识仓页签(仅管理员):单仓单值,存/清两态;提示词按会话开工时的
 * 配置快照装载,改配置只影响之后的会话(与环境台账快照同哲学)。 */
function KnowledgeRepoPane() {
  const [config, setConfig] = useState<KnowledgeRepoConfig | undefined>();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("master"), [docsPath, setDocsPath] = useState("domains"), [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setLoading(true); setError("");
    try { setConfig((await knowledgeRepoRequest()).config ?? undefined); }
    catch (e) { setError(message(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try { setConfig((await knowledgeRepoRequest("PUT", { url: url.trim(), branch, docs_path: docsPath })).config); setUrl(""); setEditing(false); setNotice("已保存;之后的会话开工时装载。"); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function clear() {
    if (!await confirmDialog({ title: "清除知识仓配置？", message: "进行中的会话不受影响;之后的会话不再装载知识仓。", confirmLabel: "清除" })) return;
    setBusy(true); setError(""); setNotice("");
    try { await knowledgeRepoRequest("DELETE"); setConfig(undefined); setNotice("已清除。"); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
    <p className="mb-4 text-sm text-muted-foreground">团队领域知识统一治理的代码仓:问题会话开工时由平台克隆为只读参考件,AI 定位与改码时按业务模块名检索这里的知识。仅管理员可维护;克隆失败不影响定位。</p>
    {error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {notice && <p className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    {loading ? <p className="p-10 text-center text-muted-foreground">正在读取配置…</p> : config && !editing
      ? <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">当前知识仓:</p>
        <code className="break-all rounded-md bg-surface-2 px-3 py-2 text-sm">{config.url}</code>
        <p className="text-sm">萃取默认归档：{config.branch || "master"} / {config.docs_path || "domains"}</p><div className="flex gap-3"><Button variant="outline" onClick={() => { setUrl(config.url); setBranch(config.branch || "master"); setDocsPath(config.docs_path || "domains"); setEditing(true); }}>修改配置</Button><Button variant="outline" disabled={busy} onClick={() => void clear()}>清除配置</Button></div>
      </div>
      : <form className="grid max-w-xl gap-3" onSubmit={e => { e.preventDefault(); void save(); }}>
        <p className="text-sm text-muted-foreground">{config ? "修改后用于新萃取任务，已有任务保留原目标。" : "尚未配置知识仓。"}</p>
        <label className="grid gap-2">代码仓地址(HTTPS 或本地路径)<Input required value={url}
          placeholder="https://codehub.example.com/team/domain-knowledge.git" onChange={e => setUrl(e.target.value)} /></label>
        <label className="grid gap-2">萃取默认归档分支<Input value={branch} onChange={e => setBranch(e.target.value)} /></label><label className="grid gap-2">领域文档默认目录<Input value={docsPath} onChange={e => setDocsPath(e.target.value)} /></label>
        <div><Button type="submit" disabled={busy || !url.trim()}>{busy ? "保存中…" : "保存"}</Button></div>
      </form>}
  </div>;
}
function MappingList({ kind }: { kind: string }) {
  const modulesMode = kind === "modules";
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ id?: string; name: string; value: string; description?: string; mrParticipants?: MrParticipantInputs; knowledgePath?: string; knowledgePathEdited?: boolean }>();
  const [migration, setMigration] = useState<{ source: BusinessModule; targetId: string; preview?: BusinessModuleMigrationPreview; error?: string }>();
  const [notice, setNotice] = useState("");
  async function openMigration(id: string) {
    const source = modules.find(module => module.id === id)!;
    setMigration({ source, targetId: "" });
    try {
      const preview = await previewBusinessModuleMigration(id);
      setMigration(current => current?.source.id === id ? { ...current, preview } : current);
    } catch (error) { setMigration(current => current?.source.id === id ? { ...current, error: message(error) } : current); }
  }
  async function migrate() {
    if (!migration?.targetId || !migration.preview) return;
    setBusy(true);
    try {
      const target = await migrateBusinessModule(migration.source.id, migration.targetId);
      setMigration(undefined); setNotice(`已迁移到「${target.name}」`); await refresh();
    } catch (error) { setMigration(current => current && { ...current, error: message(error) }); }
    finally { setBusy(false); }
  }
  const [allRepos, setAllRepos] = useState<BusinessModule>();
  const [repoQuery, setRepoQuery] = useState("");
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState(false);
  const editingModule = modulesMode && !!edit;
  useEffect(() => {
    if (!editingModule) return;
    let active = true;
    setPeopleLoading(true); setPeopleError(false);
    void listPeople().then(rows => {
      if (active) setPeople(rows);
    }).catch(() => {
      if (active) setPeopleError(true);
    }).finally(() => { if (active) setPeopleLoading(false); });
    return () => { active = false; };
  }, [editingModule]);
  async function refresh() {
    setLoading(true); setError("");
    try {
      if (modulesMode) {
        const catalog = await getBusinessModules(); setModules(catalog.modules); setWarnings(catalog.warnings);
      }
      else setVersions((await productVersionRequest()).versions);
    } catch (e) { setError(message(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!modulesMode || !modules.length) return;
    const params = new URLSearchParams(location.search), selected = params.get("module");
    if (params.get("section") === "knowledge" && selected) {
      const module = modules.find(item => item.id === selected);
      if (module) setEdit({ id: module.id, name: module.name, value: module.repositories.join("\n"), description: module.description, mrParticipants: participantInputs(module.mr_participants), knowledgePath: module.knowledge_path ?? module.knowledge_location?.docs_path ?? defaultKnowledgePath(module.name), knowledgePathEdited: true });
    }
  }, [modulesMode, modules]);
  useEffect(() => {
    if (!edit || new URLSearchParams(location.search).get("section") !== "knowledge") return;
    const timer = setTimeout(() => document.getElementById("module-knowledge-location")?.scrollIntoView({ block: "nearest" }), 100);
    return () => clearTimeout(timer);
  }, [edit?.id]);
  function closeEdit() {
    setEdit(undefined);
    const url = new URL(location.href); url.searchParams.delete("module"); url.searchParams.delete("section"); history.replaceState(history.state, "", url);
  }
  const rows = modulesMode
    ? modules.map(m => ({ id: m.id, name: m.name, value: m.repositories.join("\n"), description: m.description, status: m.status, auto: false, mrParticipants: participantInputs(m.mr_participants), knowledgePath: m.knowledge_path ?? m.knowledge_location?.docs_path ?? defaultKnowledgePath(m.name), knowledgePathEdited: true }))
    : versions.map(v => ({ id: v.id, name: v.version, value: v.branch, description: "", status: "active" as const, auto: v.auto_claim === true, mrParticipants: participantInputs(), knowledgePath: undefined, knowledgePathEdited: undefined }));
  const filtered = rows.filter(row => `${row.name} ${row.value}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  async function save() {
    if (!edit) return;
    setBusy(true); setError("");
    try {
      if (modulesMode) {
        const knowledgePath = edit.knowledgePath ?? defaultKnowledgePath(edit.name);
        if (!knowledgePath.trim()) throw new Error("请填写领域知识的仓内相对目录。");
        const input = { name: edit.name, description: edit.description?.trim() || edit.name,
          repositories: edit.value.split("\n").map(v => v.trim()).filter(Boolean),
          knowledge_path: knowledgePath.trim(),
          mr_participants: {
            reviewers: participantAccounts(edit.mrParticipants?.reviewers),
            approval_approvers: participantAccounts(edit.mrParticipants?.approval_approvers),
          } };
        if (edit.id) await updateBusinessModule(edit.id, input);
        else await createBusinessModule(input);
      } else await productVersionRequest(edit.id ? "PUT" : "POST", { id: edit.id, version: edit.name, branch: edit.value });
      closeEdit(); await refresh();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  // 参与自动接单(ADR-0061):勾一组=组内全部 B 版单进入自动接单扫描;
  // PUT 全量送 version/branch,缺席字段的沿用语义在服务端兜底。
  async function toggleAutoClaim(row: typeof rows[number], on: boolean) {
    setError("");
    try {
      await productVersionRequest("PUT", { id: row.id, version: row.name, branch: row.value, auto_claim: on });
      await refresh();
    } catch (e) { setError(message(e)); }
  }
  return <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
    <div className="mb-5 flex items-center gap-3">
      <Input className="max-w-md" aria-label="搜索配置" placeholder={modulesMode ? "搜索模块名称、代码仓" : "搜索版本、分支"}
        value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
      <Button variant="outline" onClick={() => { setQuery(""); setPage(1); }}>重置</Button>
      <Button variant="outline" disabled={loading} onClick={() => void refresh()}>刷新</Button>
      <Button className="ml-auto" onClick={() => { setError(""); setEdit({ name: "", value: "", knowledgePathEdited: false }); }}>
        ＋ 新建{modulesMode ? "模块" : "版本"}</Button>
    </div>
    {error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    {!!warnings.length && <p role="alert" className="mb-3 text-attention">{warnings.join("；")}</p>}
    <p className="mb-4 text-sm text-muted-foreground">{modulesMode
      ? "维护模块与代码仓的映射。领域知识目录可在编辑模块时设置，知识库读取和后续 MR 共用；所有成员均可维护。"
      : "一个版本对应一个固定分支。需求与问题单选择版本后自动带出分支；已有任务不受后续修改影响。勾选「自动接单」的版本组,组内新问题单才会被平台自动发起(老版本不勾即静默忽略)。"}</p>
    <table className="w-full table-fixed text-left text-base">
      <thead className="border-y border-line bg-surface-2"><tr>
        <th className="w-1/4 p-4 font-medium">{modulesMode ? "业务模块" : "产品版本"}</th>
        <th className="p-4 font-medium">{modulesMode ? "关联代码仓" : "对应分支"}</th>
        {!modulesMode && <th className="w-28 p-4 font-medium">自动接单</th>}
        <th className="w-44 p-4 font-medium">操作</th>
      </tr></thead>
      <tbody>{!loading && filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map(row => <tr key={row.id} className="border-b border-line">
        <td className="p-4 break-words font-medium">{row.name}{row.status === "archived" && <span className="ml-2 text-sm text-muted-foreground">已归档</span>}
          {modulesMode && <p className="mt-1 text-sm font-normal text-muted-foreground">{MR_ROLES
            .filter(([key]) => row.mrParticipants[key])
            .map(([key, label]) => `${label} ${participantAccounts(row.mrParticipants[key]).length} 人`).join(" · ") || "未配置 MR 默认人员"}</p>}
        </td>
        <td className="p-4">{modulesMode ? <div className="flex flex-wrap items-center gap-2">
          {row.value.split("\n").filter(Boolean).slice(0, 3).map(repo => <span key={repo} title={repo}
            className="max-w-44 truncate rounded-md bg-surface-2 px-2 py-1 text-sm">{shortRepo(repo)}</span>)}
          <Button variant="outline" size="sm" onClick={() => { setAllRepos(modules.find(m => m.id === row.id)); setRepoQuery(""); }}>
            查看全部 {modules.find(m => m.id === row.id)?.repositories.length ?? 0} 个</Button>
        </div> : <code className="break-all text-sm">{row.value}</code>}</td>
        {!modulesMode && <td className="p-4">
          <label className="flex items-center gap-2 text-sm" title="勾选后,该版本组名下状态合适的新 DTS 单由平台定时自动发起">
            <Checkbox checked={row.auto} onCheckedChange={checked => void toggleAutoClaim(row, checked === true)} />
            {row.auto ? "参与" : "不参与"}
          </label></td>}
        <td className="p-4"><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setError(""); setEdit(row); }}>编辑</Button>
          {modulesMode && <Button variant="ghost" size="sm" aria-label={`迁移 ${row.name}`} onClick={() => void openMigration(row.id)}>迁移</Button>}
          {!modulesMode && <Button variant="ghost" size="sm" onClick={async () => {
            if (!await confirmDialog({ title: `删除版本「${row.name}」？`, message: "已有任务保留原分支。", confirmLabel: "删除" })) return;
            try { await productVersionRequest("DELETE", { id: row.id }); await refresh(); }
            catch (e) { setError(message(e)); }
          }}>删除</Button>}</div></td>
      </tr>)}</tbody>
    </table>
    {(loading || !filtered.length) && <p className="p-10 text-center text-muted-foreground">{loading ? "正在读取配置…" : query ? "没有匹配项" : "暂无配置，点击右上角新建"}</p>}
    <footer className="mt-5 flex items-center justify-between text-sm text-muted-foreground"><span>共 {filtered.length} 项 · 每页 {PAGE_SIZE} 项</span>
      <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</Button>
        <span>{current} / {pages}</span><Button variant="outline" size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页</Button></div>
    </footer>
    <Dialog open={!!migration} onOpenChange={open => { if (!open && !busy) setMigration(undefined); }}>
      <DialogContent className="tw-root w-[560px] sm:max-w-[560px]">
        <DialogHeader><DialogTitle>迁移到其他模块</DialogTitle></DialogHeader>
        {migration && <div className="grid gap-5 text-base">
          <p>将「{migration.source.name}」的全部关联迁入目标模块。</p>
          <label className="grid gap-2">目标模块
            <select aria-label="目标模块" className="h-10 w-full rounded-md border border-line bg-surface px-3" disabled={busy}
              value={migration.targetId} onChange={event => setMigration({ ...migration, targetId: event.target.value })}>
              <option value="">请选择已新建的模块</option>
              {modules.filter(module => module.id !== migration.source.id && module.status === "active").map(module => <option key={module.id} value={module.id}>{module.name}</option>)}
            </select>
          </label>
          {migration.preview ? <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-muted-foreground"><span>文档：{migration.preview.documents}</span><span>萃取任务：{migration.preview.extraction_tasks}</span><span>交付任务：{migration.preview.delivery_tasks}</span><span>问题会话：{migration.preview.issue_sessions}</span></div>
            : !migration.error && <p role="status" className="text-sm text-muted-foreground">正在读取关联信息…</p>}
          <p className="text-sm text-muted-foreground">迁移后旧模块不再显示。已有成果和任务进度保留，目标模块的配置保持不变。</p>
          {migration.error && <p role="alert" className="text-sm text-danger">{migration.error}</p>}
          <div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setMigration(undefined)}>取消</Button>
            <Button disabled={busy || !migration.targetId || !migration.preview} onClick={() => void migrate()}>{busy ? "正在迁移…" : "确认迁移"}</Button></div>
        </div>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!edit} onOpenChange={open => { if (!open && !busy) closeEdit(); }}>
      <DialogContent className={`tw-root max-w-[90vw] max-h-[85vh] overflow-y-auto ${modulesMode ? "w-[960px] sm:max-w-[960px]" : "w-[620px] sm:max-w-[620px]"}`}>
        <DialogHeader><DialogTitle>{edit?.id ? "编辑" : "新建"}{modulesMode ? "模块" : "版本"}</DialogTitle></DialogHeader>
        {edit && <form className="grid gap-4 text-base" onSubmit={e => { e.preventDefault(); void save(); }}>
          <div className={modulesMode ? "grid grid-cols-2 gap-4" : "grid"}>
            <label className="grid gap-2">{modulesMode ? "模块名称" : "版本名称"}<Input required value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value, ...(!edit.id && !edit.knowledgePathEdited ? { knowledgePath: defaultKnowledgePath(e.target.value) } : {}) })} /></label>
            {modulesMode && <label className="grid gap-2">模块说明（可选）<Input value={edit.description ?? ""} onChange={e => setEdit({ ...edit, description: e.target.value })} /></label>}
          </div>
          {modulesMode ? <label className="grid gap-2">关联代码仓<Textarea className="min-h-32" required value={edit.value}
            placeholder="每行一个代码仓地址" onChange={e => setEdit({ ...edit, value: e.target.value })} /></label>
            : <label className="grid gap-2">分支名称<Input required value={edit.value} onChange={e => setEdit({ ...edit, value: e.target.value })} /></label>}
          {modulesMode && <fieldset id="module-knowledge-location" className="grid gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium">领域知识目录</legend>
            <Input aria-label="领域知识相对目录" required value={edit.knowledgePath ?? defaultKnowledgePath(edit.name)} placeholder="Function_Knowledge/Access Function/模块名" onChange={event => setEdit({ ...edit, knowledgePath: event.target.value, knowledgePathEdited: true })} />
            <p className="text-xs text-muted-foreground">仓库和正式分支使用平台配置；知识读取与后续 MR 共用此目录。</p>
          </fieldset>}
          {modulesMode && <fieldset className="grid gap-3 rounded-md border border-line p-3">
            <legend className="px-1 font-medium">MR 默认人员（可选）</legend>
            <p className="text-sm text-muted-foreground">本模块全部代码仓共用。本模块的知识归档和清理 MR 同样使用这份名单。创建新 MR 时自动添加，已有 MR 不随配置修改。可多选平台账号，也可手动填写未注册平台的 CodeHub 账号。</p>
            {peopleLoading && <p role="status" className="text-sm text-muted-foreground">正在读取平台账号…</p>}
            {peopleError && <p role="status" className="text-sm text-attention">平台账号暂时无法加载，已配置人员仍保留，也可手动填写账号。</p>}
            <div className="grid grid-cols-2 items-start gap-4">{MR_ROLES.map(([key, label]) => {
              const selected = participantAccounts(edit.mrParticipants?.[key]);
              // 外部账号或已删除的平台账号仍可查看和取消，不能因候选缺席丢失配置。
              const options = [...people.map(person => ({ ...person,
                disabled: !MR_PARTICIPANT_ACCOUNT_PATTERN.test(person.username) && !selected.includes(person.username),
                detail: MR_PARTICIPANT_ACCOUNT_PATTERN.test(person.username) ? undefined : "账号格式不支持",
              })), ...selected.filter(username => !people.some(person => person.username === username))
                .map(username => ({ username, detail: "其他账号" }))];
              const change = (value: string) => setEdit({ ...edit,
                mrParticipants: { ...participantInputs(), ...edit.mrParticipants, [key]: value } });
              return <div key={key} className="grid min-w-0 gap-2 text-sm">
                <span>{label}</span>
                <UserPicker multiple wrapSelection ariaLabel={`选择${label}`} options={options} value={selected}
                  disabled={peopleLoading || busy} emptyLabel={`选择${label}（可多选）`}
                  placeholder="搜索姓名或账号" onChange={accounts => change(accounts.join(", "))} />
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">手动填写 CodeHub 账号</summary>
                  <Input className="mt-2" aria-label={`${label} CodeHub 账号`} value={edit.mrParticipants?.[key] ?? ""}
                    placeholder="如 l00000000，多个账号用逗号或空格分隔" disabled={busy} onChange={e => change(e.target.value)} />
                </details>
              </div>;
            })}</div>
          </fieldset>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={busy} onClick={closeEdit}>取消</Button><Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={!!allRepos} onOpenChange={open => { if (!open) setAllRepos(undefined); }}>
      <DialogContent className="tw-root w-[720px] max-w-[90vw] sm:max-w-[720px]">
        <DialogHeader><DialogTitle>{allRepos?.name} · 关联代码仓</DialogTitle></DialogHeader>
        <Input aria-label="搜索关联代码仓" placeholder="搜索代码仓" value={repoQuery} onChange={e => setRepoQuery(e.target.value)} />
        <ul className="max-h-[50vh] overflow-y-auto text-sm">{allRepos?.repositories.filter(repo => repo.toLowerCase().includes(repoQuery.toLowerCase())).map(repo =>
          <li className="border-b border-line py-3 break-all" key={repo}>{repo}</li>)}</ul>
      </DialogContent>
    </Dialog>
  </div>;
}
