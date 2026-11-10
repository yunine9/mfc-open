/**
 * 拉取日志的数据面契约(#47 清单 + #267 整包下载,ADR-0026)。
 *
 * 三块钉死:
 * 1. listLogs 递归成扁平条目(path 相对、type 分目录文件、archive 按扩展
 *    名),条数/深度封顶如实标注 truncated——fetch-logs 抓的是完整目录
 *    结构,平铺清单对子目录无能为力;
 * 2. bundleSessionLogs 整包 ZIP:文件全收(路径即清单相对路径)、目录
 *    不进包、符号链接不进包;空/缺返回 undefined(路由据此 404);
 * 3. 真路由:materials 清单带递归 logs;logs/archive 出真 zip(下载名
 *    带 UTF-8 filename*),空目录 404 人话。
 *
 * (readLog/extractLog 及其路由已随「拉取日志」页签退役一并删除——
 * 在线阅读/解压不再是产品事实,日志的人读面只有整包下载,ADR-0026;
 * AI 读日志走自己的容器文件链路,不经这些接口。)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleSessionLogs,
  listLogs,
} from "../src/issueFlow/materials.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

const HAS_PYTHON = !!execFileSync("sh", ["-c", "command -v python3 || true"])
  .toString().trim();
const SKIP_PYTHON = !HAS_PYTHON
  && "宿主无 python3:zip 包内容无法现场核验(造包与读包都在测试侧)";

function stageDir(): string {
  return mfcTemp("mfc-issue-logs-");
}

function cleanup(...paths: string[]): void {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

/** python3 核验 zip 内容:列出全部成员名(读包端与造包端无关)。 */
function zipNames(zipPath: string): string[] {
  return execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    for name in z.namelist():
        print(name)
`, zipPath]).toString().split("\n").filter((line) => line !== "");
}

/** python3 读 zip 里一个成员的全文。 */
function zipRead(zipPath: string, name: string): string {
  return execFileSync("python3", ["-c", `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.stdout.write(z.read(sys.argv[2]).decode("utf-8"))
`, zipPath, name]).toString();
}

test("listLogs 递归多层目录:path 相对、type 分目录文件、archive 按扩展名", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc-a", "2026-08-30"), { recursive: true });
    writeFileSync(join(logs, "boot.log"), "top\n");
    writeFileSync(join(logs, "svc-a", "app.log"), "mid\n");
    writeFileSync(join(logs, "svc-a", "2026-08-30", "err.log"), "deep\n");
    writeFileSync(join(logs, "bundle.tar.gz"), "x");
    const listing = listLogs(root);
    assert.equal(listing.truncated, false);
    const byPath = new Map(listing.entries.map((e) => [e.path, e]));
    assert.equal(byPath.get("svc-a")?.type, "dir",
      "子目录本身要在清单里(组树/打包按它分层)");
    assert.equal(byPath.get("svc-a/2026-08-30")?.type, "dir");
    assert.equal(byPath.get("svc-a/2026-08-30/err.log")?.type, "file");
    assert.equal(byPath.get("svc-a/2026-08-30/err.log")?.archive, false);
    assert.equal(byPath.get("bundle.tar.gz")?.archive, true);
    // 五种档案扩展名全认,大小写不敏感。
    for (const name of ["a.zip", "b.tar", "c.tar.gz", "d.tgz", "e.TAR.BZ2"]) {
      writeFileSync(join(logs, name), "x");
    }
    const archives = listLogs(root).entries
      .filter((e) => e.archive).map((e) => e.path);
    for (const name of ["a.zip", "b.tar", "c.tar.gz", "d.tgz", "e.TAR.BZ2"]) {
      assert.ok(archives.includes(name), `${name} 应标 archive`);
    }
  } finally {
    cleanup(root);
  }
});

test("listLogs 符号链接一律跳过不跟随", () => {
  const root = stageDir();
  const outside = mfcTemp("mfc-issue-logs-out-");
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "real"), { recursive: true });
    writeFileSync(join(logs, "real", "ok.log"), "fine\n");
    writeFileSync(join(outside, "secret"), "x");
    execFileSync("ln", ["-s", outside, join(logs, "link-dir")]);
    execFileSync("ln", ["-s", "/etc/hostname", join(logs, "link-file")]);
    const paths = listLogs(root).entries.map((e) => e.path);
    assert.ok(paths.includes("real/ok.log"));
    assert.equal(paths.some((p) => p.startsWith("link-")), false,
      "链接本身也不进清单(chownTree 同款纪律:不跟随也不展示)");
  } finally {
    cleanup(root, outside);
  }
});

test("listLogs 条数封顶 2000,超限如实标注 truncated", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    mkdirSync(logs, { recursive: true });
    for (let i = 0; i < 2001; i++) {
      writeFileSync(join(logs, `log-${String(i).padStart(5, "0")}.txt`), "x");
    }
    const capped = listLogs(root);
    assert.equal(capped.entries.length, 2000, "清单条数封顶 2000");
    assert.equal(capped.truncated, true, "超限要如实标注");
  } finally {
    cleanup(root);
  }
});

test("listLogs 深度封顶:超深链不进清单,truncated 说话", () => {
  const root = stageDir();
  try {
    const logs = join(root, "local-logs");
    let deep = logs;
    for (let i = 0; i < 25; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "bottom.txt"), "x");
    writeFileSync(join(logs, "top.txt"), "x");
    const listing = listLogs(root);
    assert.equal(listing.truncated, true, "撞深度帽要标注");
    assert.equal(listing.entries.some((e) => e.path.includes("bottom")), false,
      "超过深度帽的条目不出现");
    assert.ok(listing.entries.some((e) => e.path === "top.txt"),
      "帽内条目照常在列");
  } finally {
    cleanup(root);
  }
});

test("bundleSessionLogs 整包:文件全收、目录不进包、符号链接不进包", () => {
  const root = stageDir();
  const outside = mfcTemp("mfc-issue-logs-out-");
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc", "nested"), { recursive: true });
    writeFileSync(join(logs, "boot.log"), "top-line\n");
    writeFileSync(join(logs, "svc", "nested", "app.log"), "deep-line\n");
    writeFileSync(join(outside, "secret"), "pwned\n");
    execFileSync("ln", ["-s", outside, join(logs, "link-file")]);
    const archive = bundleSessionLogs(root);
    assert.ok(archive, "有文件时必须出包");
    assert.ok(archive.data.length > 4);
    assert.equal(archive.files, 2, "目录与符号链接都不进包");
    // 包内容用真 zip 读回验证(与打包端解耦,读包端在测试侧)。
    const zipPath = join(root, "check.zip");
    writeFileSync(zipPath, archive.data);
    const names = zipNames(zipPath);
    assert.ok(names.includes("boot.log"));
    assert.ok(names.includes("svc/nested/app.log"), "子目录按相对路径进包");
    assert.equal(zipRead(zipPath, "svc/nested/app.log"), "deep-line\n");
    assert.equal(names.some((n) => n.includes("link")), false,
      "符号链接不进包(不跟随、不落内容)");
  } finally {
    cleanup(root, outside);
  }
});

test("bundleSessionLogs 空目录/无文件给 undefined(路由据此 404)", () => {
  const root = stageDir();
  try {
    assert.equal(bundleSessionLogs(root), undefined, "local-logs 不存在");
    mkdirSync(join(root, "local-logs"), { recursive: true });
    assert.equal(bundleSessionLogs(root), undefined, "目录存在但没有文件");
    // 只有空目录条目也算无文件。
    mkdirSync(join(root, "local-logs", "empty"), { recursive: true });
    assert.equal(bundleSessionLogs(root), undefined);
  } finally {
    cleanup(root);
  }
});

// ---- 真路由(GET materials / GET logs/archive):手搓请求对象,不养 HTTP 服务器 ----

interface RawResponse {
  status: number;
  headers: Record<string, unknown>;
  body: Record<string, any> | Buffer;
}

function issueCall(
  method: "GET" | "POST",
  parts: string[],
  options: { service: IssueFlowService; payload?: unknown; url?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = method === "GET"
      ? ({ method, url: options.url } as any)
      : (new EventEmitter() as any);
    request.method = method;
    let status = 0;
    let headers: Record<string, unknown> = {};
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number, head?: Record<string, unknown>) => {
          status = code;
          headers = head ?? {};
        },
        end: (output?: string | Buffer) => {
          try {
            const raw = Buffer.isBuffer(output)
              ? output : Buffer.from(String(output ?? "{}"));
            let body: Record<string, any> | Buffer;
            try {
              body = JSON.parse(raw.toString("utf-8")) as Record<string, any>;
            } catch {
              body = raw;
            }
            resolve({ status, headers, body });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: options.service, authEnabled: false },
    ).catch(reject);
    if (method !== "GET") {
      request.emit("data", Buffer.from(JSON.stringify(options.payload ?? {})));
      request.emit("end");
    }
  });
}

/** 摆一个挂起会话(材料路由的前置),返回会话工作区根。 */
function seedSessionWithLogs(dataDir: string): string {
  const id = "issue-logs";
  const root = join(dataDir, "issues", id);
  mkdirSync(join(root, "local-logs"), { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev",
    created_at: "2026-08-31T08:00:00Z", updated_at: "2026-08-31T09:00:00Z",
    title: "t", description: "", source: "manual",
    scenario: "no_ticket",
    status: "idle", stage: "conclude", stage_note: "",
    stage_at: "2026-08-31T09:00:00Z",
  }));
  return root;
}

test("路由:materials 清单带递归 logs", async () => {
  const dataDir = mfcTemp("mfc-issue-logs-route-");
  const root = seedSessionWithLogs(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const logs = join(root, "local-logs");
    mkdirSync(join(logs, "svc"), { recursive: true });
    writeFileSync(join(logs, "svc", "app.log"), "deep-log\n");
    const materials = await issueCall("GET", ["issues", "issue-logs", "materials"],
      { service, url: "/issues/issue-logs/materials" });
    assert.equal(materials.status, 200);
    assert.ok((materials.body as Record<string, any>).logs.entries
      .some((e: { path: string }) => e.path === "svc/app.log"),
      "递归清单要含子目录文件");
  } finally {
    await service.shutdown().catch(() => undefined);
    cleanup(dataDir);
  }
});

test("路由:logs/archive 整包出真 zip(UTF-8 下载名);空目录 404 人话",
  { skip: SKIP_PYTHON }, async () => {
    const dataDir = mfcTemp("mfc-issue-logs-archive-");
    const root = seedSessionWithLogs(dataDir);
    const service = new IssueFlowService({
      dataDir, provider: "p", model: "m", modelsJson: {},
    });
    try {
      // 空/缺:404 带人话(按钮本就不渲染,防的是 API 直调拿空包)。
      const missing = await issueCall("GET",
        ["issues", "issue-logs", "materials", "logs", "archive"], { service });
      assert.equal(missing.status, 404);
      assert.match((missing.body as Record<string, any>).error, /还没有拉取过日志/);

      const logs = join(root, "local-logs");
      mkdirSync(join(logs, "svc"), { recursive: true });
      writeFileSync(join(logs, "boot.log"), "top-line\n");
      writeFileSync(join(logs, "svc", "app.log"), "deep-log\n");
      const archive = await issueCall("GET",
        ["issues", "issue-logs", "materials", "logs", "archive"], { service });
      assert.equal(archive.status, 200);
      assert.equal(archive.headers["content-type"], "application/zip");
      assert.match(String(archive.headers["content-disposition"] ?? ""),
        /filename\*=UTF-8''/, "下载名带 UTF-8 形态(中文文件名不靠侥幸)");
      const zip = archive.body as Buffer;
      assert.ok(zip.length > 4);
      // 包内容用真 zip 读回验证(与打包端解耦,读包端在测试侧)。
      const zipPath = join(dataDir, "check.zip");
      writeFileSync(zipPath, zip);
      const names = zipNames(zipPath);
      assert.ok(names.includes("boot.log"));
      assert.ok(names.includes("svc/app.log"));
      assert.equal(zipRead(zipPath, "svc/app.log"), "deep-log\n");
    } finally {
      await service.shutdown().catch(() => undefined);
      cleanup(dataDir);
    }
  });
