import { useTechnologyStacks } from "./useTechnologyStacks";
import { technologyStackLabel } from "./technologyStacks";
/** Skill 管理：已上架内容与待审提交在同一页维护，所有新包和更新都先提交审查。 */

import { Markdown } from "./markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import {
  approveSkillSubmission,
  getBusinessModules,
  getSkillDocument,
  getSkillExtraction,
  getSkillLibrary,
  listSkillSubmissions,
  listSkillVersions,
  offlineSkill,
  rejectSkillSubmission,
  rollbackSkill,
  startSkillExtraction,
  submitSkill,
  updateSkillKnowledgeMetadata,
  type BusinessModule,
  type HostSkillDocument,
  type HostSkillShelf,
  type SkillExtractionJob,
  type SkillOperationRecord,
  type SkillSubmissionRecord,
  type SkillKnowledgeMetadataInput,
  type KnowledgeNature,
  type SkillUploadFile,
  type SkillVersionRecord,
} from "./api";
import {
  KnowledgeLanguageFilter,
  matchesKnowledgeLanguage,
} from "./KnowledgeLanguages";
import {
  skillMetadataInput,
  EMPTY_SKILL_METADATA,
  SkillMetadataEditor,
  SkillMetadataTags,
  NATURE_BADGE_VARIANT as NATURE_VARIANT,
  type SkillMetadataDraft,
} from "./KnowledgeAssetMetadata";
import {
  knowledgeAssetElementId,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertAction } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty, EmptyDescription, EmptyMedia, EmptyTitle,
} from "@/components/Empty";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/Spinner";
import { CircleOffIcon, PanelLeftIcon, SearchIcon } from "lucide-react";
import { cn } from "cn";

type SkillAssetFocus = Extract<KnowledgeAssetFocus, { kind: "skill" }>;
type SkillEntry = HostSkillShelf["skills"][number];

const OPERATION_LABEL: Record<SkillOperationRecord["action"], string> = {
  upload: "上架",
  update: "更新",
  offline: "下线",
  rollback: "回退",
  submit: "提交待审",
  approve: "审核通过",
  reject: "驳回",
};

/** 左栏区分正式 Skill 与待审提交。 */
type Segment = "shelf" | "submissions";

const SEGMENT_LABEL: Record<Segment, string> = {
  shelf: "已上架",
  submissions: "待审提交",
};

/** 右栏在展示什么。上架表单和操作留痕也是"详情",不再挤进列表上方。 */
type Selection =
  | { kind: "none" }
  | { kind: "skill"; directory: string }
  | { kind: "submission"; directory: string; id: string }
  | { kind: "upload" }
  | { kind: "operations" };

/** Skill 详情里的子页。旧版这些都是就地往下顶的折叠块。 */
type DetailTab = "document" | "versions" | "metadata";

/** 行状态徽标词表(原 .ka-flag 色板 1:1 收编):危险=destructive、
 * 警示=warning、成功=success、弱化=neutral;性质词表对齐
 * KnowledgeAssetMetadata 的 kind-* 色(业务=success、工程=brand)。 */
type FlagTone = "danger" | "attention" | "success" | "muted";
const FLAG_VARIANT = {
  danger: "destructive",
  attention: "warning",
  success: "success",
  muted: "neutral",
} as const satisfies Record<FlagTone, ComponentProps<typeof Badge>["variant"]>;
const NATURE_TAG: Record<KnowledgeNature, string> = {
  business: "业务",
  engineering: "工程",
  unclassified: "待补",
};

function latest(value?: string): string {
  if (!value) return "尚未主动访问";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `最近 ${date.toLocaleString([], {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  })}`;
}

function stamp(value?: string): string {
  return latest(value).replace("最近 ", "");
}

/** 浏览器文件 → 上传载荷。目录选择时剥掉首段(那是所选文件夹名,
 * 目录名由输入框决定);.DS_Store 之类点开头的杂物在这里就滤掉,
 * 免得整包被服务端(不收点开头路径)拒了。 */
async function encodeUpload(list: FileList): Promise<{
  files: SkillUploadFile[];
  folder?: string;
  skipped: string[];
}> {
  const files: SkillUploadFile[] = [];
  const skipped: string[] = [];
  let folder: string | undefined;
  for (const file of Array.from(list)) {
    const relative = (file as unknown as { webkitRelativePath?: string })
      .webkitRelativePath;
    let path = file.name;
    if (relative && relative.includes("/")) {
      const segments = relative.split("/");
      folder = segments[0];
      path = segments.slice(1).join("/");
    }
    if (path.split("/").some((segment) => segment.startsWith("."))) {
      skipped.push(path);
      continue;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 0x8000) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    }
    files.push({ path, content_base64: btoa(binary) });
  }
  return { files, folder, skipped };
}

/** 草稿是编辑框里的 UTF-8 文本,走与目录上传同一条 base64 通道。 */
function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function directoryOf(skill: { path: string }): string | undefined {
  const segments = skill.path.split("/");
  return segments.length > 1 ? segments[0] : undefined;
}

function packageDigestOf(skill: SkillEntry): string {
  return (skill as SkillEntry & { package_digest?: string })
    .package_digest ?? "";
}

function editableMetadata(skill: {
  nature: KnowledgeNature;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}): SkillMetadataDraft {
  if (skill.nature === "unclassified") return { ...EMPTY_SKILL_METADATA };
  return {
    nature: skill.nature,
    business_module_ids: [...skill.business_module_ids],
    repositories: [...skill.repositories],
    technologies: [...skill.technologies],
  };
}

/** 列表行的状态标记。名字旁边只留最要紧的一枚,细节留给右栏。 */
function skillFlag(skill: SkillEntry): { tone: FlagTone; text: string;
  title: string } | undefined {
  if (!skill.loadable) {
    return { tone: "danger", text: "不可装载",
      title: "pi 装载器未接受,任何会话都不会带上它;检查 SKILL.md frontmatter 的 name/description" };
  }
  if (skill.nature === "engineering" && !skill.technologies.length) {
    return { tone: "attention", text: "待补关联",
      title: "请补充适用技术栈；补齐前不会自动匹配给任务" };
  }
  if (skill.nature === "unclassified") {
    return { tone: "attention", text: "未治理",
      title: "缺少强制知识标签；补齐前不会自动匹配给任何任务" };
  }
  const signal = skill.effect?.signal;
  if (signal) {
    return { tone: signal === "low-consumption" ? "attention" : "danger",
      text: signal === "low-consumption" ? "没人读" : "读了仍返修",
      title: skill.effect?.signal_evidence ?? "" };
  }
  return undefined;
}

/** 共享版式:字段小标签 / 正文块 / 详情栏内边距。 */
const FIELD_LABEL = "text-sm font-bold whitespace-nowrap text-muted-foreground";

