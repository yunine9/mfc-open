import { ChangeFileTree } from "./ChangeFileTree";
import { VirtualDiffRows } from "./VirtualDiffRows";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  diffReviewRows,
  unifiedDiffRows,
  type DiffCell,
  type DiffReviewRow,
} from "./diffLines";
import {
  fileKind,
  parseChanges,
  type ChangedFile,
  type ChangeStage,
} from "./gitDiffTree";
import {
  DEFAULT_DIFF_FONT_SIZE,
  DEFAULT_DIFF_SPLIT,
  DEFAULT_TREE_PANEL_WIDTH,
  MAX_DIFF_FONT_SIZE,
  MIN_DIFF_FONT_SIZE,
  clampDiffFontSize,
  clampDiffSplit,
  clampTreePanelWidth,
  diffSplitFromPointer,
} from "./gitDiffLayout";
import { Button } from "@/components/ui/button";
import { cn } from "cn";

/** #232 换装:周边控件词典(汇总条/交付条/文件树/详情头),原 style.css
 * 的 git-diff 周边家族直译成令牌工具类,明暗自适应;#254 起周边裸 button
 * 收编 shadcn Button(词典串即 className,hover/aria-expanded/dark 与
 * active 位移都对基座做了钉死,行渲染机构不动)。diff 本体(着色行/
 * 行号列/词级高亮/diff-fold 折叠条/两道分栏把手)渲染机构不动,皮仍由
 * style.css 承担(diff-fold 的 embedded/studio 主题也被
 * reviewWorkspaceLayout 的 CSS 锚定,记录不动)。is-embedded(
 * workspace-studio 嵌入态)与 is-focused(专注检视)两档的摆位差由组件
 * 态直译成条件类,不再靠皮肤级联。 */
const GIT = {
  branchChip: "max-w-[220px] truncate rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_24%,var(--line))] bg-(--accent-soft) px-1.5 py-0.5 font-mono text-xs font-bold text-(--accent)",
  metaDot: "not-italic text-faint",
  totals: "flex gap-[9px] font-mono text-sm",
  totalPlus: "text-success",
  totalMinus: "text-danger",
  overview: "overflow-hidden rounded-[10px] border bg-surface",
  overviewIntro: "flex min-h-[62px] items-center gap-[11px] border-b bg-surface-soft px-3.5 py-[11px]",
  overviewIcon: "grid size-8 flex-none place-items-center rounded-lg bg-(--accent-soft) text-(--accent)",
  overviewCopy: "flex min-w-0 flex-col gap-[3px]",
  overviewTitle: "text-[13.5px] text-text-strong",
  overviewNote: "text-sm leading-snug text-muted-foreground",
  treeRow: "group/row relative flex min-w-0 items-center gap-1 rounded-[7px] border border-transparent pl-[calc(5px+var(--tree-depth,0)*12px)] pr-1 hover:bg-surface",
  treeRowCompact: "min-h-[42px]",
  treeRowOverview: "min-h-[46px]",
  treeRowOn: "border-line bg-surface shadow-(--shadow-xs)",
  treeRowUntracked: "bg-[color-mix(in_srgb,var(--attention)_4%,transparent)]",
  dirMain: "grid h-10 min-w-0 flex-1 cursor-pointer grid-cols-[13px_17px_minmax(0,1fr)_auto] items-center gap-1.5 border-0 bg-transparent p-0 text-left text-sm text-inherit hover:bg-transparent hover:text-inherit dark:hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-inherit dark:aria-expanded:bg-transparent",
  dirChevron: "size-3 fill-none stroke-faint stroke-[1.5] transition-transform duration-100",
  dirChevronOpen: "rotate-90",
  dirGlyph: "rotate-[-3deg] text-[13px] text-attention",
  dirName: "truncate font-mono text-[12.5px] font-semibold text-text-strong",
  dirCount: "text-sm not-italic text-muted-foreground",
  fileMain: "grid min-h-10 min-w-0 flex-1 cursor-pointer grid-cols-[24px_minmax(0,1fr)] items-center gap-[7px] border-0 bg-transparent p-0 text-left text-sm text-inherit hover:bg-transparent hover:text-inherit dark:hover:bg-transparent",
  fileKind: "grid size-[22px] place-items-center rounded-[5px] text-xs font-bold",
  fileName: "flex min-w-0 flex-col gap-0.5",
  fileNameStrong: "truncate font-mono text-sm font-semibold text-text-strong",
  fileSub: "flex min-w-0 items-center gap-1.5 overflow-hidden text-sm text-muted-foreground",
  fileSubPath: "truncate whitespace-nowrap",
  fileStats: "inline-flex flex-none gap-1 whitespace-nowrap font-mono text-sm font-semibold not-italic text-muted-foreground",
  fileStatsAdd: "not-italic text-success",
  fileStatsDel: "no-underline text-danger",
  deliveryCheck: "grid size-5 flex-none cursor-pointer place-items-center rounded-[5px] border border-line-strong bg-transparent p-0 text-transparent hover:border-(--accent) hover:bg-transparent hover:text-transparent dark:hover:bg-transparent",
  deliveryCheckOn: "border-(--accent) bg-(--accent) text-(--accent-fg) hover:bg-(--accent) hover:text-(--accent-fg)",
  deliveryCheckSvg: "size-[13px] fill-none stroke-current stroke-2",
  hideBtn: "absolute right-1 top-1/2 z-[1] grid size-[28px] -translate-y-1/2 cursor-pointer place-items-center rounded-[6px] border border-transparent bg-transparent p-0 text-muted-foreground opacity-0 hover:border-line-strong hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover/row:opacity-100 dark:hover:bg-danger-soft hover:text-danger active:-translate-y-1/2!",
  hideBtnSvg: "size-[15px] fill-none stroke-current stroke-[1.35]",
  groupHead: "mb-1 mt-0.5 flex items-center justify-between gap-2 rounded-[7px] px-2 py-[5px] text-sm",
  groupHeadLocal: "bg-surface-muted text-muted-foreground",
  groupHeadStrong: "font-bold tracking-[.02em]",
  groupHeadCount: "rounded-full px-2 py-px text-sm font-bold not-italic",
  treeUntracked: "mt-2",
  treeLazy: "ml-6 mr-2 mb-[5px] mt-[3px] flex items-center justify-between gap-2 rounded-md bg-surface-muted px-2.5 py-2 text-sm text-muted-foreground",
  treeLazyError: "text-danger",
  treeActionBtn: "cursor-pointer rounded-md border border-line bg-surface px-2.5 py-[5px] text-sm text-(--accent) hover:border-(--accent) h-auto hover:bg-surface hover:text-(--accent) dark:hover:bg-surface",
  loadMore: "mb-1.5 ml-4 mt-1 w-[calc(100%-24px)] cursor-pointer rounded-md border border-line bg-surface px-2.5 py-[5px] text-sm text-(--accent) hover:border-(--accent) disabled:cursor-wait disabled:opacity-60 h-auto hover:bg-surface hover:text-(--accent) dark:hover:bg-surface disabled:pointer-events-auto",
  untrackedNote: "flex min-h-[240px] flex-col items-center justify-center gap-[5px] text-sm text-muted-foreground",
  untrackedNoteTitle: "text-[15px] text-text-strong",
  detailHead: "flex min-h-[55px] items-center justify-between gap-3 border-b px-3.5 py-2.5",
  detailHeadFocused: "min-h-[62px] flex-none px-[18px]",
  detailHeadWrap: "flex-wrap",
  detailHeadLead: "flex min-w-0 flex-col gap-[3px]",
  detailHeadPath: "truncate font-mono text-[13px] font-semibold text-text-strong",
  detailHeadPathFocused: "text-sm",
  detailHeadPathWrap: "whitespace-normal [overflow-wrap:anywhere]",
  detailHeadSub: "text-sm text-muted-foreground",
  detailHeadStats: "flex gap-[7px] font-mono text-sm",
  detailActions: "flex min-w-max flex-none flex-row items-center gap-2.5",
  fontZoom: "inline-grid h-[29px] grid-cols-[31px_46px_31px] overflow-hidden rounded-md border bg-surface-soft",
  fontZoomBtn: "min-w-0 cursor-pointer border-0 bg-transparent p-0 text-sm font-bold text-text hover:bg-(--accent-soft) hover:text-(--accent) disabled:cursor-not-allowed disabled:opacity-40 h-auto dark:hover:bg-(--accent-soft) disabled:pointer-events-auto",
  fontZoomReset: "border-l border-line font-mono font-medium text-muted-foreground",
  summary: "mb-2.5 flex items-center justify-between gap-4 rounded-[10px] border bg-surface px-[15px] py-[13px]",
  summaryEmbedded: "m-0 flex-none rounded-none border-0 border-b px-[18px] py-3",
  summaryLead: "flex min-w-0 flex-col gap-0.5",
  summaryKicker: "text-sm font-bold text-(--accent)",
  summaryTitle: "text-[15px] text-text-strong",
  summaryTitleEmbedded: "text-sm",
  summaryMeta: "flex items-center gap-1.5 text-sm text-muted-foreground",
  summaryActions: "flex items-center gap-3.5",
  reviewHead: "grid min-h-[68px] flex-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[18px] border-b bg-surface px-[22px] text-text shadow-(--shadow-sm)",
  reviewTitle: "grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-[9px]",
  reviewKicker: "text-sm font-extrabold text-(--accent)",
  reviewTitleStrong: "text-base text-text-strong",
  reviewMeta: "flex items-center gap-1.5 overflow-hidden truncate text-sm text-muted-foreground",
  reviewTotals: "flex gap-2.5 font-mono text-[13px] font-bold",
  deliveryBar: "mb-2.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[9px] border px-3 py-2.5 text-sm",
  deliveryBarFocused: "m-0 flex-none rounded-none border-x-0 border-t-0",
  deliveryBarEmbedded: "px-[18px] py-2.5",
  deliveryBarLead: "grid min-w-0 gap-0.5",
  deliveryBarTitle: "text-[13.5px] text-inherit",
  deliveryBarNote: "text-sm leading-snug text-text",
  deliveryBarActions: "flex items-center gap-1.5",
  deliveryBarFoot: "col-span-full text-sm text-muted-foreground",
} as const;

