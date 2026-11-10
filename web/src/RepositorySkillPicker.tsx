import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  scanRepositorySkills,
  type RepositorySkillCatalog,
  type SelectedRepositorySkill,
} from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/Alert";
import { Empty, EmptyDescription } from "@/components/Empty";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/** 与服务端 TaskService 的硬上限保持一致。页面先挡住，避免多仓全选后
 * 到“提交决定”才收到 400、让人回头猜该删哪些。 */
const MAX_SELECTED_SKILLS = 20;

/** launch 态卡片壳(#254):原 launch-form-section 的规则已随 #229 换装
 * 删除、类名却还在拼,卡片壳整块丢失。壳直译成 utilities,与
 * LaunchWorkspace 的 SECTION 词典同口径,launch-form-section 类退役。 */
const LAUNCH_SECTION =
  "min-w-0 rounded-lg border border-line px-[18px] pt-[17px] pb-[18px] bg-[color-mix(in_srgb,var(--surface-soft)_72%,var(--surface))]";

export interface RepositorySkillSelection {
  /** false = 从未成功读取，本次提交不得覆盖任务原有选择。 */
  scanned: boolean;
  scanning: boolean;
  catalogToken?: string;
  selectedIds: string[];
}

export const EMPTY_REPOSITORY_SKILL_SELECTION: RepositorySkillSelection = {
  scanned: false,
  scanning: false,
  selectedIds: [],
};

export interface RepositorySkillPickerState {
  catalog: RepositorySkillCatalog | null;
  selection: RepositorySkillSelection;
  scanError: string;
}

export const EMPTY_REPOSITORY_SKILL_PICKER_STATE: RepositorySkillPickerState = {
  catalog: null,
  selection: EMPTY_REPOSITORY_SKILL_SELECTION,
  scanError: "",
};

function repositoryLabel(repository: string): string {
  const tail = repository.replace(/\/+$/, "").split("/").pop() || repository;
  return tail.replace(/\.git$/i, "") || repository;
}

function resourceKey(repository: string, relativePath: string): string {
  return `${repository}\0${relativePath}`;
}