function DetailPane({ id, children }: {
  id?: string;
  children: ReactNode;
}) {
  return <div id={id} className="grid content-start gap-3 p-4">{children}</div>;
}
function PaneHead({ title, note, actions, extra }: {
  title: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  extra?: ReactNode;
}) {
  return <header className="flex items-start justify-between gap-3.5">
    <div className="grid min-w-0 gap-1">
      <h3 className="text-lg font-semibold tracking-tight break-words text-foreground">
        {title}</h3>
      {note && <small className="max-w-[68ch] text-sm/relaxed
        break-words text-muted-foreground">{note}</small>}
    </div>
    {extra}
    {actions}
  </header>;
}
/** 操作留痕/版本痕的一行(原 .ka-trail li)。 */
function TrailRow({ children }: { children: ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-3 gap-y-1
    rounded-md bg-muted px-2.5 py-1.5 text-sm text-muted-foreground">
    {children}
  </li>;
}

export function KnowledgeAssetsWorkspace({ initialAsset, embedded = false, initialUpload = false }: {
  embedded?: boolean;
  initialUpload?: boolean;
  admin?: boolean;
  initialAsset?: KnowledgeAssetFocus;
  onOpenTask: (taskId: string) => void;
}) {
  const { deletedIds } = useTechnologyStacks();
  // 团队知识基于信任共同维护；登录边界由服务端保留。
  const canManageKnowledge = true;
  const skillFocus: SkillAssetFocus | undefined =
    initialAsset?.kind === "skill" ? initialAsset : undefined;

  // ---- 数据 ----
  const [library, setLibrary] = useState<
    HostSkillShelf & { operations: SkillOperationRecord[] }>();
  const [submissions, setSubmissions] = useState<SkillSubmissionRecord[]>([]);
  const [businessModules, setBusinessModules] = useState<BusinessModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  // ---- 导航 ----
  const [segment, setSegment] = useState<Segment>("shelf");
  const [selection, setSelection] = useState<Selection>(initialUpload ? { kind: "upload" } : { kind: "none" });
  const [detailTab, setDetailTab] = useState<DetailTab>("document");
  const [search, setSearch] = useState("");
  const [natureFilter, setNatureFilter] =
    useState<"all" | KnowledgeNature>("all");
  const [detailFilter, setDetailFilter] = useState("all");

  // ---- Skill 详情 ----
  const [document, setDocument] = useState<HostSkillDocument>();
  const [documentFor, setDocumentFor] = useState("");
  const documentRequest = useRef(0);
  const [versions, setVersions] = useState<SkillVersionRecord[]>();
  const [versionsFor, setVersionsFor] = useState("");
  const [metadataDraft, setMetadataDraft] =
    useState<SkillMetadataDraft>({ ...EMPTY_SKILL_METADATA });
  const [confirmOffline, setConfirmOffline] = useState("");

  // ---- 裁决 ----
  const [rejectFor, setRejectFor] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  // ---- 上架 / 提交 ----
  const [uploadName, setUploadName] = useState("");
  const [uploadClassification, setUploadClassification] =
    useState<SkillMetadataDraft>({ ...EMPTY_SKILL_METADATA });
  const [pending, setPending] = useState<{
    files: SkillUploadFile[]; skipped: string[] }>();
  const newInputRef = useRef<HTMLInputElement>(null);
  const updateInputRef = useRef<HTMLInputElement>(null);
  const updateTargetRef = useRef("");
  const updateMetadataRef =
    useRef<SkillKnowledgeMetadataInput | undefined>(undefined);

  // ---- 定向提取(2026-09-01 拍板):没有现成技能包时,从参考仓起草。 ----
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractRepo, setExtractRepo] = useState("");
  const [extractIntent, setExtractIntent] = useState("");
  const [extractHint, setExtractHint] = useState("");
  const [extractJob, setExtractJob] = useState<SkillExtractionJob>();
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [draftText, setDraftText] = useState("");

  const refresh = () => Promise.all([
    getSkillLibrary()
      .then((data) => { setLibrary(data); setError(""); })
      .catch((cause) => setError(
        String(cause instanceof Error ? cause.message : cause))),
    // 提交台账是团队可见的;拉不到不挡货架(fail-open)。
    listSkillSubmissions().then(setSubmissions).catch(() => undefined),
    getBusinessModules().then((data) => setBusinessModules(data.modules))
      .catch(() => undefined),
  ]).finally(() => setLoading(false));
  useEffect(() => { void refresh(); }, [deletedIds.join(",")]);

  const extractJobId = extractJob && ["queued", "running"].includes(extractJob.status)
    ? extractJob.id : undefined;
  useEffect(() => {
    if (!extractJobId) return;
    let alive = true;
    const timer = setInterval(() => {
      void getSkillExtraction(extractJobId).then((job) => {
        if (!alive) return;
        setExtractJob(job);
        if (job.status === "done" && job.draft) {
          setDraftText(job.draft);
          // 目录名从草稿 frontmatter 带出,空着才填——不覆盖人手输。
          const name = /name:\s*([a-z0-9][a-z0-9-]*)/.exec(job.draft)?.[1];
          if (name) setUploadName((prev) => prev || name);
        }
      }).catch((cause) => {
        // 轮询失败不终结 job(可能只是网络抖),下一轮接着问。
        if (alive) setExtractError(String(
          cause instanceof Error ? cause.message : cause));
      });
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [extractJobId]);

  const shelf: HostSkillShelf | undefined = library;
  const operations = library?.operations ?? [];
  const skills = shelf?.skills ?? [];
  const pendingSubmissions = submissions
    .filter((item) => item.status === "pending");

  const skillOf = (directory: string) => skills.find((item) =>
    directoryOf(item) === directory);

  /** 读一份 Skill 全文,并把清单版本对拍做在同一处——展开动作只有这
   * 一个入口,深链和手点都从这里进,免得两条路各写一份判定。 */
  const loadDocument = async (directory: string,
    expected?: SkillAssetFocus) => {
    const request = ++documentRequest.current;
    setDocumentFor(directory);
    setDocument(undefined);
    setError("");
    try {
      const current = skillOf(directory);
      if (expected && (!current || current.digest !== expected.digest
          || packageDigestOf(current) !== expected.packageDigest)) {
        throw new Error("这项团队 Skill 已不是清单中的版本；已停止展开当前全文，请返回发起页重新核对");
      }
      const value = await getSkillDocument(directory);
      if (documentRequest.current !== request) return;
      if (current && (value.digest !== current.digest
          || value.package_digest !== packageDigestOf(current))) {
        throw new Error("这项团队 Skill 的正文或整包与货架摘要不一致；已停止展示，请刷新后重试");
      }
      if (expected && (value.digest !== expected.digest
          || value.package_digest !== expected.packageDigest)) {
        throw new Error("这项团队 Skill 的正文或整包在读取期间已变化；已停止展示当前全文");
      }
      setDocument(value);
    } catch (cause) {
      if (documentRequest.current !== request) return;
      setError(String(cause instanceof Error ? cause.message : cause));
      setDocumentFor("");
    }
  };

  const selectSkill = (directory: string) => {
    setSelection({ kind: "skill", directory });
    setDetailTab("document");
    setConfirmOffline("");
    if (documentFor !== directory) void loadDocument(directory);
  };

  // 深链:资产清单点进来要落在同一份、同一版的正文上。
  useEffect(() => {
    if (!skillFocus || !library) return;
    setSegment("shelf");
    // 深链目标优先于用户先前留在管理页的筛选；否则正文虽然读到了，
    // 目标行仍会被旧筛选藏在 DOM 之外。
    setNatureFilter("all");
    setDetailFilter("all");
    setSearch("");
    const skill = skillOf(skillFocus.directory);
    if (!skill) {
      setError("要核对的团队 Skill 已下线或不存在，无法把管理页当前内容当作清单版本；请返回发起页重新核对。");
      setSelection({ kind: "none" });
      return;
    }
    if (embedded) {
      setSelection({kind:"skill",directory:skillFocus.directory});
      void loadDocument(skillFocus.directory);
      return;
    }
    const packageDigest = packageDigestOf(skill);
    if (skill.digest !== skillFocus.digest
        || packageDigest !== skillFocus.packageDigest) {
      setError(`团队 Skill ${skill.name} 已发生变化（清单正文 ${
        skillFocus.digest.slice(0, 8)} / 包 ${
        skillFocus.packageDigest.slice(0, 8)}，当前正文 ${
        skill.digest.slice(0, 8)} / 包 ${packageDigest.slice(0, 8) || "缺失"}）；`
        + "已停止展开，不能把当前全文当作同一版本");
      setSelection({ kind: "skill", directory: skillFocus.directory });
      setDocumentFor("");
      setDocument(undefined);
      return;
    }
    setSelection({ kind: "skill", directory: skillFocus.directory });
    setDetailTab("document");
    void loadDocument(skillFocus.directory, skillFocus);
  }, [skillFocus, library]);

  // 深链落在列表深处时,左栏要把高亮行滚进视野;右栏在讲哪一项,左栏
  // 就得看得见哪一项,否则人会以为自己点错了。
  useEffect(() => {
    const id = selection.kind === "skill"
      ? knowledgeAssetElementId("skill", selection.directory)
      : "";
    if (!id) return;
    requestAnimationFrame(() => globalThis.document.getElementById(id)
      ?.scrollIntoView({ block: "nearest" }));
  }, [selection]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try {
      await work();
      await refresh();
      if (versionsFor) setVersions(await listSkillVersions(versionsFor));
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  };

  const pickFiles = async (list: FileList | null, target?: string) => {
    if (!list || list.length === 0) return;
    const encoded = await encodeUpload(list);
    if (target) {
      // 行内更新:目录已定,选完即提交。
      await run(async () => {
        const record = await submitSkill(target, encoded.files, updateMetadataRef.current);
        setNote(`已提交 ${record.directory} 的更新，审查通过后生效。`);
      });
      return;
    }
    setPending({ files: encoded.files, skipped: encoded.skipped });
    if (!uploadName && encoded.folder) setUploadName(encoded.folder);
  };

  const startExtraction = async () => {
    setExtractBusy(true); setExtractError(""); setDraftText("");
    try {
      setExtractJob(await startSkillExtraction({
        repo: extractRepo.trim(),
        intent: extractIntent.trim(),
        pathHint: extractHint.trim() || undefined,
      }));
    } catch (cause) {
      setExtractError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setExtractBusy(false);
    }
  };

  const openUpload = () => {
    setSelection({ kind: "upload" });
    setPending(undefined);
    setNote("");
    setUploadName("");
    setUploadClassification({ ...EMPTY_SKILL_METADATA });
  };

  const finishUpload = (message?: string) => {
    setPending(undefined);
    setDraftText("");
    setExtractJob(undefined);
    setExtractOpen(false);
    setNote(message ?? "");
    setSelection({ kind: "none" });
  };

  const submitPackage = () => pending && void run(async () => {
    const metadata = skillMetadataInput(uploadClassification);
    if (!metadata) return;
    const record = await submitSkill(uploadName, pending.files, metadata);
    finishUpload(`已提交待审(${record.directory}/${record.id}，`
      + `${record.files} 个文件)。管理员审核通过后即上架生效。`);
  });

  const submitDraft = () => void run(async () => {
    const metadata = skillMetadataInput(uploadClassification);
    if (!metadata) return;
    const files: SkillUploadFile[] = [
      { path: "SKILL.md", content_base64: encodeText(draftText) }];
    const record = await submitSkill(uploadName, files, metadata);
    finishUpload(`已提交待审(${record.directory}/${record.id})。`
      + "管理员审核通过后即上架生效。");
  });

  const languageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const skill of skills) {
      for (const language of skill.technologies) {
        counts.set(language, (counts.get(language) ?? 0) + 1);
      }
    }
    return counts;
  }, [shelf]);

  const term = search.trim().toLowerCase();
  const matchesFilters = (item: {
    nature: KnowledgeNature; business_module_ids: string[];
    technologies: string[];
  }) => {
    if (natureFilter !== "all" && item.nature !== natureFilter) return false;
    if (natureFilter === "business" && detailFilter !== "all") {
      return item.business_module_ids.includes(detailFilter);
    }
    if (natureFilter === "engineering") {
      return matchesKnowledgeLanguage(item.technologies, detailFilter);
    }
    return true;
  };

  const visibleSkills = skills.filter((skill) => matchesFilters(skill)
    && (!term || `${skill.name} ${skill.description} ${skill.path}`
      .toLowerCase().includes(term)));
  const visibleSubmissions = submissions.filter((item) => !term
    || `${item.directory} ${item.operator}`.toLowerCase().includes(term));
  const counts: Record<Segment, number> = {
    shelf: skills.length,
    submissions: submissions.length,
  };
  const attention: Record<Segment, number> = {
    shelf: skills.filter((skill) => skillFlag(skill)).length,
    submissions: pendingSubmissions.length,
  };

  const selectedSkill = selection.kind === "skill"
    ? skillOf(selection.directory) : undefined;
  const selectedSubmission = selection.kind === "submission"
    ? submissions.find((item) => item.id === selection.id
      && item.directory === selection.directory) : undefined;
  const openVersions = (directory: string) => void (async () => {
    setDetailTab("versions");
    if (versionsFor === directory && versions) return;
    setVersionsFor(directory); setVersions(undefined);
    try { setVersions(await listSkillVersions(directory)); }
    catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  })();

  // 按钮为什么灰着要说人话:逐条列出还缺什么,别让人对着灰按钮猜
  // (承接 origin 160c2ff 的口径,搬进新版式)。
  const submissionMissing = [
    !uploadName ? "目录名" : "",
    !uploadClassification.nature ? "知识性质" : "",
    uploadClassification.nature === "business"
        && !uploadClassification.business_module_ids.length
      ? "归属业务模块" : "",
    uploadClassification.nature === "engineering"
        && !uploadClassification.technologies.length
      ? "适用技术栈" : "",
  ].filter(Boolean);
  // 提取回来的草稿也是一份可提交的正文:没选技能包时主按钮直接走草稿,
  // 不逼人先去下面那块里找另一个按钮。
  const extractedDraftReady = extractJob?.status === "done"
    && Boolean(draftText.trim());

  // 左右栏各自限高滚动(原 --ka-viewport: 100vh - 210px;窄屏退单栏,
  // 原 @media 1080px 块)。两栏 sticky 才是"页面不随点击变长"的根。
  const columnShell = "sticky top-3.5 max-h-[calc(100vh-210px)] min-w-0"
    + " max-[1080px]:static max-[1080px]:max-h-none";

  return <section className={cn("flex flex-col gap-2.5", embedded && "kd-native-maintenance")} aria-label="知识资产管理">
    {!embedded && <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-lg
      border border-line bg-surface p-2 shadow-(--shadow-xs)">
      <div className="relative flex min-w-52 flex-[1_1_240px] items-center">
        <SearchIcon aria-hidden className="pointer-events-none absolute
          left-2.5 size-3.5 text-faint" />
        <Input type="search" className="pl-7" value={search}
          placeholder="搜名称、描述、提交人" aria-label="搜索知识资产"
          onChange={(event) => setSearch(event.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5">
          <span className={FIELD_LABEL}>性质</span>
          <Select value={natureFilter}
            items={[{ value: "all", label: "全部性质" }, { value: "business", label: "业务知识" }, { value: "engineering", label: "工程知识" }, { value: "unclassified", label: "待补属性（历史）" }]}
            onValueChange={(value) => {
              setNatureFilter((value ?? "all") as "all" | KnowledgeNature);
              setDetailFilter("all");
            }}>
            <SelectTrigger aria-label="性质" className="max-w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部性质</SelectItem>
                <SelectItem value="business">业务知识</SelectItem>
                <SelectItem value="engineering">工程知识</SelectItem>
                <SelectItem value="unclassified">待补属性（历史）</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select></label>
        {natureFilter === "business" && <label className="flex items-center gap-1.5">
          <span className={FIELD_LABEL}>业务模块</span>
          <Select value={detailFilter}
            items={[{ value: "all", label: "全部业务模块" },
              ...businessModules.filter((module) => module.status === "active")
                .map((module) => ({ value: module.id, label: module.name }))]}
            onValueChange={(value) => setDetailFilter(value ?? "all")}>
            <SelectTrigger aria-label="业务模块" className="max-w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">全部业务模块</SelectItem>
                {businessModules.filter((module) => module.status === "active")
                  .map((module) => <SelectItem value={module.id} key={module.id}>
                    {module.name}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select></label>}
        {natureFilter === "engineering" && <KnowledgeLanguageFilter
          value={detailFilter} onChange={setDetailFilter}
          counts={languageCounts} />}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {!!operations.length && <Button type="button"
          variant={selection.kind === "operations" ? "secondary" : "outline"}
          size="sm" aria-pressed={selection.kind === "operations"}
          onClick={() => setSelection({ kind: "operations" })}>
          操作留痕 {operations.length}</Button>}
        <Button type="button" size="sm"
          variant={selection.kind === "upload" ? "secondary" : "default"}
          aria-pressed={selection.kind === "upload"} onClick={openUpload}>
          提交 Skill</Button>
      </div>
    </div>}

    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    {note && <Alert role="status">{note}
      <AlertAction><Button size="sm" variant="outline"
        onClick={() => setNote("")}>知道了</Button></AlertAction></Alert>}
    {!!shelf?.warnings.length && <Alert variant="warning" role="note">
      {shelf.warnings.map((warning) => <p key={warning} className="m-0.5">⚠ {warning}</p>)}
    </Alert>}

    <div className={embedded ? "min-w-0" : "grid grid-cols-[minmax(260px,340px)_minmax(0,1fr)] items-start gap-3.5 max-[1080px]:grid-cols-1"}>
      {!embedded && <div className={cn(columnShell, "flex flex-col overflow-hidden",
        "rounded-lg border border-line bg-surface shadow-(--shadow-xs)")}>
        <nav className="flex gap-0.5 border-b border-line px-1.5 pt-1.5"
          aria-label="资产阶段">
          {(["shelf", "submissions"] as const).map((value) =>
            <button type="button" key={value}
              className={cn("-mb-px inline-flex min-h-8 items-center gap-1.5",
                "border-b-2 px-2.5 text-sm font-bold transition-colors",
                segment === value
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground")}
              aria-pressed={segment === value}
              onClick={() => setSegment(value)}>
              {SEGMENT_LABEL[value]}
              <span className="rounded-full bg-muted px-1.5 text-xs
                tabular-nums">{counts[value]}</span>
              {attention[value] > 0 && <span aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-attention" />}
            </button>)}
        </nav>

        <div className="grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto
          p-1.5 max-[1080px]:max-h-[46vh]" role="list">
          {loading && !shelf && <p className="flex items-center gap-2 p-4
            text-sm text-muted-foreground"><Spinner className="size-3.5" />
            正在读取知识资产…</p>}

          {segment === "shelf" && visibleSkills.map((skill) => {
            const directory = directoryOf(skill);
            const flag = skillFlag(skill);
            return <button type="button" role="listitem"
              id={directory
                ? knowledgeAssetElementId("skill", directory) : undefined}
              key={skill.path} disabled={!directory}
              className={cn("grid w-full gap-1 rounded-md border border-transparent",
                "p-2 text-left transition-colors hover:bg-muted disabled:opacity-55",
                selection.kind === "skill"
                  && selection.directory === directory
                  && "border-primary/40 bg-primary/5")}
              aria-current={selection.kind === "skill"
                && selection.directory === directory ? "true" : undefined}
              onClick={() => directory && selectSkill(directory)}>
              <span className="flex items-baseline gap-1.5">
                <strong className="min-w-0 truncate text-sm font-semibold
                  text-foreground">{skill.name}</strong>
                {flag && <Badge variant={FLAG_VARIANT[flag.tone]}
                  title={flag.title} className="flex-none">{flag.text}</Badge>}
              </span>
              <span className="line-clamp-2 text-sm/relaxed
                text-muted-foreground">{skill.description
                || "(没有描述——模型靠描述判断何时读取,建议补上)"}</span>
              <span className="flex flex-wrap gap-1">
                <Badge variant={NATURE_VARIANT[skill.nature]}>
                  {NATURE_TAG[skill.nature]}</Badge>
                {skill.business_module_ids.map((id) => <Badge key={id}
                  variant="neutral">{
                  businessModules.find((module) => module.id === id)?.name
                    ?? id}</Badge>)}
                {skill.technologies.slice(0, 3).map((technology) =>
                  <Badge key={technology} variant="neutral">{technologyStackLabel(technology)}</Badge>)}
              </span>
            </button>;
          })}
          {segment === "shelf" && !visibleSkills.length && !loading
            && <Empty className="border p-4"><EmptyDescription>{skills.length
              ? "当前筛选下没有 Skill；换个性质或清空搜索。"
              : shelf && !shelf.root_exists && !canManageKnowledge
                ? "本部署尚未放置 Skill 形态知识。管理员上架后，匹配的新任务即可使用。"
                : `货架是空的——${canManageKnowledge
                  ? "点右上「提交 Skill」导入含 SKILL.md 的技能包，审查通过后上架。"
                  : "管理员上架后,新任务即自动装载。"}`}</EmptyDescription></Empty>}

          {segment === "submissions" && visibleSubmissions.map((item) =>
            <button type="button" role="listitem"
              key={`${item.directory}-${item.id}`}
              className={cn("grid w-full gap-1 rounded-md border border-transparent",
                "p-2 text-left transition-colors hover:bg-muted",
                selection.kind === "submission"
                  && selection.id === item.id
                  && "border-primary/40 bg-primary/5")}
              aria-current={selection.kind === "submission"
                && selection.id === item.id ? "true" : undefined}
              onClick={() => { setSelection({ kind: "submission",
                directory: item.directory, id: item.id });
                setRejectFor(""); setRejectReason(""); }}>
              <span className="flex items-baseline gap-1.5">
                <strong className="min-w-0 truncate text-sm font-semibold
                  text-foreground">{item.directory}</strong>
                <Badge variant={FLAG_VARIANT[item.status === "pending"
                  ? "attention" : item.status === "approved"
                    ? "success" : "muted"]}>{item.status === "pending"
                  ? "待审核" : item.status === "approved" ? "已上架" : "已驳回"}
                </Badge>
              </span>
              <span className="line-clamp-2 text-sm/relaxed
                text-muted-foreground">{item.operator} 提交 · {
                item.files} 个文件</span>
              <span className="flex flex-wrap gap-1">
                <Badge variant="neutral">{stamp(item.created_at)}</Badge>
              </span>
            </button>)}
          {segment === "submissions" && !visibleSubmissions.length && !loading
            && <Empty className="border p-4"><EmptyDescription>还没有待审提交。开发者提交的技能包会先落在这里，管理员通过后才上架。</EmptyDescription></Empty>}


        </div>
      </div>}

      <div className={embedded ? "min-w-0" : cn(columnShell, "overflow-y-auto rounded-lg border",
        "border-line bg-surface shadow-(--shadow-xs)")}>
        {selection.kind === "none" && <Empty className="min-h-60 p-7">
          <EmptyMedia variant="icon"><PanelLeftIcon aria-hidden /></EmptyMedia>
          <EmptyTitle>从左边选一项</EmptyTitle>
          <EmptyDescription>选中后这里显示它的全文、版本和可做的动作；
            页面不会再往下长。</EmptyDescription>
        </Empty>}

        {selection.kind === "upload" && <UploadPane
          busy={busy}
          modules={businessModules}
          classification={uploadClassification}
          onClassification={setUploadClassification}
          name={uploadName} onName={setUploadName}
          pending={pending}
          onPick={() => newInputRef.current?.click()}
          missing={submissionMissing}
          extractedDraftReady={extractedDraftReady}
          onSubmit={() => {
            if (!pending && extractedDraftReady) { submitDraft(); return; }
            if (pending) submitPackage();
          }}
          extractOpen={extractOpen} onExtractOpen={setExtractOpen}
          repo={extractRepo} onRepo={setExtractRepo}
          intent={extractIntent} onIntent={setExtractIntent}
          hint={extractHint} onHint={setExtractHint}
          job={extractJob} extractBusy={extractBusy}
          extractError={extractError} onStart={startExtraction}
          draft={draftText} onDraft={setDraftText}
          onSubmitDraft={submitDraft}
          onClose={() => setSelection({ kind: "none" })} />}

        {selection.kind === "operations" && <DetailPane>
          <PaneHead title="操作留痕"
            note="谁在什么时候动了货架；指纹对得上才算同一版。"
            actions={<Button variant="ghost" size="sm"
              onClick={() => setSelection({ kind: "none" })}>关闭</Button>} />
          <ul className="grid gap-1">
            {operations.map((operation, index) =>
              <TrailRow key={`${operation.at}-${index}`}>
                <Badge variant="outline">{OPERATION_LABEL[operation.action]}</Badge>
                <strong className="font-mono text-xs text-foreground">{
                  operation.directory}</strong>
                <span>{operation.operator}</span>
                {operation.skill_digest && <span title={operation.skill_digest}>
                  指纹 {operation.skill_digest.slice(0, 8)}</span>}
                {operation.detail && <span>{operation.detail}</span>}
                <time dateTime={operation.at} className="ml-auto
                  tabular-nums text-faint">{stamp(operation.at)}</time>
              </TrailRow>)}
          </ul>
        </DetailPane>}

        {selection.kind === "skill" && !selectedSkill && <Empty
          className="min-h-60 p-7">
          <EmptyMedia variant="icon"><CircleOffIcon aria-hidden /></EmptyMedia>
          <EmptyTitle>这项已不在货架上</EmptyTitle>
          <EmptyDescription>可能刚被下线或更新；左边重新选一项。</EmptyDescription>
        </Empty>}

        {selection.kind === "skill" && selectedSkill && <SkillDetail
          skill={selectedSkill} directory={selection.directory} embedded={embedded}
          admin={canManageKnowledge} busy={busy} modules={businessModules}
          tab={detailTab} onTab={setDetailTab}
          document={document}
          documentReady={documentFor === selection.directory}
          blocked={documentFor !== selection.directory && !!error}
          focus={!embedded && skillFocus?.directory === selection.directory
            ? skillFocus : undefined}
          versions={versionsFor === selection.directory ? versions : undefined}
          onVersions={() => openVersions(selection.directory)}
          onRollback={(versionId) => void run(() =>
            rollbackSkill(selection.directory, versionId))}
          metadataDraft={metadataDraft} onMetadataDraft={setMetadataDraft}
          onOpenMetadata={() => {
            setMetadataDraft(editableMetadata(selectedSkill));
            setDetailTab("metadata");
          }}
          onSaveMetadata={() => void run(async () => {
            const metadata = skillMetadataInput(metadataDraft);
            if (!metadata) return;
            await updateSkillKnowledgeMetadata(selection.directory, metadata);
            setDetailTab("document");
          })}
          onUpdate={() => {
            updateTargetRef.current = selection.directory;
            updateMetadataRef.current = skillMetadataInput(
              editableMetadata(selectedSkill));
            updateInputRef.current?.click();
          }}
          confirmOffline={confirmOffline === selection.directory}
          onOffline={() => {
            if (confirmOffline === selection.directory) {
              setConfirmOffline("");
              void run(() => offlineSkill(selection.directory));
              setSelection({ kind: "none" });
              return;
            }
            setConfirmOffline(selection.directory);
          }} />}

        {selection.kind === "submission" && !selectedSubmission
          && <Empty className="min-h-60 p-7">
          <EmptyMedia variant="icon"><CircleOffIcon aria-hidden /></EmptyMedia>
          <EmptyTitle>这条提交记录已不在台账里</EmptyTitle>
          <EmptyDescription>左边重新选一项。</EmptyDescription></Empty>}

        {selection.kind === "submission" && selectedSubmission
          && <DetailPane>
          <PaneHead title={selectedSubmission.directory}
            note={`${selectedSubmission.operator} 提交 · ${
              selectedSubmission.files} 个文件 · ${
              stamp(selectedSubmission.created_at)}`}
            extra={<Badge variant={FLAG_VARIANT[
              selectedSubmission.status === "pending"
                ? "attention" : selectedSubmission.status === "approved"
                  ? "success" : "muted"]}>{
              selectedSubmission.status === "pending" ? "待审核"
                : selectedSubmission.status === "approved"
                  ? "已上架" : "已驳回"}</Badge>} />
          <div><SkillMetadataTags
            nature={selectedSubmission.nature ?? "unclassified"}
            moduleIds={selectedSubmission.business_module_ids ?? []}
            repositories={selectedSubmission.repositories ?? []}
            technologies={selectedSubmission.technologies ?? []}
            modules={businessModules} /></div>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))]
            gap-x-4 gap-y-2 rounded-md bg-muted p-2.5">
            <div className="grid min-w-0 gap-0.5"><dt className="text-xs
              font-bold text-faint">正文指纹</dt><dd className="font-mono
              text-sm break-all text-text">{
              selectedSubmission.skill_digest.slice(0, 12)}</dd></div>
            <div className="grid min-w-0 gap-0.5"><dt className="text-xs
              font-bold text-faint">整包指纹</dt><dd className="font-mono
              text-sm break-all text-text">{
              selectedSubmission.package_digest.slice(0, 12) || "未记录"}</dd></div>
            {selectedSubmission.decided_by && <div className="grid min-w-0
              gap-0.5"><dt className="text-xs font-bold text-faint">裁决人</dt>
              <dd className="font-mono text-sm break-all text-text">{
                selectedSubmission.decided_by}</dd></div>}
            {selectedSubmission.reject_reason && <div className="grid min-w-0
              gap-0.5"><dt className="text-xs font-bold text-faint">驳回原因</dt>
              <dd className="font-mono text-sm break-all text-text">{
                selectedSubmission.reject_reason}</dd></div>}
          </dl>
          {canManageKnowledge && selectedSubmission.status === "pending" && <div
            className="flex flex-wrap items-center gap-2">
            {rejectFor === selectedSubmission.id ? <>
              <Input type="text" className="min-w-55 flex-1" placeholder="驳回原因(可留空)"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)} />
              <Button disabled={busy}
                onClick={() => void run(async () => {
                  await rejectSkillSubmission(selectedSubmission.directory,
                    selectedSubmission.id, rejectReason);
                  setRejectFor(""); setRejectReason("");
                  setSelection({ kind: "none" });
                })}>确认驳回</Button>
              <Button variant="outline" disabled={busy}
                onClick={() => { setRejectFor(""); setRejectReason(""); }}>
                返回</Button>
            </> : <>
              <Button disabled={busy}
                onClick={() => void run(() => approveSkillSubmission(
                  selectedSubmission.directory, selectedSubmission.id))}>
                通过并上架</Button>
              <Button variant="outline" disabled={busy}
                onClick={() => setRejectFor(selectedSubmission.id)}>驳回</Button>
            </>}
          </div>}
        </DetailPane>}


      </div>
    </div>

    <input ref={newInputRef} type="file" multiple hidden
      {...({ webkitdirectory: "" } as object)}
      onChange={(event) => {
        void pickFiles(event.target.files); event.target.value = "";
      }} />
    {canManageKnowledge && <input ref={updateInputRef} type="file" multiple hidden
      {...({ webkitdirectory: "" } as object)}
      onChange={(event) => {
        void pickFiles(event.target.files, updateTargetRef.current);
        event.target.value = "";
      }} />}
  </section>;
}

