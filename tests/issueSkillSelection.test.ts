/**
 * 业务仓 skill 取用(ADR-0014)的契约测试:圈选闸已封存——
 * - analyze 入口不举 skill_select 卡;扫描降级为留痕:发现清单/
 *   未发现/同名告警进转移账,现场可查当时有哪些 skill 可用;
 * - 扫描目录为 `.cac/skills` + `.agents/skills` 两根:`.cac` 同名
 *   优先,`.agents` 补位,同名跳过留告警;
 * - 存量挂起的圈选卡仍可作答(封存不删码):清单外 selection 拒绝、
 *   正式勾选落台账清闸;旧台账的必读清单仍随 analyze 开场词注入。
 *
 * 范式与 issueInterventionTiers.test.ts 同款:ScriptedModelServer 剧本,只走
 * 公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import {
  discoverBusinessSkillDirs,
  IssueFlowService,
} from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const SKILL_PATH = "repo/origin/.cac/skills/login-triage/SKILL.md";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端,`withSkill` 决定仓里有没有业务 skill。 */
function bareOrigin(root: string, withSkill: boolean): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  if (withSkill) {
    const skillDir = join(seed, ".cac", "skills", "login-triage");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"),
      "---\nname: login-triage\n"
      + "description: 登录链路五步排障:定位超时环节,核对会话与网关配置\n"
      + "---\n\n# 登录链路排障\n\n先复现,再分段计时。\n");
  }
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function baseOptions(dataDir: string, model: ScriptedModelServer) {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  };
}

/** 四章节合规的分析报告(门票校验过得了)。 */
const REPORT = "printf '# 问题分析\n\n登录超时系网关超时配置过小,方案:调大阈值。\n"
  + "## 问题现象\n登录超时。\n## 问题根因\n会话网关超时配置过小。\n"
  + "## 修改方案\n调大超时阈值。\n"
  + "## 置信度\n中:缺复现环境。\n' > issue-analysis.md";

/** 拉单→拉仓→收口进 analyze 的公共前半段;最后报告+提交走完分析。 */
function chainScenes(origin: string): Scene[] {
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "会话网关超时配置过小" } } },
    { text: "报告已提交。" },
  ];
}

async function runToAnalysisConfirm(origin: string, tier: "1" | "3") {
  const dataDir = mfcTemp("mfc-issue-skill-find-");
  const script = chainScenes(origin);
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => tier,
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    repoUrl: origin,
    baseline: "master",
  });
  const confirmed = await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user"
      && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
  }, "直达报告确认闸(中途无圈选卡)");
  return { dataDir, model, service, id: created.id, confirmed };
}

