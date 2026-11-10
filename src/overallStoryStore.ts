import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const OVERALL_STORY_ARTIFACT = "task-materials/overall-story.md";
export interface StorySource {
  id: string; task_id?: string; name: string; artifact?: string;
  sha256?: string; missing?: string; input_file?: string;
}
export interface StorySnapshot { fingerprint: string; sources: StorySource[] }
export interface StoryRevision extends StorySnapshot {
  id: string; at: string; by: string; additions: number; deletions: number;
  annotation_ids: string[];
}
export interface StoryState {
  current?: string;
  revisions: StoryRevision[];
  confirmed?: { revision: string; by: string; at: string };
  job?: { id: string; started_at: string; by: string; kind?: "architecture"; progress?: string };
  error?: string;
  /** 失败归属必须跟错误一起持久化，避免架构图错误散落到 Story 等无关界面。 */
  error_kind?: "story" | "architecture";
}
export const storyHash = (content: string) => createHash("sha256").update(content).digest("hex");

/** 正本是不可变修订，state.json 是唯一发布指针。失败副本不会覆盖人正在看的文档。 */
export function storyPath(workspace: string, file: string): string {
  const root = realpathSync(workspace);
  const target = join(root, "overall-story", file);
  const rel = relative(root, target);
  if (rel.startsWith("..") || !rel) throw new Error("非法 Story 路径");
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink()
      || !realpathSync(cursor).startsWith(root + sep))) throw new Error("Story 路径越界");
  }
  return target;
}
export function readStoryState(workspace: string): StoryState {
  const path = storyPath(workspace, "state.json");
  if (!existsSync(path)) return { revisions: [] };
  return JSON.parse(readFileSync(path, "utf8")) as StoryState;
}
export function writeStoryState(workspace: string, state: StoryState): void {
  const path = storyPath(workspace, "state.json");
  mkdirSync(storyPath(workspace, ""), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
export function storyRevisionPath(workspace: string, id: string, file = "story.md"): string {
  if (!/^[\da-f-]{36}$/.test(id) || !["story.md", "architecture.json", "diff.patch"].includes(file)) throw new Error("非法 Story 修订");
  return storyPath(workspace, `revisions/${id}/${file}`);
}
export function currentStoryFile(workspace: string): string | undefined {
  const state = readStoryState(workspace);
  return state.current && state.revisions.some((r) => r.id === state.current)
    ? storyRevisionPath(workspace, state.current) : undefined;
}
export function readCurrentStory(workspace: string): string {
  const path = currentStoryFile(workspace);
  return path ? readFileSync(path, "utf8") : "";
}
export function readCurrentStoryArchitecture(workspace: string, story = readCurrentStory(workspace)): string | undefined {
  const updated = storyPath(workspace, "architecture.json");
  if (existsSync(updated)) {
    try {
      const value = readFileSync(updated, "utf8");
      if (JSON.parse(value).story_sha256 === storyHash(story)) return value;
    } catch { /* 不采用损坏或已过期的图源，继续读取随 Story 发布的图。 */ }
  }
  const state = readStoryState(workspace);
  if (!state.current || !state.revisions.some((item) => item.id === state.current)) return undefined;
  const path = storyRevisionPath(workspace, state.current, "architecture.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