/** 文件种类的角标色板(原 .kind-代码/文档/测试 直译;其余种类收灰)。 */
const GIT_KIND_TONE: Record<string, string> = {
  "代码": "bg-(--accent-soft) text-(--accent)",
  "文档": "bg-success-soft text-success",
  "测试": "bg-attention-soft text-attention",
};

const stageName: Record<ChangeStage, string> = {
  committed: "已提交",
  committed_working: "已提交后又修改",
  staged: "已暂存",
  staged_working: "已暂存后又修改",
  unstaged: "未暂存",
  untracked: "未跟踪",
};

function storedNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export interface GitDiffFileManifest {
  path: string;
  stage: ChangeStage;
  additions: number;
  deletions: number;
  stats_status?: "unavailable" | "binary";
}

export interface GitDiffDirectoryManifest {
  path: string;
  stage: "untracked";
}

export interface GitDiffDirectoryEntry {
  path: string;
  kind: "file" | "directory";
  file_count: number;
  stage: "untracked";
  stats_status?: "unavailable" | "binary";
  additions?: number;
  deletions?: number;
}

export interface GitDiffDirectoryPage {
  path: string;
  entries: GitDiffDirectoryEntry[];
  total_entries: number;
  total_files: number;
  next_offset?: number;
}

interface LoadedDirectory {
  open: boolean;
  loading: boolean;
  error?: string;
  entries?: GitDiffDirectoryEntry[];
  totalEntries?: number;
  totalFiles?: number;
  nextOffset?: number;
}

/**
 * 文件树以服务端的小体积完整清单为准，正文只补当前已经读取的文件。
 * 这样前几个大文件即使触发正文上限，后面的文件仍然全部可见可点。
 */