export function RepositorySkillPicker({
  repositories,
  baseline,
  initialSkills = [],
  onSelectionChange,
  presentation = "launch",
  state,
  onStateChange,
}: {
  repositories: string[];
  baseline?: string;
  /** Chain 检视时展示并沿用下单时已选项；重新读取后按仓+路径映射到
   * 新目录中的 id，仓库有新提交也不会仅因 revision 变化而悄悄丢选。 */
  initialSkills?: SelectedRepositorySkill[];
  onSelectionChange?: (selection: RepositorySkillSelection) => void;
  presentation?: "launch" | "decision";
  /** Chain 的“需要修改→再次检视”会暂时卸载决策卡；受控状态让已经
   * 读取的目录/token 留在 TaskWorkspace，不强迫用户下一轮重扫。 */
  state?: RepositorySkillPickerState;
  onStateChange?: Dispatch<SetStateAction<RepositorySkillPickerState>>;
}) {
  const normalizedRepositories = repositories
    .map((item) => item.trim()).filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
  const [internalState, setInternalState] = useState<RepositorySkillPickerState>(
    EMPTY_REPOSITORY_SKILL_PICKER_STATE,
  );
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );
  const pickerState = state ?? internalState;
  const setPickerState = onStateChange ?? setInternalState;
  const { catalog, selection, scanError } = pickerState;
  const scanVersion = useRef(0);
  const scanAbort = useRef<AbortController | null>(null);
  const selectedIds = new Set(selection.selectedIds);

  useEffect(() => {
    onSelectionChange?.(selection);
  }, [onSelectionChange, selection]);

  useEffect(() => () => {
    scanVersion.current += 1;
    scanAbort.current?.abort();
  }, []);

  function wantedSkills(): Set<string> {
    if (!catalog) {
      return new Set(initialSkills.map((skill) =>
        resourceKey(skill.repository, skill.relative_path)));
    }
    const wanted = new Set<string>();
    for (const repository of catalog.repositories) {
      for (const skill of repository.skills) {
        if (selectedIds.has(skill.id)) {
          wanted.add(resourceKey(repository.repository, skill.relative_path));
        }
      }
    }
    return wanted;
  }

  async function scanSkills() {
    if (!normalizedRepositories.length || selection.scanning) return;
    const preserve = wantedSkills();
    const firstScan = !catalog && initialSkills.length === 0;
    const version = ++scanVersion.current;
    scanAbort.current?.abort();
    const controller = new AbortController();
    scanAbort.current = controller;
    setPickerState({
      catalog: null,
      scanError: "",
      selection: {
        scanned: false,
        scanning: true,
        selectedIds: [],
      },
    });
    try {
      const result = await scanRepositorySkills(
        normalizedRepositories,
        baseline?.trim() || undefined,
        controller.signal,
      );
      if (scanVersion.current !== version) return;
      setExpandedSections(new Set(result.repositories.flatMap((repository) => [
        ...(repository.skills.length <= 4
          ? [`${repository.repository}\0skills`] : []),
      ])));
      const nextIds = result.repositories.flatMap((repository) =>
        repository.skills
          .filter((skill) => skill.selectable
            && (preserve.has(resourceKey(
              repository.repository, skill.relative_path))
              || (presentation === "launch" && firstScan)))
          .map((skill) => skill.id))
        .slice(0, MAX_SELECTED_SKILLS);
      setPickerState({
        catalog: result,
        scanError: "",
        selection: {
          scanned: true,
          scanning: false,
          catalogToken: result.catalog_token,
          selectedIds: nextIds,
        },
      });
    } catch (reason) {
      if (scanVersion.current !== version
          || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setPickerState({
        catalog: null,
        scanError: reason instanceof Error
          ? reason.message
          : "仓内能力读取失败，请稍后重试",
        selection: {
          scanned: false,
          scanning: false,
          selectedIds: [],
        },
      });
    } finally {
      if (scanVersion.current === version) scanAbort.current = null;
    }
  }

  function updateSelected(updater: (current: Set<string>) => Set<string>) {
    setPickerState((previous) => {
      const next = updater(new Set(previous.selection.selectedIds));
      return {
        ...previous,
        selection: {
          ...previous.selection,
          selectedIds: Array.from(next),
        },
      };
    });
  }

  function toggleSkill(skillId: string, on: boolean) {
    updateSelected((current) => {
      const next = new Set(current);
      if (on && next.size < MAX_SELECTED_SKILLS) next.add(skillId);
      else if (!on) next.delete(skillId);
      return next;
    });
  }

  function setRepositorySkills(skillIds: string[], on: boolean) {
    updateSelected((current) => {
      const next = new Set(current);
      for (const skillId of skillIds) {
        if (!on) next.delete(skillId);
        else if (next.size < MAX_SELECTED_SKILLS) next.add(skillId);
      }
      return next;
    });
  }

  const atLimit = selectedIds.size >= MAX_SELECTED_SKILLS;
  const initialNames = initialSkills.map((skill) => skill.name);
  const hasRepository = normalizedRepositories.length > 0;

  return (
    <section className={`${presentation === "launch" ? `${LAUNCH_SECTION} ` : ""}repository-skills-section repository-skills-${presentation}`}
      aria-labelledby={`repository-skills-title-${presentation}`}>
      <div className="repository-skills-head">
        <i aria-hidden>＋</i>
        <div>
          <strong id={`repository-skills-title-${presentation}`}>代码仓 Skill</strong>
          <small>{presentation === "decision"
            ? "按仓选择，确认后下发给对应交付子任务"
            : "扫描后默认勾选可用 Skill；可逐项取消，运行中留下消费足迹"}</small>
        </div>
        <em>{initialSkills.length > 0 && !catalog
          ? `当前 ${initialSkills.length} 项`
          : "默认选中 · 可调整"}</em>
      </div>

      <div className="repository-skills-toolbar">
        <p>
          这里只选择标准目录下的 Skill。首次扫描默认勾选全部可用项；
          Agent 先看名称和说明，相关时再读取 Skill 正文。
        </p>
        <div>
          {catalog && (
            <small className={atLimit ? "at-limit" : ""}>
              Skill {selectedIds.size}/{MAX_SELECTED_SKILLS}
            </small>
          )}
          <Button type="button" onClick={() => void scanSkills()}
            disabled={selection.scanning || !hasRepository}>
            {selection.scanning
              ? "正在读取…"
              : catalog || scanError
                ? "重新读取"
                : "读取 Skill"}
          </Button>
        </div>
      </div>

      {!hasRepository && (
        <Empty className="mt-3 border">
          <EmptyDescription>先填写代码仓，再读取仓内 Skill；读取成功后默认勾选，不读取也可继续。</EmptyDescription>
        </Empty>
      )}
      {!catalog && !scanError
        && initialNames.length > 0 && (
        <div className="repository-skills-current">
          <strong>将沿用发起任务时的选择</strong>
          <span>{initialNames.join("、")}</span>
          <small>不重新读取就保持不变；读取后可按仓调整 Skill。</small>
        </div>
      )}
      {scanError && (
        <Alert variant="destructive" role="alert" className="mt-3">
          <AlertTitle>本次读取未完成</AlertTitle>
          <AlertDescription>
            {scanError}
            <span className="block text-muted-foreground">你可以重试，也可以不改已有选择直接提交决定。</span>
          </AlertDescription>
        </Alert>
      )}
      {catalog && catalog.repositories.length === 0 && (
        <Empty className="mt-3 border">
          <EmptyDescription>这些仓库没有可用的 Skill，不影响继续提交；Agent 仍会正常探索代码仓。</EmptyDescription>
        </Empty>
      )}
      {catalog && catalog.repositories.length > 0 && (
        <div className="repository-skill-groups">
          {catalog.repositories.map((repository, repositoryIndex) => {
            const selectableIds = repository.skills
              .filter((skill) => skill.selectable)
              .map((skill) => skill.id);
            const allSelected = selectableIds.length > 0
              && selectableIds.every((skillId) => selectedIds.has(skillId));
            const selectedCount = selectableIds.filter(
              (skillId) => selectedIds.has(skillId)).length;
            return (
              <article className="repository-skill-group"
                key={`${repository.repository}-${repositoryIndex}`}>
                <header>
                  <div>
                    <strong title={repository.repository}>
                      {repositoryLabel(repository.repository)}
                    </strong>
                    <span title={repository.repository}>{repository.repository}</span>
                  </div>
                  {repository.revision && (
                    <code title={`版本 ${repository.revision}`}>
                      {repository.revision.length > 12
                        ? repository.revision.slice(0, 12)
                        : repository.revision}
                    </code>
                  )}
                  {selectableIds.length > 0 && (
                    <div className="repository-skill-actions">
                      <small>{selectedCount}/{selectableIds.length}</small>
                      <Button type="button" variant="outline" size="xs"
                        className="border-line bg-surface text-(--accent) hover:border-(--accent) hover:bg-(--accent-soft) hover:text-(--accent) disabled:bg-transparent disabled:text-faint"
                        disabled={allSelected || (atLimit && selectedCount < selectableIds.length)}
                        onClick={() => setRepositorySkills(selectableIds, true)}>
                        全选本仓
                      </Button>
                      <Button type="button" variant="outline" size="xs"
                        className="border-line bg-surface text-(--accent) hover:border-(--accent) hover:bg-(--accent-soft) hover:text-(--accent) disabled:bg-transparent disabled:text-faint"
                        disabled={selectedCount === 0}
                        onClick={() => setRepositorySkills(selectableIds, false)}>
                        清空
                      </Button>
                    </div>
                  )}
                </header>
                {repository.error && (
                  <div className="repository-skill-group-error">
                    {repository.error}；{presentation === "decision"
                      ? "本仓沿用原选择，可重新读取，也可继续确认。"
                      : "本仓不会加载仓内能力，可重新读取，也可继续发起。"}
                  </div>
                )}
                {!repository.error && repository.skills.length === 0 && (
                  <div className="repository-skill-none">
                    本仓未发现 Skill
                  </div>
                )}
                {repository.skills.length > 0 && (
                  <details className="repository-skill-block"
                    open={expandedSections.has(
                      `${repository.repository}\0skills`)}
                    onToggle={(event) => {
                      const key = `${repository.repository}\0skills`;
                      const open = event.currentTarget.open;
                      setExpandedSections((current) => {
                        if (current.has(key) === open) return current;
                        const next = new Set(current);
                        if (open) next.add(key); else next.delete(key);
                        return next;
                      });
                    }}>
                    <summary className="repository-resource-title">
                      <strong>Skills</strong>
                      <small>{repository.skills.length} 项 · Agent 按描述自主判断</small>
                    </summary>
                    <div className="repository-skill-list">
                    {repository.skills.map((skill) => {
                      const selected = selectedIds.has(skill.id);
                      const limitDisabled = atLimit && !selected;
                      const disabled = !skill.selectable || limitDisabled;
                      return (
                        <label key={skill.id}
                          className={`repository-skill-card${disabled ? " disabled" : ""}${
                            limitDisabled ? " limit-disabled" : ""}`}>
                          {/* base-ui Checkbox 自带隐藏 input:卡片的
                              :has(input:checked/:disabled:checked) 选中
                              皮仍由 CSS 命中。 */}
                          <Checkbox
                            checked={selected}
                            disabled={disabled}
                            onCheckedChange={(checked) => toggleSkill(
                              skill.id, checked)} />
                          <span className="repository-skill-copy">
                            <strong>{skill.name}</strong>
                            <span>{skill.description || "仓库未提供能力说明"}</span>
                            <code title={skill.relative_path}>{skill.relative_path}</code>
                            {!skill.selectable && skill.warning && (
                              <small>{skill.warning}</small>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
      {catalog && atLimit && (
        <div className="repository-skills-limit" role="status">
          每个任务最多启用 {MAX_SELECTED_SKILLS} 项；先清空部分已选项，才能选择其他 Skill。
        </div>
      )}
    </section>
  );
}
