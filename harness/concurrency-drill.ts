/**
 * 真模型 + 真容器的并发实战演练。
 *
 * 单测里的假容器证明不了并发下的真东西:三个任务同时起容器会不会撞名、
 * 会不会互相清掉、审批期释放的容器答复后能不能原地开回来。这个脚本用
 * 真 GLM、真 Docker、真 TaskService 跑一遍,判据全部落在**宿主能自己
 * 看见的事实**上(容器名、docker ps 残留、工作区文件、uname 输出),
 * 不信模型自述。
 *
 *   npx tsx harness/concurrency-drill.ts --image mae-flow-task-builder:dev
 *
 * 现场留在 $HOME/.cache/mae-flow-cloud-tests/ 下(不删现场是纪律);
 * macOS 的 docker VM 只挂 $HOME,放系统临时目录会挂成空目录(实测)。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync }
  from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { acquireInstanceLock } from "../src/instanceLock.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? fallback) : fallback;
}

const project = resolve(import.meta.dirname, "..");
const modelsPath = resolve(flag("--models", join(project, ".local/models.json")));
const providerName = flag("--provider", "glm");
const modelName = flag("--model", "glm-5.1");
const image = flag("--image", "mae-flow-task-builder:dev");
const timeoutMs = Number(flag("--timeout-min", "12")) * 60_000;

const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
if (!modelsJson.providers?.[providerName]) {
  throw new Error(`模型配置里找不到 provider ${providerName}`);
}

const scratch = join(homedir(), ".cache", "mae-flow-cloud-tests");
mkdirSync(scratch, { recursive: true });
const dataDir = mkdtempSync(join(scratch, "concurrency-drill-"));
chmodSync(dataDir, 0o700);

/** 只认宿主能自己核实的事实。 */
const facts: Array<{ ok: boolean; what: string; detail?: string }> = [];
const check = (ok: boolean, what: string, detail?: string) => {
  facts.push({ ok, what, detail });
  console.log(`${ok ? "✅" : "❌"} ${what}${detail ? ` — ${detail}` : ""}`);
};