test("月光关+仓内有 skill:入口不举卡,扫描清单留痕转移账,直达报告确认", async () => {
  const dataDir = mfcTemp("mfc-issue-skill-note-");
  const origin = bareOrigin(dataDir, true);
  const { model, service, id, confirmed } =
    await runToAnalysisConfirm(origin, "3");
  try {
    // 全程没有 skill_select 卡:确认闸是第一张也是唯一一张等待卡。
    assert.equal(confirmed.gate?.kind, "analysis_confirm");
    assert.equal(confirmed.skill_selection ?? undefined, undefined,
      "封存后不再产生圈选台账");
    // 扫描留痕:发现清单(名字)进转移账——现场可查当时有哪些可用。
    const transitions = confirmed.transitions ?? [];
    assert.ok(
      transitions.some((entry) =>
        entry.note.includes("扫描到 1 个业务 skill(login-triage)")
        && entry.note.includes("ADR-0014")),
      "发现清单要进转移账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("存量挂起圈选卡仍可作答:清单外拒绝,正式勾选落台账清闸", async () => {
  const dataDir = mfcTemp("mfc-issue-skill-legacy-");
  const origin = bareOrigin(dataDir, true);
  const now = new Date().toISOString();
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  // 直接落一个"圈选卡挂起"的旧现场(ADR-0011 形态):封存后仍要能答。
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "in_progress"],
    status: "waiting_user", stage: "analyze", stage_note: "", stage_at: now,
    gate: {
      id: "gate-legacy-1", kind: "skill_select", state_version: 3,
      question: { questions: [{
        question: "进入问题分析:勾选要 AI 必读的仓内排障知识(可多选)",
        options: [{ code: "skip", label: "都不用,AI 按取用次序自主" }],
      }] },
      context: "以下是从已拉取的仓里扫描到的业务 skill。",
      skills: [{
        path: SKILL_PATH, repo: origin,
        name: "login-triage", description: "登录链路五步排障",
      }],
    },
  }));
  const script: Scene[] = [{ text: "继续分析。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const resumed = service.get("issue-1");
    assert.equal(resumed.status, "waiting_user");
    assert.equal(resumed.gate?.kind, "skill_select", "存量卡照常投影");

    // 清单外的 selection 一律拒绝:状态不动,闸仍在。
    assert.throws(
      () => service.answer("issue-1", {
        state_version: 3,
        selection: ["repo/origin/.cac/skills/evil/SKILL.md"],
      }),
      /清单之外/,
    );
    assert.equal(service.get("issue-1").gate?.kind, "skill_select");

    // 正式勾选:落台账、清闸、续跑(封存不删码,历史卡有始有终)。
    const answered = service.answer("issue-1", {
      state_version: 3,
      selection: [SKILL_PATH],
    });
    assert.equal(answered.gate ?? undefined, undefined, "作答即清闸");
    assert.equal(answered.skill_selection?.skills.length, 1);
    assert.equal(answered.skill_selection!.skills[0].path, SKILL_PATH);
    const transitions = (service.get("issue-1").transitions ?? []);
    assert.ok(transitions.some((entry) =>
      entry.note.includes("用户作答(skill_select)")));
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("提示层:存量台账的必读清单仍随 analyze 开场词注入", () => {
  const skill = {
    path: SKILL_PATH,
    repo: "http://example.com/origin.git",
    name: "login-triage",
    description: "登录链路五步排障",
  };
  const base = {
    id: "issue-1", scenario: "ticket",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
    skill_selection: { at: "2026-09-02T00:00:00Z", skills: [skill] },
  } as unknown as IssueSessionState;
  const analyze = { ...base, stage: "analyze" } as IssueSessionState;
  const prep = { ...base, stage: "prep_repo" } as IssueSessionState;
  const withSelection = issueFixedOpeningPrompt(analyze, {}, { tier: "3" });
  assert.match(withSelection, /必读 skill\(用户圈选,分析前先读;/);
  assert.match(withSelection, new RegExp(SKILL_PATH.replace(/[/.]/g, "\\$&")));
  assert.match(withSelection, /登录链路五步排障/);
  const noInjection = issueFixedOpeningPrompt(prep, {}, { tier: "3" });
  assert.doesNotMatch(noInjection, /必读 skill/, "非分析阶段不注入");
  const untouched = issueFixedOpeningPrompt(
    { ...base, stage: "analyze", skill_selection: undefined } as IssueSessionState,
    {}, { tier: "3" });
  assert.doesNotMatch(untouched, /必读 skill/, "未圈选不注入");
});

test("业务 skill 扫描分类层(2026-09-04):嵌套发现、包内不递归、根缺席零发现", () => {
  // discoverBusinessSkillDirs 是扫描的原语(公开导出供契约测试):
  // 目录直接含 SKILL.md 即技能,分类层只是组织;包原子,不进包内找。
  const root = mfcTemp("mfc-issue-skill-nest-");
  const skillsRoot = join(root, ".cac", "skills");
  const write = (rel: string) => {
    const dir = join(skillsRoot, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: ${rel.split("/").at(-1)}\ndescription: ${rel}\n---\n`);
  };
  write("engineering/login-triage");
  write("login-triage");
  // 技能包内部:templates 不是分类,里面的 SKILL.md 不单独立项。
  const inner = join(skillsRoot, "login-triage", "templates");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "SKILL.md"),
    "---\nname: inner\ndescription: 包内资源\n---\n");

  const found = discoverBusinessSkillDirs(skillsRoot)
    .map((dir) => dir.split(`${skillsRoot}/`)[1]).sort();
  assert.deepEqual(found,
    ["engineering/login-triage", "login-triage"],
    "两个含 SKILL.md 的目录都被发现(分类层+平铺);同名互斥由 "
      + "scanBusinessSkills 的 claim 层裁定,原语只管发现");
  assert.ok(!found.some((rel) => rel.includes("templates")),
    "技能包内部不递归(包是原子的)");
  assert.equal(discoverBusinessSkillDirs(join(root, "absent")).length, 0,
    "根缺席=零发现,不响(可选能力)");
});
