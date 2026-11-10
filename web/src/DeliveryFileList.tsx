import { useMemo, useState } from "react";
import type { DeliveryFile, PushFileList } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export function deliveryFileGroups(files: readonly DeliveryFile[], query = "") {
  const groups = new Map<string, DeliveryFile[]>();
  for (const file of files) {
    if (query && !`${file.path} ${file.previous ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) continue;
    const name = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "仓库根目录";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(file);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/** 目录开合和搜索只影响阅读，不生成文件选择，也不向决定接口发送路径。 */
export function DeliveryFileList({ files, manifest }: { files: readonly DeliveryFile[]; manifest?: PushFileList }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => deliveryFileGroups(files, query), [files, query]);
  const allGroups = useMemo(() => deliveryFileGroups(files), [files]);
  const [opened, setOpened] = useState(() => new Set(files.length <= 30 ? allGroups.map(([name]) => name) : []));
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const file of files) result.set(file.label, (result.get(file.label) ?? 0) + 1);
    return [...result].map(([label, count]) => `${label} ${count}`).join(" · ");
  }, [files]);
  return <section className="delivery-file-list" aria-label="本次推送清单">
    <header><strong>本次推送清单</strong><span>{files.length} 个文件</span></header>
    {manifest && <p>{manifest.branch} · {manifest.comparison === "target_branch" ? "首次推送，相对目标分支" : "相对远端任务分支"}
      {manifest.base_sha && <><br /><code>{manifest.base_sha.slice(0, 8)} → {manifest.head_sha.slice(0, 8)}</code></>}</p>}
    <p>{counts || "当前没有文件变化"}</p>
    <div className="delivery-file-tools">
      <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件名或目录" aria-label="搜索交付文件" />
      <Button type="button" variant="ghost" size="xs" onClick={() => setOpened(new Set(allGroups.map(([name]) => name)))}>展开全部</Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => { setQuery(""); setOpened(new Set()); }}>折叠全部</Button>
    </div>
    {query && <p role="status">找到 {groups.reduce((count, [, items]) => count + items.length, 0)} / {files.length} 个文件</p>}
    <div className="delivery-file-directories">
      {groups.map(([name, items]) => {
        const open = !!query || opened.has(name);
        return <details key={name} open={open} onToggle={event => {
          if (query) return;
          const next = event.currentTarget.open;
          setOpened(previous => {
            if (previous.has(name) === next) return previous;
            const updated = new Set(previous); if (next) updated.add(name); else updated.delete(name); return updated;
          });
        }}>
          <summary><span>{name}</span><small>{items.length} 个文件</small></summary>
          {open && <ul>{items.map(file => <li key={file.path} title={file.path}>
            <span className="delivery-file-name">{file.path.split("/").at(-1)}
              {file.previous && <small>原路径：{file.previous}</small>}</span>
            <span className="delivery-file-change" data-change={file.label}>{file.label}</span>
          </li>)}</ul>}
        </details>;
      })}
    </div>
    <p>需要调整，直接在回复中说明要移除、补充或修改的文件。</p>
  </section>;
}