export function filesForDiff(
  text: string,
  manifest?: readonly GitDiffFileManifest[],
): ChangedFile[] {
  const parsed = parseChanges(text);
  if (!manifest?.length) return parsed;
  const contentByPath = new Map(parsed.map((file) => [file.path, file]));
  return manifest.map((entry) => {
    const content = contentByPath.get(entry.path);
    return content
      ? {
          ...content,
          ...entry,
          key: `${entry.stage}:${entry.path}`,
          stage: entry.stage,
        }
      : {
          ...entry,
          key: `${entry.stage}:${entry.path}`,
          kind: fileKind(entry.path),
          lines: [],
        };
  });
}

type ReviewEntry = DiffReviewRow | {
  type: "fold";
  key: string;
  count: number;
};

function contextRow(row: DiffReviewRow): boolean {
  return row.type === "line"
    && row.old?.kind === "context"
    && row.next?.kind === "context";
}

/** 默认只露出改动附近；被藏的上下文仍在页面数据里，可逐段或一次展开。 */
function foldedRows(
  rows: DiffReviewRow[],
  expanded: Set<string>,
  showAll: boolean,
): { entries: ReviewEntry[]; hidden: number } {
  if (showAll) return { entries: rows, hidden: 0 };
  const entries: ReviewEntry[] = [];
  let hidden = 0;
  let cursor = 0;
  while (cursor < rows.length) {
    if (!contextRow(rows[cursor])) {
      entries.push(rows[cursor]);
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < rows.length && contextRow(rows[end])) end += 1;
    const count = end - cursor;
    if (count <= 8) {
      entries.push(...rows.slice(cursor, end));
    } else {
      const foldStart = cursor + 3;
      const foldEnd = end - 3;
      const key = `${foldStart}:${foldEnd}`;
      entries.push(...rows.slice(cursor, foldStart));
      if (expanded.has(key)) {
        entries.push(...rows.slice(foldStart, foldEnd));
      } else {
        const folded = foldEnd - foldStart;
        hidden += folded;
        entries.push({ type: "fold", key, count: folded });
      }
      entries.push(...rows.slice(foldEnd, end));
    }
    cursor = end;
  }
  return { entries, hidden };
}

function DiffCellView({ cell, side }: { cell?: DiffCell; side: "old" | "new" }) {
  const mark = cell?.kind === "added" ? "+"
    : cell?.kind === "removed" ? "−" : "";
  const text = cell?.text ?? "";
  const [from, to] = cell?.emphasis ?? [0, 0];
  // 词级高亮:mark 元素不改变 textContent,批注取 [data-code] 原文
  // 与整行文本完全一致,锚定比对不受影响。
  const body = to > from
    ? <span data-code data-code-side={side}>{text.slice(0, from)}<mark>{text.slice(from, to)}</mark>{text.slice(to)}</span>
    : <span data-code data-code-side={side}>{text}</span>;
  return (
    <div className={`diff-cell ${cell?.kind ?? "empty"}`}>
      <span className="diff-line-number">{cell?.number ?? ""}</span>
      {/* data-code 圈出"纯代码文本":批注取原文只能取这一段。整行
          textContent 会把左边的行号和 +/− 标记一起抓进去,拿这种脏
          原文回头比对必然对不上,于是"这处已被改动"整片误报。
          内核面板也是分开取的(.ln 取行号、.c 取代码)。 */}
      <code><i aria-hidden>{mark}</i>{body}</code>
    </div>
  );
}