/** Skill 详情共用一个头，切换全文、版本与范围时保持面板高度。 */
function SkillDetail({ skill, directory, embedded = false, admin, busy, modules, tab, onTab,
  document, documentReady, blocked, focus, versions, onVersions, onRollback,
  metadataDraft, onMetadataDraft,
  onOpenMetadata, onSaveMetadata, onUpdate, confirmOffline, onOffline }: {
  skill: SkillEntry;
  embedded?: boolean;
  directory: string;
  admin: boolean;
  busy: boolean;
  modules: BusinessModule[];
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  document?: HostSkillDocument;
  documentReady: boolean;
  /** 版本对拍没过或读取失败:正文停在"没展开",不是"还在转圈"。 */
  blocked: boolean;
  focus?: SkillAssetFocus;
  versions?: SkillVersionRecord[];
  onVersions: () => void;
  onRollback: (versionId: string) => void;
  metadataDraft: SkillMetadataDraft;
  onMetadataDraft: (draft: SkillMetadataDraft) => void;
  onOpenMetadata: () => void;
  onSaveMetadata: () => void;
  onUpdate: () => void;
  confirmOffline: boolean;
  onOffline: () => void;
}) {
  const effect = skill.effect;
  const verified = focus && document?.digest === focus.digest
    && document.package_digest === focus.packageDigest;
  return <DetailPane>
    <PaneHead title={skill.name} note={skill.path}
      actions={admin && <div className="flex flex-none gap-1.5">
        <Button variant="outline" size="sm" disabled={busy}
          onClick={onUpdate}>更新</Button>
        <Button size="sm" variant={confirmOffline ? "destructive" : "outline"}
          onClick={onOffline}>{confirmOffline ? "确认下线?" : "下线"}</Button>
      </div>} />

    <p className="max-w-[74ch] text-sm/relaxed text-text">{skill.description
      || "(没有描述——模型靠描述判断何时读取,建议补上)"}</p>
    <SkillMetadataTags nature={skill.nature}
      moduleIds={skill.business_module_ids}
      repositories={skill.repositories}
      technologies={skill.technologies} modules={modules} />

    {!embedded && <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))]
      gap-x-4 gap-y-2 rounded-md bg-muted p-2.5">
      <div className="grid min-w-0 gap-0.5"><dt className="text-xs font-bold
        text-faint">正文版本</dt>
        <dd title={`SKILL.md 内容 sha256:${skill.digest}`} className="font-mono
          text-sm break-all text-text">{skill.digest.slice(0, 12)}</dd></div>
      <div className="grid min-w-0 gap-0.5"><dt className="text-xs font-bold
        text-faint">整包版本</dt><dd className="font-mono text-sm break-all
        text-text">{packageDigestOf(skill).slice(0, 12) || "未记录"}</dd></div>
      <div className="grid min-w-0 gap-0.5"><dt className="text-xs font-bold
        text-faint">更新时间</dt><dd className="text-sm text-text">{
        stamp(skill.updated_at)}</dd></div>
      {focus && <div className="grid min-w-0 gap-0.5"><dt className="text-xs
        font-bold text-faint">清单对拍</dt>
        <dd className={cn("text-sm font-bold",
          verified ? "text-success" : blocked ? "text-danger"
            : "text-attention")}>{verified ? "已对拍"
          : blocked ? "版本不符" : "正在对拍"}</dd></div>}
    </dl>}

    {effect && effect.provided_tasks > 0 && <div className="flex flex-wrap
      gap-2">
      <span className="grid min-w-21 gap-0.5 rounded-md border border-line
        bg-muted px-2.5 py-1.5"><strong className="text-lg leading-none
        font-semibold tabular-nums text-foreground">{effect.provided_tasks}
        </strong><small className="text-xs text-faint">装载</small></span>
      <span className="grid min-w-21 gap-0.5 rounded-md border border-line
        bg-muted px-2.5 py-1.5"><strong className="text-lg leading-none
        font-semibold tabular-nums text-foreground">{effect.accessed_tasks}
        </strong><small className="text-xs text-faint">读取（{
        Math.round(effect.accessed_tasks / effect.provided_tasks * 100)}%）
      </small></span>
      {effect.prepush_measured > 0 && <span
        title="读过该 skill 的任务中，Build-Fix 首轮一次通过的比例"
        className="grid min-w-21 gap-0.5 rounded-md border border-line
        bg-muted px-2.5 py-1.5"><strong className="text-lg leading-none
        font-semibold tabular-nums text-foreground">{
        effect.prepush_first_pass}/{effect.prepush_measured}</strong>
        <small className="text-xs text-faint">读后一次过</small></span>}
      {effect.baseline_measured > 0 && <span
        title="未读该 skill 的任务对照(相关性参考,不代表因果)"
        className="grid min-w-21 gap-0.5 rounded-md border border-line
        bg-muted px-2.5 py-1.5"><strong className="text-lg leading-none
        font-semibold tabular-nums text-foreground">{
        effect.baseline_first_pass}/{effect.baseline_measured}</strong>
        <small className="text-xs text-faint">未读对照</small></span>}
      {effect.repair_tasks > 0 && <span className="grid min-w-21 gap-0.5
        rounded-md border border-attention/40 bg-attention-soft/40 px-2.5
        py-1.5"><strong className="text-lg leading-none font-semibold
        tabular-nums text-attention">{effect.repair_tasks}</strong>
        <small className="text-xs text-faint">读后返修</small></span>}
    </div>}

    <nav className="flex gap-0.5 border-b border-line" aria-label="Skill 详情视图">
      {([ ["document", "全文"], ["versions", "历史版本"],
        ...(admin ? [[ "metadata", "适用范围" ] as [DetailTab, string]] : []),
      ] as Array<[DetailTab, string]>).map(([value, label]) =>
        <button type="button" key={value}
          className={cn("-mb-px inline-flex min-h-8 items-center border-b-2",
            "px-2.5 text-sm font-bold transition-colors",
            tab === value
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground")}
          onClick={() => {
            if (value === "versions") onVersions();
            else if (value === "metadata") onOpenMetadata();
            else onTab(value);
          }}>{label}</button>)}
    </nav>

    {tab === "document" && <div className="grid gap-2.5">
      {document && documentReady
        ? <Markdown text={document.content} />
        : blocked
          ? <p className="text-sm/relaxed text-muted-foreground">已停止展开——原因见上方提示。这项不会以"同一版本"呈现。</p>
          : <p className="flex items-center gap-2 text-sm
            text-muted-foreground"><Spinner className="size-3.5" />
            正在读取全文…</p>}
    </div>}

    {tab === "versions" && <div className="grid gap-2.5">
      {!versions && <p className="flex items-center gap-2 text-sm
        text-muted-foreground"><Spinner className="size-3.5" />
        读取版本痕…</p>}
      {versions && versions.length === 0
        && <Empty className="border p-4"><EmptyDescription>还没有归档版本(第一次覆盖/下线时自动归档)。</EmptyDescription></Empty>}
      <ul className="grid gap-1">
        {versions?.map((version) => <TrailRow key={version.version_id}>
          <Badge variant="outline" title={version.version_id}>{
            OPERATION_LABEL[version.action as SkillOperationRecord["action"]]
              ?? version.action}归档</Badge>
          <strong className="font-mono text-xs text-foreground">
            指纹 {version.skill_digest.slice(0, 8)}</strong>
          <span>{version.operator}</span>
          <time dateTime={version.archived_at} className="ml-auto
            tabular-nums text-faint">{stamp(version.archived_at)}</time>
          <Button variant="outline" size="xs" disabled={busy}
            onClick={() => onRollback(version.version_id)}>回退到此版</Button>
        </TrailRow>)}
      </ul>
    </div>}

    {tab === "metadata" && admin && <div className="grid gap-2.5">
      <p className="text-sm/relaxed text-muted-foreground">Skill 形态不变；修改会形成新版本，历史任务不受影响。</p>
      <SkillMetadataEditor value={metadataDraft} modules={modules}
        onChange={onMetadataDraft} />
      <Button className="justify-self-start" size="sm"
        disabled={busy || !skillMetadataInput(metadataDraft)}
        onClick={onSaveMetadata}>保存属性</Button>
    </div>}
  </DetailPane>;
}

/** 上架/提交表单。整份表单住在右栏,展开不再顶动列表。 */
function UploadPane({ busy, modules, classification, onClassification,
  name, onName, pending, onPick, missing, extractedDraftReady, onSubmit,
  extractOpen, onExtractOpen, repo, onRepo, intent, onIntent, hint, onHint,
  job, extractBusy, extractError, onStart, draft, onDraft, onSubmitDraft,
  onClose }: {
  busy: boolean;
  modules: BusinessModule[];
  classification: SkillMetadataDraft;
  onClassification: (draft: SkillMetadataDraft) => void;
  name: string;
  onName: (name: string) => void;
  pending?: { files: SkillUploadFile[]; skipped: string[] };
  onPick: () => void;
  /** 还缺哪几项才能提交;空数组=可以提交。 */
  missing: string[];
  extractedDraftReady: boolean;
  onSubmit: () => void;
  extractOpen: boolean;
  onExtractOpen: (open: boolean) => void;
  repo: string;
  onRepo: (value: string) => void;
  intent: string;
  onIntent: (value: string) => void;
  hint: string;
  onHint: (value: string) => void;
  job?: SkillExtractionJob;
  extractBusy: boolean;
  extractError: string;
  onStart: () => void;
  draft: string;
  onDraft: (value: string) => void;
  onSubmitDraft: () => void;
  onClose: () => void;
}) {
  const verb = "提交";
  const blocked = missing.length > 0;
  const missingText = `提交前还需：${missing.join("、")}`;
  return <DetailPane>
    <PaneHead title={`${verb} Skill`}
      note={`选含 SKILL.md 的技能包目录(frontmatter 需有 name/description)。
          上传前服务端会做密钥掩码扫描——skill 权限全开,令牌/密码一律拒收。
          提交后由管理员审查，通过即上架。`}
      actions={<Button variant="ghost" size="sm"
        onClick={onClose}>关闭</Button>} />

    <SkillMetadataEditor value={classification} modules={modules}
      onChange={onClassification} />

    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-[0_1_260px] flex-col gap-1">
        <span className={FIELD_LABEL}>目录名</span>
        <Input type="text" placeholder="如 order-rules" value={name}
          onChange={(event) => onName(event.target.value.trim())} /></label>
      <Button variant="outline" onClick={onPick}>选技能包目录</Button>
      <Button disabled={busy || (!pending && !extractedDraftReady) || blocked}
        title={blocked ? missingText : undefined}
        onClick={onSubmit}>
        {busy ? `${verb}中`
          : extractedDraftReady && !pending
            ? "用草稿提交审查"
            : `确认提交审查${
              pending ? `（${pending.files.length} 个文件）` : ""}`}</Button>
    </div>
    {(pending || extractedDraftReady) && blocked
      && <p role="status" className="text-sm/relaxed text-muted-foreground">
        {missingText}。请在上方补齐，按钮会立即启用。</p>}
    {pending && <p className="text-sm/relaxed text-muted-foreground">
      已选 {pending.files.length} 个文件
      {pending.files.some((file) => file.path === "SKILL.md")
        ? "" : ";⚠ 缺少根级 SKILL.md,会被拒收"}
      {pending.skipped.length > 0
        && `;已滤掉 ${pending.skipped.length} 个点开头杂物`}
    </p>}

    {/* 定向提取:同事说"参考那个仓的做法"时,把这句话变成草稿。
        目录名/知识属性沿用上方输入;草稿人工修订后走同一道闸。 */}
    <div className="grid gap-2.5 border-t border-dashed border-line pt-3">
      <Button type="button" variant="outline" size="sm" className="justify-self-start"
        aria-expanded={extractOpen}
        onClick={() => onExtractOpen(!extractOpen)}>
        {extractOpen ? "收起提取" : "没有现成技能包?从参考代码仓提取草稿"}
      </Button>
      {extractOpen && <>
        <p className="max-w-[74ch] text-sm/relaxed text-muted-foreground">
          填参考仓与一句话意图,平台起一个<strong className="text-foreground">只读</strong>
          分析会话读仓起草 SKILL.md(预算 10 分钟);草稿回填到下方编辑框,
          人工修订后与普通{verb}走同一道验收闸。克隆用你自己的 git 凭据——
          你没权限的仓,平台也不替你看。</p>
        <div className="grid max-w-[900px] gap-2.5
          grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))]">
          <label className="grid min-w-0 gap-1">
            <span className={FIELD_LABEL}>参考仓地址(必填)</span>
            <Input type="text" value={repo} placeholder="git@… 或 https://…"
              onChange={(event) => onRepo(event.target.value)} /></label>
          <label className="grid min-w-0 gap-1">
            <span className={FIELD_LABEL}>提取意图(必填,一句话)</span>
            <Input type="text" value={intent}
              placeholder="如:他们的重试与限流是怎么实现的"
              onChange={(event) => onIntent(event.target.value)} /></label>
          <label className="grid min-w-0 gap-1">
            <span className={FIELD_LABEL}>路径提示(可选,只是起点)</span>
            <Input type="text" value={hint} placeholder="如:src/main/java/…/retry"
              onChange={(event) => onHint(event.target.value)} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={extractBusy || !!job?.production?.working
              || !repo.trim() || !intent.trim()}
            onClick={onStart}>
            {job?.production?.working ? job.production.status_label : "开始提取"}</Button>
          {job?.status === "running" && <small className="text-sm/relaxed
            text-faint">
            只读会话正在读仓起草;完成后草稿出现在下方,可离开本页稍后再来。</small>}
        </div>
        {extractError && <Alert variant="destructive" role="alert" className="mb-2">
          {extractError}</Alert>}
        {job?.status === "failed" && <Alert variant="destructive"
          role="alert" className="mb-2">提取失败:{job.error ?? "未知原因"}</Alert>}
        {job?.status === "done" && <>
          <label className="grid gap-1">
            <span className={FIELD_LABEL}>草稿(可编辑;{verb}前请抽查论断与文件出处)</span>
            <Textarea rows={16} className="min-h-60 resize-y font-mono text-xs" value={draft}
              onChange={(event) => onDraft(event.target.value)} /></label>
          {job.notes && <p className="text-sm/relaxed
            text-muted-foreground">提取会话自述:{job.notes}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={busy || !draft.trim() || blocked}
              title={blocked ? missingText : undefined}
              onClick={onSubmitDraft}>
              {busy ? `${verb}中` : "用草稿提交审查"}</Button>
            <small className="text-sm/relaxed text-faint">{blocked
              ? `${missingText}；请在上方补齐。`
              : "目录名与知识属性已就绪，可直接提交。"}</small>
          </div>
        </>}
      </>}
    </div>
  </DetailPane>;
}
