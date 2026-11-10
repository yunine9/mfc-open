import { useEffect, useRef, useState } from "react";
import {
  resolveRepositoryProfiles,
  saveRepositoryProfile,
  type RepositoryProfile,
} from "./api";
import { KnowledgeLanguagePicker } from "./KnowledgeLanguages";
import { Alert } from "@/components/Alert";

export interface RepositoryTechnologyDraft {
  repository: string;
  technologies: string[];
  confirmed: boolean;
  remembered?: boolean;
}

function label(repository: string): string {
  return repository.replace(/\/+$/, "").split("/").at(-1)
    ?.replace(/\.git$/i, "") || repository;
}

function identity(repository: string): string {
  return repository.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
    .toLowerCase();
}

export function RepositoryTechnologyPicker({ repositories, value, onChange }: {
  repositories: string[];
  value: RepositoryTechnologyDraft[];
  onChange: (value: RepositoryTechnologyDraft[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [error, setError] = useState("");
  const normalized = repositories.map((item) => item.trim()).filter(Boolean);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!normalized.length) { onChange([]); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      setLoading(true); setError("");
      void resolveRepositoryProfiles(normalized).then((items) => {
        if (!alive) return;
        const local = new Map(valueRef.current.map((item) =>
          [identity(item.repository), item]));
        const resolved = new Map(items.map((item) =>
          [identity(item.repository), item]));
        onChange(normalized.map((repository) => {
          const current = local.get(identity(repository));
          const item = resolved.get(identity(repository));
          // 草稿代表“本单已经采用”的选择，优先级高于团队画像回填。
          // 特别是 remembered=false（保存失败）不能在重挂载后被抹掉。
          if (current) return {
            ...current,
            repository: item?.repository ?? repository,
            technologies: [...current.technologies],
            confirmed: current.technologies.length > 0,
          };
          return {
            repository: item?.repository ?? repository,
            technologies: item?.profile?.technologies ?? [],
            confirmed: (item?.profile?.technologies?.length ?? 0) > 0,
            remembered: !!item?.profile
              && (item.profile.technologies?.length ?? 0) > 0,
          };
        }));
      }).catch((reason) => {
        if (!alive) return;
        // 读不到历史记忆时仍可在本页完成当前选择；保存失败也不挡本单。
        setError(reason instanceof Error ? reason.message : "仓库技术画像读取失败");
        const local = new Map(valueRef.current.map((item) =>
          [identity(item.repository), item]));
        onChange(normalized.map((repository) => {
          const current = local.get(identity(repository));
          return current ? { ...current, repository,
            technologies: [...current.technologies], confirmed: current.technologies.length > 0 }
            : { repository, technologies: [], confirmed: false };
        }));
      }).finally(() => { if (alive) setLoading(false); });
    }, 350);
    return () => { alive = false; window.clearTimeout(timer); };
    // 仓库列表变化才重新解析；value 由用户编辑，不能触发回填覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(normalized)]);

  if (!normalized.length) return null;
  const choose = (item: RepositoryTechnologyDraft, technologies: string[]) => {
    const next = valueRef.current.map(current => current.repository === item.repository
      ? { ...current, technologies, confirmed: technologies.length > 0, remembered: false }
      : current);
    valueRef.current = next;
    onChange(next);
    setError("");
    // 选择立即用于本单；记忆串行保存，避免快速多选时旧请求覆盖新选择。
    if (!technologies.length) return;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await saveRepositoryProfile({ repository: item.repository, technologies, confirmed: true });
        if (!mounted.current) return;
        const current = valueRef.current.find(row => row.repository === item.repository);
        if (JSON.stringify(current?.technologies) !== JSON.stringify(technologies)) return;
        const remembered = valueRef.current.map(row => row.repository === item.repository
          ? { ...row, remembered: true } : row);
        valueRef.current = remembered;
        onChange(remembered);
      } catch {
        if (mounted.current) setError("技术栈记忆暂未保存；本单仍采用你刚选的结果，不影响发起任务。");
      }
    });
  };
  return <div className="repository-technology-picker">
    <div className="repository-technology-head">
      <span><strong>仓库技术栈</strong><small>
        选择即生效，无需再次确认；系统自动记住，用于匹配工程知识和 Skill。</small></span>
      <em className={value.length === normalized.length
          && value.every((item) => item.confirmed && item.technologies.length)
        ? undefined : "required"}>
        {loading ? "读取中…" : value.length === normalized.length
          && value.every((item) => item.confirmed && item.technologies.length)
          ? "已选择" : "请选择技术栈"}</em>
    </div>
    {error && <Alert variant="warning" role="status" className="mb-2">
      {error}</Alert>}
    <div className="repository-technology-list">
      {value.map((item) => <article key={item.repository}>
        <header><span><strong>{label(item.repository)}</strong>
          <small title={item.repository}>{item.repository}</small></span>
          {item.remembered && <em>系统已记住 · 可修改</em>}
          {!item.remembered && <em className="first">首次使用</em>}
        </header>
        <div className="repository-technology-first">
          <KnowledgeLanguagePicker value={item.technologies} includeAgnostic={false}
            onChange={(technologies) => choose(item, technologies)} />
          {!item.technologies.length && <small className="text-danger">请选择至少一种技术栈，才能发起任务；多语言仓可以多选。</small>}
        </div>
      </article>)}
    </div>
    <p className="repository-technology-note">
      每个代码仓至少选择一种技术栈。选择后立即生效，记忆保存不阻塞下单。</p>
  </div>;
}

export function asRepositoryProfiles(
  drafts: RepositoryTechnologyDraft[],
): Array<Pick<RepositoryProfile, "repository" | "technologies" | "confirmed">> {
  return drafts.filter((item) => item.confirmed && item.technologies.length)
    .map((item) => ({
    repository: item.repository,
    technologies: item.technologies,
    confirmed: true,
  }));
}