export function GitDiff({
  text,
  branch,
  manifest,
  untrackedDirectories,
  onFileSelect,
  onDirectoryLoad,
  activeFileLoading = false,
  activeFileError = "",
  onRetry,
  hideKey,
  scopeLabel,
  focusRequest = 0,
  embeddedBrowser = false,
  annotationLocation,
}: {
  text: string;
  branch?: string;
  /** 完整文件目录；正文 text 可以只包含当前点开的一个文件。 */
  manifest?: readonly GitDiffFileManifest[];
  /** 未跟踪目录只给根节点，避免一次编译把数万文件灌进 React。 */
  untrackedDirectories?: readonly GitDiffDirectoryManifest[];
  onFileSelect?: (path: string) => void;
  /** 用户展开未跟踪目录时分页读取其直接子项。 */
  onDirectoryLoad?: (
    path: string,
    offset: number,
  ) => Promise<GitDiffDirectoryPage>;
  activeFileLoading?: boolean;
  activeFileError?: string;
  onRetry?: () => void;
  /** 每任务保存自己的视图隐藏项；隐藏不参与 Git 或交付判断。 */
  hideKey?: string;
  /** 当前对比范围的人话(如"本次修改 · a2f2715 → 510a5fa")。缺省
   * 沿用工作区语义。曾经硬编码"任务基线至当前工作区",HEAD→HEAD
   * 的增量也顶着这行标题(MFC-007)。 */
  scopeLabel?: string;
  /** 外部明确请求进入专注审阅；递增即可重复打开。 */
  focusRequest?: number;
  /** Keep the full file tree and diff in the workspace instead of opening a modal. */
  embeddedBrowser?: boolean;
  /** 从检视意见进入时显式选择文件，并展开被折叠的目标行。 */
  annotationLocation?: { file: string; request: number };
}) {
  const baseFiles = useMemo(() => filesForDiff(text, manifest), [text, manifest]);
  const directoryRoots = useMemo(() => [...new Map(
    (untrackedDirectories ?? []).map((directory) =>
      [directory.path, directory] as const)).values()], [untrackedDirectories]);
  const directoryRootKey = directoryRoots.map((directory) => directory.path)
    .join("\0");
  const [loadedUntrackedFiles, setLoadedUntrackedFiles] =
    useState<Map<string, ChangedFile>>(new Map());
  const files = useMemo(() => {
    if (!loadedUntrackedFiles.size) return baseFiles;
    const merged = new Map(baseFiles.map((file) => [file.path, file]));
    const contentByPath = new Map(parseChanges(text)
      .map((file) => [file.path, file] as const));
    for (const file of loadedUntrackedFiles.values()) {
      const content = contentByPath.get(file.path);
      merged.set(file.path, content
        ? { ...content, ...file, lines: content.lines }
        : file);
    }
    return [...merged.values()];
  }, [baseFiles, loadedUntrackedFiles, text]);
  const [loadedDirectories, setLoadedDirectories] =
    useState<Record<string, LoadedDirectory>>({});
  const [selected, setSelected] = useState(baseFiles[0]?.key ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focusRequest > 0 && !embeddedBrowser) setFocused(true);
  }, [focusRequest, embeddedBrowser]);
  const [treePanelWidth, setTreePanelWidth] = useState(() =>
    clampTreePanelWidth(storedNumber("mae-flow:git-tree-width",
      DEFAULT_TREE_PANEL_WIDTH), 2000));
  const [diffSplit, setDiffSplit] = useState(() =>
    clampDiffSplit(storedNumber("mae-flow:git-diff-split", DEFAULT_DIFF_SPLIT)));
  const [diffFontSize, setDiffFontSize] = useState(() =>
    clampDiffFontSize(storedNumber("mae-flow:git-diff-font-size",
      DEFAULT_DIFF_FONT_SIZE)));
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [hiddenDirectories, setHiddenDirectories] =
    useState<Set<string>>(new Set());
  const gitBrowser = useRef<HTMLDivElement>(null);
  const diffCanvas = useRef<HTMLDivElement>(null);
  const diffScroll = useRef<HTMLDivElement>(null);
  const [unified, setUnified] = useState(true);
  const [treeHidden, setTreeHidden] = useState(false);
  // 分栏把手是否真被拖动过:拖动收尾的 click 不算"点了一行"(MFC-034)。
  const resizerDragged = useRef(false);
  const [pathTip, setPathTip] = useState<{
    path: string;
    left: number;
    top: number;
  }>();
  const hiddenStorageKey = hideKey
    ? `mae-flow:hidden-change-files:${hideKey}` : "";
  const hiddenDirectoryStorageKey = hideKey
    ? `mae-flow:hidden-change-directories:${hideKey}` : "";
  const pathInsideDirectory = (path: string, directory: string) =>
    path.startsWith(`${directory}/`);
  const hiddenByDirectory = (path: string) => [...hiddenDirectories]
    .some((directory) => pathInsideDirectory(path, directory));
  const visibleFiles = useMemo(
    () => files.filter((file) => !hiddenPaths.has(file.path)
      && !hiddenByDirectory(file.path)),
    [files, hiddenPaths, hiddenDirectories],
  );
  const visibleDirectoryRoots = useMemo(() => directoryRoots.filter(
    (directory) => !hiddenDirectories.has(directory.path)),
  [directoryRoots, hiddenDirectories]);
  // 按需载入的未跟踪文件由下面的懒目录原位绘制，不能又塞进普通树
  // 形成两份同名节点。
  const treeFiles = useMemo(() => visibleFiles.filter((file) =>
    !directoryRoots.some((directory) =>
      pathInsideDirectory(file.path, directory.path))),
  [visibleFiles, directoryRoots]);

  useEffect(() => {
    if (!hiddenStorageKey || typeof window === "undefined") {
      setHiddenPaths(new Set());
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(hiddenStorageKey) ?? "[]");
      setHiddenPaths(new Set(Array.isArray(saved) ? saved.map(String) : []));
    } catch {
      setHiddenPaths(new Set());
    }
  }, [hiddenStorageKey]);

  useEffect(() => {
    if (!hiddenDirectoryStorageKey || typeof window === "undefined") {
      setHiddenDirectories(new Set());
      return;
    }
    try {
      const saved = JSON.parse(
        localStorage.getItem(hiddenDirectoryStorageKey) ?? "[]");
      setHiddenDirectories(new Set(
        Array.isArray(saved) ? saved.map(String) : []));
    } catch {
      setHiddenDirectories(new Set());
    }
  }, [hiddenDirectoryStorageKey]);

  useEffect(() => {
    if (!hiddenStorageKey || typeof window === "undefined") return;
    localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenPaths]));
  }, [hiddenPaths, hiddenStorageKey]);

  useEffect(() => {
    if (!hiddenDirectoryStorageKey || typeof window === "undefined") return;
    localStorage.setItem(hiddenDirectoryStorageKey,
      JSON.stringify([...hiddenDirectories]));
  }, [hiddenDirectories, hiddenDirectoryStorageKey]);

  useEffect(() => {
    setLoadedDirectories({});
    setLoadedUntrackedFiles(new Map());
  }, [directoryRootKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("mae-flow:git-tree-width", String(treePanelWidth));
      localStorage.setItem("mae-flow:git-diff-split", String(diffSplit));
      localStorage.setItem("mae-flow:git-diff-font-size", String(diffFontSize));
    } catch {
      // 阅读偏好写不进去不影响代码检视。
    }
  }, [treePanelWidth, diffSplit, diffFontSize]);

  useEffect(() => {
    if (!focused || typeof window === "undefined") return;
    const fitTreePanel = () => {
      const width = gitBrowser.current?.getBoundingClientRect().width;
      if (width) setTreePanelWidth((current) =>
        clampTreePanelWidth(current, width));
    };
    fitTreePanel();
    window.addEventListener("resize", fitTreePanel);
    return () => window.removeEventListener("resize", fitTreePanel);
  }, [focused]);

  useEffect(() => {
    const available = new Set(files.map((file) => file.path));
    setHiddenPaths((current) => {
      const next = new Set([...current].filter((path) => available.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [files.map((file) => file.path).join("\0")]);

  useEffect(() => {
    setHiddenDirectories((current) => {
      const next = new Set([...current].filter((path) => directoryRoots.some(
        (root) => path === root.path || pathInsideDirectory(path, root.path))));
      return next.size === current.size ? current : next;
    });
  }, [directoryRootKey]);

  useEffect(() => {
    if (!visibleFiles.some((file) => file.key === selected)) {
      setSelected(visibleFiles[0]?.key ?? "");
    }
  }, [visibleFiles, selected]);
  const requestedFile = annotationLocation && files.find((file) => file.path === annotationLocation.file);
  const active = requestedFile ?? visibleFiles.find((file) => file.key === selected)
    ?? visibleFiles[0];
  useEffect(() => {
    if (active?.path) onFileSelect?.(active.path);
  }, [active?.path, onFileSelect]);
  useEffect(() => {
    setExpanded(new Set());
    setShowAll(false);
    setPathTip(undefined);
  }, [active?.key]);
  const reviewRows = useMemo(
    () => diffReviewRows(active?.lines ?? []),
    [active],
  );
  const displayRows = useMemo(() => unified ? unifiedDiffRows(reviewRows) : reviewRows, [reviewRows, unified]);
  const folded = useMemo(
    () => foldedRows(displayRows, expanded, showAll || Boolean(requestedFile)),
    [displayRows, expanded, showAll, requestedFile],
  );
  useEffect(() => {
    if (requestedFile) {
      setSelected(requestedFile.key); setShowAll(true);
      setHiddenPaths((current) => new Set([...current].filter((path) => path !== requestedFile.path)));
      setHiddenDirectories((current) => new Set([...current]
        .filter((path) => !requestedFile.path.startsWith(`${path}/`))));
    }
  }, [requestedFile?.key, annotationLocation?.request]);
  const lineCount = reviewRows.reduce((largest, row) => row.type === "line"
    ? Math.max(largest, row.next?.number ?? row.old?.number ?? 0)
    : largest, 0);
  const hasTextRows = reviewRows.some((row) => row.type === "line");
  const canFold = showAll || folded.hidden > 0 || expanded.size > 0;
  const countedFiles = files;
  const additions = countedFiles.reduce(
    (sum, file) => sum + file.additions, 0);
  const deletions = countedFiles.reduce(
    (sum, file) => sum + file.deletions, 0);
  const branchLabel = branch || "分支未知";
  function hideFiles(paths: string[]) {
    setHiddenPaths((current) => new Set([...current, ...paths]));
  }

  function resizeTreePanel(clientX: number) {
    const box = gitBrowser.current?.getBoundingClientRect();
    if (!box) return;
    setTreePanelWidth(clampTreePanelWidth(clientX - box.left, box.width));
  }

  function resizeDiffColumns(clientX: number) {
    const box = diffCanvas.current?.getBoundingClientRect();
    if (!box) return;
    setDiffSplit(diffSplitFromPointer(clientX, box.left, box.width));
  }

  async function loadUntrackedDirectory(path: string, append = false) {
    if (!onDirectoryLoad) return;
    const current = loadedDirectories[path];
    const offset = append ? current?.nextOffset : 0;
    if (append && offset === undefined) return;
    setLoadedDirectories((directories) => ({
      ...directories,
      [path]: {
        ...directories[path],
        open: true,
        loading: true,
        error: undefined,
      },
    }));
    try {
      const page = await onDirectoryLoad(path, offset ?? 0);
      setLoadedDirectories((directories) => {
        const previous = append ? directories[path]?.entries ?? [] : [];
        const entries = [...new Map([...previous, ...page.entries]
          .map((entry) => [entry.path, entry] as const)).values()];
        return {
          ...directories,
          [path]: {
            open: true,
            loading: false,
            entries,
            totalEntries: page.total_entries,
            totalFiles: page.total_files,
            nextOffset: page.next_offset,
          },
        };
      });
      const fileEntries = page.entries.filter((entry) => entry.kind === "file");
      if (fileEntries.length) {
        setLoadedUntrackedFiles((currentFiles) => {
          const next = new Map(currentFiles);
          for (const entry of fileEntries) {
            next.set(entry.path, {
              key: `untracked:${entry.path}`,
              path: entry.path,
              stage: "untracked",
              kind: fileKind(entry.path),
              lines: [],
              additions: entry.additions ?? 0,
              deletions: entry.deletions ?? 0,
              stats_status: entry.stats_status ?? (entry.additions === undefined ? "unavailable" : undefined),
            });
          }
          return next;
        });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setLoadedDirectories((directories) => ({
        ...directories,
        [path]: {
          ...directories[path],
          open: true,
          loading: false,
          error: message,
        },
      }));
    }
  }

  function toggleUntrackedDirectory(path: string) {
    const current = loadedDirectories[path];
    if (!current?.entries && !current?.loading) {
      void loadUntrackedDirectory(path);
      return;
    }
    setLoadedDirectories((directories) => ({
      ...directories,
      [path]: { ...directories[path], open: !directories[path]?.open },
    }));
  }

  function renderFile(file: ChangedFile, depth: number, overview: boolean) {
    return (
      <div className={cn(GIT.treeRow, overview ? GIT.treeRowOverview : GIT.treeRowCompact,
        file.key === active?.key && GIT.treeRowOn)}
        key={file.key} style={{ "--tree-depth": depth } as CSSProperties}>
        <Button type="button" className={GIT.fileMain} title={file.path}
          onClick={() => {
            setSelected(file.key);
            if (overview) setFocused(true);
          }}
          onPointerEnter={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setPathTip({ path: file.path, left: box.right + 9,
              top: box.top + box.height / 2 });
          }}
          onPointerLeave={() => setPathTip(undefined)}
          onFocus={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setPathTip({ path: file.path, left: box.right + 9,
              top: box.top + box.height / 2 });
          }}
          onBlur={() => setPathTip(undefined)}>
          <span className={cn(GIT.fileKind, GIT_KIND_TONE[file.kind]
            ?? "bg-surface-muted text-muted-foreground")}>{file.kind.slice(0, 1)}</span>
          <span className={GIT.fileName}><strong className={GIT.fileNameStrong}>{file.path.split("/").at(-1)}</strong>
            <small className={GIT.fileSub}><span className={GIT.fileSubPath}>{stageName[file.stage]} · {file.kind}</span>
              {file.stats_status ? <span title="尚未取得完整行数统计">{file.stats_status === "binary" ? "二进制" : "—"}</span> : (file.additions > 0 || file.deletions > 0) && (
                <i className={GIT.fileStats}><em className={GIT.fileStatsAdd}>+{file.additions}</em>
                  <del className={GIT.fileStatsDel}>−{file.deletions}</del></i>
              )}</small></span>
        </Button>
        <Button type="button" className={GIT.hideBtn} title="从当前视图隐藏；不改变提交内容"
          aria-label={`隐藏 ${file.path}`} onClick={() => hideFiles([file.path])}>
          <svg viewBox="0 0 18 18" aria-hidden className={GIT.hideBtnSvg}><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
        </Button>
      </div>
    );
  }

  function renderUntrackedDirectory(
    directory: GitDiffDirectoryManifest | GitDiffDirectoryEntry,
    depth: number,
    overview: boolean,
  ): ReactNode {
    if (hiddenDirectories.has(directory.path)) return null;
    const state = loadedDirectories[directory.path];
    const open = state?.open === true;
    const count = state?.totalFiles
      ?? ("file_count" in directory ? directory.file_count : undefined);
    const label = depth === 0 ? directory.path
      : directory.path.split("/").at(-1) ?? directory.path;
    return (
      <div className="change-tree-directory" key={`untracked-directory:${directory.path}`}>
        <div className={cn(GIT.treeRow, overview ? GIT.treeRowOverview : GIT.treeRowCompact,
          GIT.treeRowUntracked)}
          style={{ "--tree-depth": depth } as CSSProperties}>
          <Button type="button" className={GIT.dirMain}
            title={`${directory.path}（未跟踪目录，展开时按需读取）`}
            aria-expanded={open}
            onClick={() => toggleUntrackedDirectory(directory.path)}>
            <svg viewBox="0 0 16 16" aria-hidden
              className={cn(GIT.dirChevron, open && GIT.dirChevronOpen)}><path d="m6 3 5 5-5 5" /></svg>
            <span aria-hidden className={GIT.dirGlyph}>▰</span><strong className={GIT.dirName}>{label}</strong>
            <i className={GIT.dirCount}>{count === undefined ? "按需" : count}</i>
          </Button>
          <Button type="button" className={GIT.hideBtn}
            title="隐藏整个未跟踪目录；不改变 Git 或提交内容"
            aria-label={`隐藏目录 ${directory.path}`}
            onClick={() => setHiddenDirectories((current) =>
              new Set([...current, directory.path]))}>
            <svg viewBox="0 0 18 18" aria-hidden className={GIT.hideBtnSvg}><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
          </Button>
        </div>
        {open && <div className="change-tree-children">
          {state?.loading && !state.entries?.length && (
            <div className={GIT.treeLazy}>正在读取这一层…</div>
          )}
          {state?.error && (
            <div className={cn(GIT.treeLazy, GIT.treeLazyError)}>
              <span>{state.error}</span>
              <Button type="button" className={GIT.treeActionBtn} onClick={() =>
                void loadUntrackedDirectory(directory.path)}>重试</Button>
            </div>
          )}
          {state?.entries?.map((entry) => entry.kind === "directory"
            ? renderUntrackedDirectory(entry, depth + 1, overview)
            : hiddenPaths.has(entry.path) || hiddenByDirectory(entry.path)
              ? null
              : renderFile(files.find(file => file.path === entry.path) ?? {
                  key: `untracked:${entry.path}`,
                  path: entry.path,
                  stage: "untracked",
                  kind: fileKind(entry.path),
                  lines: [],
                  additions: entry.additions ?? 0,
                  deletions: entry.deletions ?? 0,
                  stats_status: entry.stats_status ?? (entry.additions === undefined ? "unavailable" : undefined),
                }, depth + 1, overview))}
          {state?.nextOffset !== undefined && (
            <Button type="button" className={GIT.loadMore}
              disabled={state.loading}
              onClick={() => void loadUntrackedDirectory(
                directory.path, true)}>
              {state.loading ? "正在加载…" : `继续加载（已显示 ${
                state.entries?.length ?? 0} / ${state.totalEntries ?? 0} 项）`}
            </Button>
          )}
          {!state?.loading && !state?.error && state?.entries?.length === 0 && (
            <div className={GIT.treeLazy}>目录当前没有可展示的未跟踪文件</div>
          )}
        </div>}
      </div>
    );
  }

  function renderUntrackedDirectories(overview: boolean) {
    if (!visibleDirectoryRoots.length) return null;
    return (
      <div className={GIT.treeUntracked}>
        <div className={cn(GIT.groupHead, GIT.groupHeadLocal)}>
          <strong className={GIT.groupHeadStrong}>未跟踪目录 · 默认折叠</strong>
          <i className={cn(GIT.groupHeadCount,
            "bg-[color-mix(in_srgb,var(--muted)_14%,transparent)] text-muted-foreground")}>{visibleDirectoryRoots.length}</i>
        </div>
        {visibleDirectoryRoots.map((directory) =>
          renderUntrackedDirectory(directory, 0, overview))}
      </div>
    );
  }

  function renderTree(overview: boolean) {
    return <div className={`change-tree-content${overview ? " is-overview" : ""}`}>
      <ChangeFileTree files={treeFiles} activePath={active?.path}
        onSelect={file => { setSelected(file.key); if (!embeddedBrowser) setFocused(true); }} />
      {visibleDirectoryRoots.length > 0 && <div className="change-lazy-directories">
        <div className="change-tree-tools">未跟踪目录 · 按需展开</div>{renderUntrackedDirectories(overview)}
      </div>}
    </div>;
  }

  if (!files.length && !directoryRoots.length) {
    return <div className={cn(GIT.untrackedNote, "text-center")}>
      <strong className={GIT.untrackedNoteTitle}>{activeFileLoading ? "正在读取变更文件…" : text.trim() ? "暂时无法展示代码差异" : "暂无代码变更"}</strong>
      <span>{text.trim() ? "文件清单尚未就绪，请重新读取。" : "文件发生改动后会显示在这里。"}</span>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>重新读取</Button>}</div>;
  }

  return (
    <section className={`git-change-view${focused ? " is-focused" : ""}${embeddedBrowser ? " is-embedded" : ""}`}
      aria-label={focused ? "专注代码审阅" : "代码改动"}
      role={focused ? "dialog" : undefined}
      aria-modal={focused ? "true" : undefined}
      onKeyDown={(event) => {
        if (focused && event.key === "Escape") {
          event.stopPropagation();
          setFocused(false);
        }
      }}>
      {focused ? (
        <header className={GIT.reviewHead}>
          <Button type="button" variant="outline" size="sm" autoFocus
            onClick={() => setFocused(false)}>
            <svg viewBox="0 0 20 20" aria-hidden className="size-[15px] fill-none stroke-current stroke-[1.5]"><path d="m12.5 5-5 5 5 5" /></svg>
            返回工作台
          </Button>
          <div className={GIT.reviewTitle}>
            <span className={GIT.reviewKicker}>代码检视</span>
            <strong className={GIT.reviewTitleStrong}>代码审阅</strong>
            <small className={GIT.reviewMeta}><code className={cn(GIT.branchChip, "max-w-[260px] flex-none")}
              title={`当前分支：${branchLabel}`}>{branchLabel}</code>
              <i className={GIT.metaDot}>·</i>{scopeLabel ?? "任务基线至当前工作区"}</small>
          </div>
          <div className={GIT.reviewTotals} aria-label="变更统计">
            <b className={GIT.totalPlus}>+{additions}</b><i className={cn("not-italic", GIT.totalMinus)}>−{deletions}</i>
          </div>
        </header>
      ) : (
        <header className={cn("change-summary", GIT.summary, embeddedBrowser && GIT.summaryEmbedded)}>
          <div className={cn("change-summary-lead", GIT.summaryLead)}>
            <span className={cn(GIT.summaryKicker, embeddedBrowser && "hidden")}>代码改动</span>
            <strong className={cn(GIT.summaryTitle, embeddedBrowser && GIT.summaryTitleEmbedded)}>{baseFiles.length} 个文件发生变化{directoryRoots.length
              ? ` · ${directoryRoots.length} 个未跟踪目录` : ""}</strong>
            <small className={GIT.summaryMeta}><code className={GIT.branchChip}
              title={`当前分支：${branchLabel}`}>{branchLabel}</code>
              <i className={GIT.metaDot}>·</i>{scopeLabel ?? "任务基线至当前工作区"}</small>
          </div>
          <div className={GIT.summaryActions}>
            <div className={GIT.totals} aria-label="变更统计">
              <b className={GIT.totalPlus}>+{additions}</b><b className={GIT.totalMinus}>−{deletions}</b>
            </div>
            {!embeddedBrowser && <Button type="button" variant="outline" size="sm"
              onClick={() => setFocused(true)}>
              <svg viewBox="0 0 18 18" aria-hidden className="size-3.5 fill-none stroke-current stroke-[1.35]"><path d="M6.5 3H3v3.5M11.5 3H15v3.5M6.5 15H3v-3.5M11.5 15H15v-3.5" /></svg>
              专注审阅
            </Button>}
          </div>
        </header>
      )}

      {(hiddenPaths.size > 0 || hiddenDirectories.size > 0) && (
        <div className={cn(GIT.deliveryBar, focused && GIT.deliveryBarFocused,
          embeddedBrowser && GIT.deliveryBarEmbedded)}>
          <div className={GIT.deliveryBarActions}>
            {(hiddenPaths.size > 0 || hiddenDirectories.size > 0) && <Button type="button"
              variant="outline" size="sm"
              title="隐藏只影响浏览，不改变提交内容"
              onClick={() => {
                setHiddenPaths(new Set());
                setHiddenDirectories(new Set());
              }}>
              恢复 {hiddenPaths.size + hiddenDirectories.size} 个隐藏项
            </Button>}
          </div>
          {(hiddenPaths.size > 0 || hiddenDirectories.size > 0)
            && <small className={GIT.deliveryBarFoot}>隐藏仅整理视图，不会自动排除提交。</small>}
        </div>
      )}

      {focused || embeddedBrowser ? (
      <div className={`git-change-browser${treeHidden ? " is-tree-hidden" : ""}`} ref={gitBrowser}
        style={{ "--change-tree-width": `${treePanelWidth}px` } as CSSProperties}>
        <nav className="change-files" aria-label="变更文件">
          {renderTree(false)}
        </nav>

        <div className="change-panel-resizer" role="separator" tabIndex={0}
          aria-label="调整目录树宽度" aria-orientation="vertical"
          aria-valuemin={240} aria-valuemax={560} aria-valuenow={treePanelWidth}
          title="左右拖动调整目录树；双击恢复默认"
          onDoubleClick={() => setTreePanelWidth(DEFAULT_TREE_PANEL_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const width = gitBrowser.current?.getBoundingClientRect().width ?? 1200;
            setTreePanelWidth(clampTreePanelWidth(
              treePanelWidth + (event.key === "ArrowLeft" ? -16 : 16), width));
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeTreePanel(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              resizeTreePanel(event.clientX);
            }
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}>
          <span aria-hidden />
        </div>

        <section className="change-file-detail">
          <header className={cn("change-detail-header", GIT.detailHead, focused && GIT.detailHeadFocused,
            embeddedBrowser && GIT.detailHeadWrap)}>
            <div className={GIT.detailHeadLead}><strong title={active?.path}
              className={cn(GIT.detailHeadPath, focused && GIT.detailHeadPathFocused,
                embeddedBrowser && GIT.detailHeadPathWrap)}>{active?.path}</strong>
              <span className={GIT.detailHeadSub}>{active && `${stageName[active.stage]} · ${active.kind}${lineCount ? ` · ${lineCount} 行` : ""}`}</span></div>
            <div className={GIT.detailActions}>
              <Button type="button" variant="outline" size="sm" aria-expanded={!treeHidden}
                onClick={() => setTreeHidden(value => !value)}>{treeHidden ? "展开目录" : "收起目录"}</Button>
              <div className="diff-view-toggle" aria-label="差异显示方式">
                <Button type="button" variant="ghost" size="xs" className="h-auto" aria-pressed={!unified} onClick={() => setUnified(false)}>左右对比</Button>
                <Button type="button" variant="ghost" size="xs" className="h-auto" aria-pressed={unified} onClick={() => setUnified(true)}>上下对比</Button>
              </div>
              {active && (active.additions > 0 || active.deletions > 0) && (
                <small className={GIT.detailHeadStats}><b className={GIT.totalPlus}>+{active.additions}</b>
                  <i className={cn("not-italic", GIT.totalMinus)}>−{active.deletions}</i></small>)}
              <div className={GIT.fontZoom} aria-label="Git 字号">
                <Button type="button" aria-label="缩小 Git 字号"
                  className={GIT.fontZoomBtn}
                  disabled={diffFontSize <= MIN_DIFF_FONT_SIZE}
                  onClick={() => setDiffFontSize(clampDiffFontSize(diffFontSize - 1))}>
                  A−
                </Button>
                <Button type="button" className={cn(GIT.fontZoomBtn, GIT.fontZoomReset)}
                  title="恢复默认 Git 字号"
                  onClick={() => setDiffFontSize(DEFAULT_DIFF_FONT_SIZE)}>
                  {Math.round((diffFontSize / DEFAULT_DIFF_FONT_SIZE) * 100)}%
                </Button>
                <Button type="button" aria-label="放大 Git 字号"
                  className={GIT.fontZoomBtn}
                  disabled={diffFontSize >= MAX_DIFF_FONT_SIZE}
                  onClick={() => setDiffFontSize(clampDiffFontSize(diffFontSize + 1))}>
                  A+
                </Button>
              </div>
              {canFold && (
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  setShowAll((value) => !value);
                  if (showAll) setExpanded(new Set());
                }}>{showAll ? "折叠未改动" : "展开全文"}</Button>
              )}
            </div>
          </header>
          {activeFileLoading ? (
            <div className={GIT.untrackedNote}><strong className={GIT.untrackedNoteTitle}>正在读取这个文件…</strong>
              <span>文件清单已经完整加载，正文按需打开。</span></div>
          ) : activeFileError ? (
            <div className={GIT.untrackedNote} role="alert">
              <strong className={GIT.untrackedNoteTitle}>这个文件暂时打不开</strong><span>{activeFileError}</span>
              {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>重新读取</Button>}
            </div>
          ) : !active && directoryRoots.length ? (
            <div className={GIT.untrackedNote}>
              <strong className={GIT.untrackedNoteTitle}>未跟踪目录已折叠</strong>
              <span>从左侧展开需要查看的目录，再选择具体文件；目录内容不会一次性灌入页面。</span>
            </div>
          ) : !hasTextRows ? (
            <div className={GIT.untrackedNote}><strong className={GIT.untrackedNoteTitle}>没有可展示的文本内容</strong><span>文件可能为空、不可读或属于无法逐行比较的类型。</span></div>
          ) : (
            // data-file / data-l 是批注的锚:批注层用事件委托认它们,
            // 不需要 GitDiff 知道批注这回事(内核面板也是这么分层的)。
            <div ref={diffScroll} className={`ws-diff diff-review${unified ? " is-unified" : ""}`} data-file={active?.path}
              style={{ "--git-diff-font-size": `${diffFontSize}px` } as CSSProperties}>
              <div className="diff-review-canvas" ref={diffCanvas}
                style={{ "--diff-before-width": `${diffSplit}%` } as CSSProperties}>
                <div className="diff-review-head"><span>{unified ? "代码差异" : "变更前"}</span>{!unified && <span>变更后</span>}</div>
                <VirtualDiffRows rows={folded.entries} scrollElement={() => diffScroll.current}
                  enabled={!requestedFile} rowHeight={Math.max(28, diffFontSize * 1.5)} render={(row, index) => {
                  if (row.type === "fold") {
                    return (
                      <button className="diff-fold" type="button" key={row.key}
                        onClick={() => setExpanded((current) => new Set(current).add(row.key))}>
                        <span>···</span>展开 {row.count} 行未改动内容
                      </button>
                    );
                  }
                  if (row.type !== "line") {
                    return <div className={`diff-review-${row.type}`} key={`${row.type}:${index}`}>{row.text}</div>;
                  }
                  const at = row.next?.number;
                  return (
                    <div className="diff-review-row" key={`line:${index}`}
                      {...(at ? { "data-l": at } : {})}>
                      {(!unified || row.old?.kind === "removed") && <DiffCellView cell={row.old} side="old" />}
                      {(!unified || row.next) && <DiffCellView cell={row.next} side="new" />}
                    </div>
                  );
                }} />
                {!unified && <div className="diff-column-resizer" role="separator" tabIndex={0}
                  aria-label="调整变更前后宽度" aria-orientation="vertical"
                  aria-valuemin={25} aria-valuemax={75}
                  aria-valuenow={Math.round(diffSplit)}
                  title="左右拖动调整变更前后宽度；双击恢复对半"
                  onDoubleClick={() => setDiffSplit(DEFAULT_DIFF_SPLIT)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setDiffSplit(clampDiffSplit(
                      diffSplit + (event.key === "ArrowLeft" ? -2 : 2)));
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    resizerDragged.current = false;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resizeDiffColumns(event.clientX);
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      resizerDragged.current = true;
                      resizeDiffColumns(event.clientX);
                    }
                  }}
                  onPointerUp={(event) =>
                    event.currentTarget.releasePointerCapture(event.pointerId)}
                  onClick={(event) => {
                    // 把手压在行中心(MFC-034):真拖动过的收尾 click 不外
                    // 泄,原地单击则放行给批注层按坐标落到底下那一行。
                    if (resizerDragged.current) {
                      resizerDragged.current = false;
                      event.stopPropagation();
                    }
                  }}>
                  <span aria-hidden />
                </div>}
              </div>
            </div>
          )}
        </section>
      </div>
      ) : (
        <section className={GIT.overview} aria-label="变更文件概览">
          <div className={GIT.overviewIntro}>
            <span className={GIT.overviewIcon} aria-hidden>
              <svg viewBox="0 0 20 20" className="size-[17px] fill-none stroke-current stroke-[1.35]"><path d="M6 3.5H3.5V6M14 3.5h2.5V6M6 16.5H3.5V14M14 16.5h2.5V14M7 7h6v6H7z" /></svg>
            </span>
            <div className={GIT.overviewCopy}>
              <strong className={GIT.overviewTitle}>选择文件查看代码差异</strong>
              <span className={GIT.overviewNote}>点击文件查看逐行变化，支持上下对比与批注。</span>
            </div>
          </div>
          {renderTree(true)}
        </section>
      )}
      {pathTip && createPortal(
        <div className="change-path-tooltip" role="tooltip"
          style={{ left: pathTip.left, top: pathTip.top }}>
          {pathTip.path}
        </div>,
        document.body,
      )}
    </section>
  );
}