function dockerNames(): string[] {
  try {
    return execFileSync("docker", [
      "ps", "-a", "--format", "{{.Names}}",
      "--filter", "label=com.mae-flow-cloud.managed=true",
    ], { encoding: "utf-8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// 三条需求都要求"把证据写进工作区文件"——收口后宿主直接读文件对账,
// 不看模型说了什么。第三条故意逼出一张审批卡,用来验释放/重开。
const MISSIONS = [
  { file: "proof-a.txt",
    text: "在当前目录执行 `uname -s -m` 和 `id -u`，把两条命令的原始输出"
      + "一起写进 proof-a.txt（一行一条，不要加解释）。写完就结束，不要提问。" },
  { file: "proof-b.txt",
    text: "在当前目录执行 `uname -s -m` 和 `id -u`，把两条命令的原始输出"
      + "一起写进 proof-b.txt（一行一条，不要加解释）。写完就结束，不要提问。" },
  { file: "proof-c.txt",
    text: "这一单分两步。第一步：先用 AskUserQuestion 问我一个问题——"
      + "「proof-c.txt 里写 uname 还是写 hostname？」，选项给「uname」和「hostname」。"
      + "拿到答复之前什么都不要做。第二步：按我选的那条命令在当前目录执行，"
      + "把原始输出写进 proof-c.txt，然后结束。",
    expectsCard: true },
];

const lock = acquireInstanceLock(dataDir);
const service = new TaskService({
  dataDir,
  provider: providerName,
  model: modelName,
  modelsJson,
  // 并发就是这次要验的东西:三条一起跑,不排队。
  maxConcurrent: 3,
  isolation: { image, cacheRoot: join(dataDir, "build-cache") },
  log: (message) => console.log(`  [task] ${message}`),
});

console.log(`[drill] 真模型 ${providerName}/${modelName},镜像 ${image}`);
console.log(`[drill] 现场: ${dataDir}`);

const before = dockerNames();
const created = MISSIONS.map((mission) => service.create(mission.text));
console.log(`[drill] 并发发起 ${created.length} 单: `
  + created.map((task) => task.id).join(", "));

const containerNames = new Set<string>();
const answered = new Set<string>();
const deadline = Date.now() + timeoutMs;
let peak = 0;

for (;;) {
  await new Promise((tick) => setTimeout(tick, 1000));
  const live = dockerNames().filter((name) => !before.includes(name));
  live.forEach((name) => containerNames.add(name));
  peak = Math.max(peak, live.length);

  for (const task of created) {
    const now = service.get(task.id);
    if (now?.status !== "waiting_for_human" || !now.waiting) continue;
    if (answered.has(now.waiting.waiting_id)) continue;
    answered.add(now.waiting.waiting_id);
    const questions = ((now.waiting.question as any)?.questions ?? []) as Array<{
      question: string; options: string[];
    }>;
    console.log(`\n[drill] ${task.id} 举卡: `
      + questions.map((item) => item.question).join(" / "));
    // 审批期容器应当已经被释放。这里当场取证,不靠日志措辞。
    // 容器名形如 mfc-<实例指纹前缀>-<任务号>,按后缀认本单的那个。
    const during = dockerNames().filter((name) =>
      name.endsWith(`-${task.id}`) && !before.includes(name));
    check(during.length === 0,
      `${task.id} 等人期间容器已释放`,
      during.length ? `仍在: ${during.join(",")}` : "docker ps 无该任务容器");
    const answers: Record<string, string> = {};
    for (const item of questions) {
      answers[item.question] = item.options?.[0] ?? "uname";
    }
    await service.decide(task.id, {
      state_version: now.waiting.state_version,
      answers,
      notes: "并发演练代答",
    });
    console.log(`[drill] ${task.id} 已代答: ${JSON.stringify(answers)}`);
  }

  const states = created.map((task) => service.get(task.id)!);
  if (states.every((task) =>
      ["completed", "failed", "canceled"].includes(task.status))) {
    break;
  }
  if (Date.now() > deadline) {
    console.log("\n[drill] ⏱ 超时预算耗尽");
    break;
  }
}

console.log("");
const finals = created.map((task) => service.get(task.id)!);
finals.forEach((task, index) => {
  check(task.status === "completed", `${task.id} 收口 completed`,
    `${task.status}${task.detail ? ` — ${task.detail}` : ""}`);
  const proof = join(task.workspace, MISSIONS[index].file);
  const exists = existsSync(proof);
  const body = exists ? readFileSync(proof, "utf-8").trim() : "";
  check(exists && body.length > 0,
    `${task.id} 产物宿主可见 (${MISSIONS[index].file})`,
    exists ? body.replace(/\n/g, " ⏎ ") : "文件不存在");
  if (index < 2) {
    // 宿主是 Darwin,产物里必须是 Linux——命令真的在容器里跑过。
    check(/Linux/i.test(body), `${task.id} 命令确在 Linux 容器内执行`,
      `宿主 ${process.platform}`);
    // uid 也要对得上本平台策略:macOS 沿用镜像 builder(10001)。
    check(/\b10001\b/.test(body), `${task.id} 以镜像非 root 用户执行`,
      body.includes("10001") ? "id -u = 10001" : "uid 不是 10001");
  }
});

check(MISSIONS.filter((m) => m.expectsCard).length === answered.size,
  "举卡并代答的单数符合预期", `实际 ${answered.size} 张`);
check(containerNames.size >= created.length,
  "每单各有自己的容器,没有撞名复用",
  `观察到 ${containerNames.size} 个容器名: ${[...containerNames].join(", ")}`);
check(peak >= 2, "确实出现过并发容器", `同时在跑峰值 ${peak}`);

await service.shutdown();
const leftover = dockerNames().filter((name) => !before.includes(name));
check(leftover.length === 0, "收口后无残留容器",
  leftover.length ? leftover.join(", ") : "docker ps 干净");
lock.release();
check(!existsSync(join(dataDir, "instance.lock")), "实例锁已释放");

writeFileSync(join(dataDir, "drill-report.json"),
  JSON.stringify({ facts, peak, containers: [...containerNames] }, null, 2));
const failed = facts.filter((fact) => !fact.ok);
console.log(`\n[drill] ${facts.length - failed.length}/${facts.length} 项事实通过`);
console.log(`[drill] 现场保留: ${dataDir}`);
process.exit(failed.length ? 1 : 0);
