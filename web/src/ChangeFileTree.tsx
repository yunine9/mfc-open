import { useEffect, useMemo, useRef, useState } from "react";
import { useTree } from "@headless-tree/react";
import { syncDataLoaderFeature, hotkeysCoreFeature, buildProxiedInstance } from "@headless-tree/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Folder, FileCode2, Search, ChevronsDownUp } from "lucide-react";
import { changeTree, compactDirectory, type ChangedFile, type ChangeDirectory } from "./gitDiffTree";

interface Node { name: string; path: string; children: string[]; paths: string[]; file?: ChangedFile }
export function fileTreeModel(files: readonly ChangedFile[]) {
  const nodes = new Map<string, Node>();
  function directory(dir: ChangeDirectory): string {
    const compact = compactDirectory(dir);
    const id = `dir:${compact.directory.path}`;
    const children = [...compact.directory.directories.map(directory), ...compact.directory.files.map(file)];
    nodes.set(id, { name: compact.label, path: compact.directory.path, children,
      paths: children.flatMap(key => nodes.get(key)!.paths) });
    return id;
  }
  function file(value: ChangedFile): string {
    const id = `file:${value.path}`;
    nodes.set(id, { name: value.path.split("/").at(-1)!, path: value.path,
      children: [], paths: [value.path], file: value });
    return id;
  }
  const tree = changeTree([...files]);
  const children = [...tree.directories.map(directory), ...tree.files.map(file)];
  nodes.set("root", { name: "变更文件", path: "", children, paths: files.map(f => f.path) });
  return nodes;
}

/** Headless Tree handles keyboard/focus; the virtual list bounds DOM size even with all folders expanded. */
export function ChangeFileTree({ files, activePath, onSelect }: {
  files: readonly ChangedFile[]; activePath?: string; onSelect(file: ChangedFile): void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => files.filter(file => file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [files, query]);
  const model = useMemo(() => fileTreeModel(filtered), [filtered]);
  const previousModel = useRef(model);
  const retiredModel = previousModel.current;
  useEffect(() => { previousModel.current = model; }, [model]);
  const [expandedItems, setExpandedItems] = useState<string[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const tree = useTree<Node>({
    rootItemId: "root", state: { expandedItems }, setExpandedItems,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => !item.getItemData().file,
    dataLoader: { getItem: id => model.get(id) ?? retiredModel.get(id) ?? { name: "", path: "", children: [], paths: [] }, getChildren: id => model.get(id)?.children ?? [] },
    onPrimaryAction: item => { const file = item.getItemData().file; if (file) onSelect(file); },
    features: [syncDataLoaderFeature, hotkeysCoreFeature], instanceBuilder: buildProxiedInstance,
  });
  useEffect(() => { tree.rebuildTree(); }, [model, tree]);
  useEffect(() => {
    if (query.trim()) setExpandedItems([...model.keys()].filter(key => key.startsWith("dir:")));
    else if (activePath) setExpandedItems(current => [...new Set([...current,
      ...[...model].filter(([id, node]) => id.startsWith("dir:") && node.paths.includes(activePath)).map(([id]) => id)])]);
  }, [query, activePath, [...model.keys()].join("\0")]);
  const items = tree.getItems().filter(item => model.has(item.getId()));
  const containerProps = tree.getContainerProps("变更文件目录");
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current,
    estimateSize: () => 38, overscan: 12, initialRect: { width: 320, height: 480 }, getItemKey: index => items[index].getId() });
  useEffect(() => {
    const index = items.findIndex(item => item.getItemData().file?.path === activePath);
    if (index >= 0) virtual.scrollToIndex(index, { align: "auto" });
  }, [activePath, expandedItems.join("\0")]);
  return <div className="change-tree-panel">
    <div className="change-tree-search"><Search size={16} /><input value={query}
      placeholder="搜索文件名或路径" aria-label="搜索变更文件" onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="清除文件搜索" onClick={() => setQuery("")}>×</button>}</div>
    <div className="change-tree-tools"><span>{filtered.length} 个文件</span>
      <button type="button" title={expandedItems.length ? "折叠全部目录" : "展开全部目录"}
        aria-label={expandedItems.length ? "折叠全部目录" : "展开全部目录"}
        onClick={() => setExpandedItems(expandedItems.length ? [] : [...model.keys()].filter(key => key.startsWith("dir:")))}><ChevronsDownUp size={15} /></button>
    </div>
    <div {...containerProps} className="change-tree-scroll" ref={element => {
      scroll.current = element;
      if (typeof containerProps.ref === "function") containerProps.ref(element);
      else if (containerProps.ref) containerProps.ref.current = element;
    }}>
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map(row => {
          const item = items[row.index]; const data = item.getItemData();
          const props = item.getProps();
          return <div {...props} key={item.getId()} className={`change-tree-item${data.file?.path === activePath ? " is-active" : ""}`}
            title={data.path} style={{ position: "absolute", top: row.start, height: row.size,
              paddingLeft: 8 + Math.min(item.getItemMeta().level, 6) * 14, width: "100%" }}>
            {!data.file ? <ChevronRight size={13} className={item.isExpanded() ? "is-expanded" : ""} /> : <span className="change-tree-spacer" />}
            {data.file ? <FileCode2 size={16} /> : <Folder size={16} className="change-folder-icon" />}
            <span className="change-tree-name">{data.name}</span>
            {data.file ? data.file.stats_status ? <span className="change-tree-count" title="尚未取得完整行数统计">{data.file.stats_status === "binary" ? "二进制" : "—"}</span> : <span className="change-tree-stats"><b>+{data.file.additions}</b><i>−{data.file.deletions}</i></span>
              : <span className="change-tree-count">{data.paths.length}</span>}
            {data.file && !["committed", "committed_working"].includes(data.file.stage) && <span className="change-local-dot" title="尚未提交的工作区改动" />}
          </div>;
        })}
      </div>
      {!filtered.length && <div className="change-tree-empty">{query ? "没有符合条件的文件" : "暂无文件变更"}</div>}
    </div>
  </div>;
}
