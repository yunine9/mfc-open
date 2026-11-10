/**
 * 团队 Skill 资产库(可写管理面)契约:
 * - 写路径 fail-closed:装载器不认/含疑似密钥/路径越界一律拒收且不落盘;
 * - 权限显式归一(0644/0755),不信上传时的 umask;
 * - 覆盖/下线先归档,回退重走完整验收;操作逐条留痕(操作人+指纹);
 * - 写进 skills/ 即被货架照见——与快照器读的是同一个源,下一单即生效。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import {
  SkillLibraryError,
  approveSkillSubmission,
  listSkillOperations,
  listSkillSubmissions,
  listSkillVersions,
  offlineHostSkill,
  readHostSkillDocument,
  rejectSkillSubmission,
  rollbackHostSkill,
  scanForSecrets,
  submitHostSkill,
  updateHostSkillKnowledgeMetadata,
  uploadHostSkill,
} from "../src/hostSkillLibrary.ts";
import { listHostSkillShelf } from "../src/hostSkillShelf.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { mfcTemp as unconfiguredTemp } from "./mfcTmp.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";

function mfcTemp(prefix: string): string {
  const dir = unconfiguredTemp(prefix);
  for (const name of ["Java", "C++", "JavaScript"]) createTechnologyStack(dir, { name }, "fixture");
  return dir;
}

const encode = (text: string) => Buffer.from(text, "utf-8").toString("base64");

function skillMd(description: string, body = "写单测先读我。"): string {
  return `---\nname: java-autout\ndescription: ${description}\nknowledge_nature: engineering\ntechnologies: [java]\n---\n\n${body}\n`;
}

const ENGINEERING_METADATA = {
  nature: "engineering" as const,
  business_module_ids: [], repositories: [], technologies: ["java"],
};

test("Skill 超过 20 次更新仍保留最早正文和附件，并可回退", async () => {
  const dataDir = mfcTemp("mfc-skill-history-");
  for (let version = 1; version <= 23; version++) {
    await uploadHostSkill(dataDir, "java-autout", [
      { path: "SKILL.md", content_base64: encode(skillMd(`单测写法 v${version}`)) },
      { path: "references/example.md", content_base64: encode(`UT 示例 v${version}`) },
    ], "maintainer", ENGINEERING_METADATA);
  }
  const versions = listSkillVersions(dataDir, "java-autout");
  assert.equal(versions.length, 22);
  const first = versions.find(version => readFileSync(join(dataDir, "skill-versions", "java-autout", version.version_id, "references/example.md"), "utf8") === "UT 示例 v1");
  assert.ok(first, "最早的示例附件不能因更新次数多而消失");
  await rollbackHostSkill(dataDir, "java-autout", first.version_id, "maintainer");
  assert.equal(readHostSkillDocument(dataDir, "java-autout").content, skillMd("单测写法 v1"));
  assert.equal(readFileSync(join(dataDir, "skills", "java-autout", "references/example.md"), "utf8"), "UT 示例 v1");
  assert.equal(listSkillVersions(dataDir, "java-autout").length, 23);
});

test("上传→货架可见且权限归一;更新归档旧版;回退按版本痕复原", async () => {
  const dataDir = mfcTemp("mfc-skill-lib-");
  await assert.rejects(uploadHostSkill(dataDir, "missing-tags", [
    { path: "SKILL.md", content_base64: encode(skillMd("缺少治理参数")) },
  ], "admin-a"), /必须设置知识性质与作用域标签/,
  "资产库写入口本身也必须强制分类，不能只靠页面校验");
  const first = await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("单测写法 v1")) },
    { path: "templates/case.md", content_base64: encode("三段命名模板\n") },
  ], "admin-a", ENGINEERING_METADATA);
  assert.equal(first.action, "upload");
  assert.equal(first.files, 2);

  const shelf = listHostSkillShelf(dataDir);
  assert.equal(shelf.skills.length, 1);
  assert.equal(shelf.skills[0].name, "java-autout");
  assert.equal(shelf.skills[0].loadable, true, "收进来的必须是装载器认的");
  assert.equal(shelf.skills[0].digest, first.skill_digest,
    "货架指纹与留痕指纹必须同源");
  const detail = readHostSkillDocument(dataDir, "java-autout");
  assert.equal(detail.content, skillMd("单测写法 v1"));
  assert.equal(detail.digest, first.skill_digest);
  assert.equal(detail.package_digest, first.package_digest,
    "正文详情必须带同一生效包的整包指纹");
  assert.equal(detail.path, "java-autout/SKILL.md");
  assert.throws(() => readHostSkillDocument(dataDir, "../escape"),
    SkillLibraryError, "查看入口与写入口共用目录边界");

  // 权限显式归一:文件 0644/目录 0755,不看上传时 umask 的脸色。
  const live = join(dataDir, "skills", "java-autout");
  assert.equal(statSync(join(live, "SKILL.md")).mode & 0o777, 0o644);
  assert.equal(statSync(join(live, "templates")).mode & 0o777, 0o755);

  const second = await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("单测写法 v2")) },
  ], "admin-b", ENGINEERING_METADATA);
  assert.equal(second.action, "update");
  const versions = listSkillVersions(dataDir, "java-autout");
  assert.equal(versions.length, 1, "覆盖必须先归档旧版");
  assert.equal(versions[0].skill_digest, first.skill_digest);
  assert.equal(versions[0].operator, "admin-b", "归档记的是动手的人");

  const restored = await rollbackHostSkill(
    dataDir, "java-autout", versions[0].version_id, "admin-a");
  assert.equal(restored.action, "rollback");
  assert.equal(restored.skill_digest, first.skill_digest, "回退=完整复原 v1");
  assert.ok(existsSync(join(dataDir, "skill-versions", "java-autout",
    versions[0].version_id)), "归档本体不动,回退是复制装回");
  assert.match(readFileSync(join(live, "SKILL.md"), "utf-8"), /v1/);
  // v2 被回退顶替时也要归档——任何生效过的版本都不允许凭空消失。
  assert.equal(listSkillVersions(dataDir, "java-autout").length, 2);

  const operations = listSkillOperations(dataDir);
  assert.deepEqual(operations.map((item) => item.action),
    ["rollback", "update", "upload"], "留痕逐条且新在前");
  assert.equal(operations[0].operator, "admin-a");
});

test("Skill 正文不变但附件变化时，详情整包指纹必须随当前包变化", async () => {
  const dataDir = mfcTemp("mfc-skill-detail-package-");
  const content = skillMd("整包对拍");
  const first = await uploadHostSkill(dataDir, "package-version", [
    { path: "SKILL.md", content_base64: encode(content) },
    { path: "references/check.md", content_base64: encode("附件 v1\n") },
  ], "admin-a", ENGINEERING_METADATA);
  const firstDetail = readHostSkillDocument(dataDir, "package-version");
  assert.equal(firstDetail.digest, first.skill_digest);
  assert.equal(firstDetail.package_digest, first.package_digest);

  const second = await uploadHostSkill(dataDir, "package-version", [
    { path: "SKILL.md", content_base64: encode(content) },
    { path: "references/check.md", content_base64: encode("附件 v2\n") },
  ], "admin-b", ENGINEERING_METADATA);
  const secondDetail = readHostSkillDocument(dataDir, "package-version");
  assert.equal(secondDetail.digest, firstDetail.digest,
    "只改附件时正文指纹应保持不变");
  assert.notEqual(secondDetail.package_digest, firstDetail.package_digest,
    "正文详情不能沿用旧货架的整包指纹");
  assert.equal(secondDetail.package_digest, second.package_digest,
    "详情响应必须描述当前完整生效包");
});

test("Skill 是知识形态；性质与模块/仓库/技术作用域分离且版本可回退", async () => {
  const dataDir = mfcTemp("mfc-skill-languages-");
  await uploadHostSkill(dataDir, "mixed-build", [
    { path: "SKILL.md", content_base64: encode(skillMd("混合仓构建")) },
    { path: "references/build.md", content_base64: encode("构建说明\n") },
  ], "admin-a", {
    nature: "engineering",
    business_module_ids: [],
    repositories: [],
    technologies: ["C++", "js"],
  });
  const engineering = listHostSkillShelf(dataDir).skills[0];
  assert.equal(engineering.nature, "engineering");
  assert.equal(engineering.form, "skill");
  assert.deepEqual(engineering.technologies,
    ["cpp", "javascript"]);
  assert.match(readHostSkillDocument(dataDir, "mixed-build").content,
    /technologies: \[cpp, javascript\]/,
    "技术作用域写进 Skill 包自身，提交审核、归档和回退共享元数据");

  await updateHostSkillKnowledgeMetadata(dataDir, "mixed-build", {
    nature: "engineering", business_module_ids: [], repositories: [],
    technologies: ["java"],
  }, "admin-b");
  assert.deepEqual(listHostSkillShelf(dataDir).skills[0].technologies, ["java"]);
  assert.ok(existsSync(join(dataDir, "skills", "mixed-build",
    "references", "build.md")), "只改语言不能丢掉包内配套文件");
  const old = listSkillVersions(dataDir, "mixed-build")[0];
  await rollbackHostSkill(
    dataDir, "mixed-build", old.version_id, "admin-a");
  assert.deepEqual(listHostSkillShelf(dataDir).skills[0].technologies,
    ["cpp", "javascript"]);

  createBusinessModule(dataDir, {
    id: "orders", name: "订单履约", description: "订单规则与履约流程",
    owner: "admin-a", repositories: ["https://code.example/orders.git"],
  }, "admin-a");
  await uploadHostSkill(dataDir, "order-rules", [
    { path: "SKILL.md", content_base64: encode(skillMd("订单规则")) },
  ], "admin-a", {
    nature: "business",
    business_module_ids: ["orders"],
    repositories: ["https://code.example/orders.git"],
    technologies: [],
  });
  const business = listHostSkillShelf(dataDir).skills.find((item) =>
    item.path.startsWith("order-rules/"));
  assert.equal(business?.nature, "business");
  assert.deepEqual(business?.business_module_ids, ["orders"]);
  assert.deepEqual(business?.technologies, []);

  await uploadHostSkill(dataDir, "coupled", [
    { path: "SKILL.md", content_base64: encode(skillMd("耦合件")) },
  ], "admin-a", {
    nature: "engineering",
    business_module_ids: ["orders"],
    repositories: ["https://code.example/orders.git"],
    technologies: ["java"],
  });
  const scoped = listHostSkillShelf(dataDir).skills.find((item) =>
    item.path.startsWith("coupled/"));
  assert.equal(scoped?.nature, "engineering",
    "工程知识可带业务模块上下文和具体仓库，不因此变成业务知识");
  await assert.rejects(uploadHostSkill(dataDir, "business-with-tech", [
    { path: "SKILL.md", content_base64: encode(skillMd("业务实现混写")) },
  ], "admin-a", {
    nature: "business", business_module_ids: ["orders"], repositories: [],
    technologies: ["java"],
  }), /业务知识不能标工程语言.*拆出一项工程知识/);
});

test("HTTP 头名常量允许整包上传，仍扫描后续凭据并保持错误掩码", async () => {
  const dataDir = mfcTemp("mfc-skill-header-");
  const headers = 'X_ACCESS_TOKEN = "x-access-token"\nAPI_KEY = "x-api-key"';
  await uploadHostSkill(dataDir, "header-guide", [{
    path: "SKILL.md", content_base64: encode(skillMd("请求头用法", headers)),
  }], "admin", ENGINEERING_METADATA);
  assert.ok(readHostSkillDocument(dataDir, "header-guide").content.includes(headers));
  const values = ["sk_live_abcd1234efgh", "x-access-token123", "X-ACCESS-TOKEN", "abcdefgh"];
  for (const value of values) {
    // 同一规则在放行头名称后不能停止；重复扫描不共享正则游标。
    for (let run = 0; run < 2; run++) {
      assert.throws(() => scanForSecrets("guide.md", Buffer.from(
        `${headers}\npassword = "${value}"`)),
      (error) => error instanceof SkillLibraryError
        && error.message.includes("guide.md:3") && !error.message.includes(value));
    }
  }
  assert.throws(() => scanForSecrets("guide.md", Buffer.from(
    `${headers}\nBearer abcdefghijklmnopqrst`)), /Bearer 凭据/);
  assert.throws(() => scanForSecrets("guide.md", Buffer.from(
    `${headers}\n-----BEGIN PRIVATE KEY-----`)), /私钥块/);
});

test("头名例外只匹配完整常量声明，不能放行形似头名的密码或值前缀", () => {
  for (const header of ['X_ACCESS_TOKEN = "x-access-token"',
    'const X_ACCESS_TOKEN = "X-Access-Token";', 'API_KEY = \'x-api-key\'',
    '{"X_API_KEY":"X-API-Key"}']) {
    assert.doesNotThrow(() => scanForSecrets("headers.md", Buffer.from(header)), header);
  }
  const secrets = ['password = "correct-horse-battery-staple"',
    'PASSWORD = "x-access-token"', 'secret = "x-api-key"',
    'api_key = "x-api-key"', 'OTHER_TOKEN = "x-access-token"',
    'X_ACCESS_TOKEN = "x-access-token$private"',
    'X_ACCESS_TOKEN = "x-access-token!private"',
    'X_ACCESS_TOKEN = "x-access-token" + privateSuffix',
    'X_ACCESS_TOKEN = "x-access-token""private"',
    'X_ACCESS_TOKEN = x-access-token'];
  for (const secret of secrets) {
    for (const text of [secret, `API_KEY = "x-api-key"\n${secret}`, `${secret}\nAPI_KEY = "x-api-key"`]) {
      assert.throws(() => scanForSecrets("mixed.md", Buffer.from(text)), SkillLibraryError, secret);
    }
  }
});

test("同名敏感属性引用可作为代码显示，字面量、拼接和不完整表达式仍拒绝", () => {
  const references = ["apiKey: args.apiKey,", "token: metadata.token,", "api_key = config.api_key;",
    "password: options.auth.password}", "98: apiKey: args.apiKey,"];
  for (const reference of references) {
    assert.doesNotThrow(() => scanForSecrets("code.md", Buffer.from(reference)), reference);
  }
  const rejected = ['apiKey: "args.apiKey",', "apiKey: 'args.apiKey',", '"apiKey": args.apiKey,',
    '"apiKey: args.apiKey,"', "'apiKey: args.apiKey,'", "`apiKey: args.apiKey,`",
    'const cfg = "user=demo, apiKey: args.apiKey,";',
    "const cfg = 'user=demo, apiKey: args.apiKey,';", "const cfg = `user=demo, apiKey: args.apiKey,`;",
    "const cfg = { apiKey: args.apiKey, };",
    "apiKey: args.apiKey+fixtureSuffix,", 'apiKey: args.apiKey + "fixture-suffix",',
    'apiKey: args.apiKey\n + "fixture-suffix",', "apiKey: args.apiKey$fixture,", "apiKey: args.apiKey.bad,",
    "apiKey: args.apiKeyValue,", "myapiKey: args.apiKey,", "apiKey: arbitraryVariable,",
    "apiKey: args.APIKEY,", "apiKey: args.apiKey", "apiKey: args.apiKey // unfinished",
    'apiKey: args.apiKey /* comment */ + "fixture-suffix",', '{"apiKey":"args.apiKey"}'];
  for (const content of rejected) {
    assert.throws(() => scanForSecrets("code.md", Buffer.from(content)), SkillLibraryError, content);
  }
  for (const content of ['password: "fixture-only-password",', "Bearer abcdefghijklmnopqrst", "-----BEGIN PRIVATE KEY-----"]) {
    assert.throws(() => scanForSecrets("code.md", Buffer.from(`${references.join("\n")}\n${content}`)), SkillLibraryError, content);
  }
});

test("真实Skill上传接受属性引用，后续密钥仍拒绝且不覆盖原包", async () => {
  const dataDir = mfcTemp("mfc-skill-property-reference-"), reference = "apiKey: args.apiKey,";
  await uploadHostSkill(dataDir, "property-guide", [{
    path: "SKILL.md", content_base64: encode(skillMd("代码配置引用", reference)),
  }], "admin", ENGINEERING_METADATA);
  const original = readHostSkillDocument(dataDir, "property-guide").content;
  for (const content of ['apiKey: "args.apiKey",', 'const cfg = "apiKey: args.apiKey,";',
    'apiKey: args.apiKey + "fixture-suffix",',
    `${reference}\npassword: "fixture-only-password",`]) {
    await assert.rejects(uploadHostSkill(dataDir, "property-guide", [{
      path: "SKILL.md", content_base64: encode(skillMd("代码配置引用", content)),
    }], "admin", ENGINEERING_METADATA), SkillLibraryError);
    assert.equal(readHostSkillDocument(dataDir, "property-guide").content, original);
  }
});

test("真实上传拒绝连字符口令，失败更新和待审提交均不留下可读凭据", async () => {
  const dataDir = mfcTemp("mfc-skill-secret-phrase-");
  const safe = skillMd("请求头", 'X_ACCESS_TOKEN = "x-access-token"');
  await uploadHostSkill(dataDir, "header-guide", [{path:"SKILL.md",content_base64:encode(safe)}], "admin", ENGINEERING_METADATA);
  const before = readHostSkillDocument(dataDir, "header-guide").content;
  const unsafe = [
    {path:"SKILL.md",content_base64:encode(safe)},
    {path:"references/config.md",content_base64:encode('password = "correct-horse-battery-staple"')},
  ];
  await assert.rejects(uploadHostSkill(dataDir, "header-guide", unsafe, "admin", ENGINEERING_METADATA), SkillLibraryError);
  assert.equal(readHostSkillDocument(dataDir, "header-guide").content, before);
  assert.equal(existsSync(join(dataDir,"skills","header-guide","references","config.md")),false);
  await assert.rejects(submitHostSkill(dataDir, "new-guide", unsafe, "member", ENGINEERING_METADATA), SkillLibraryError);
  assert.equal(listSkillSubmissions(dataDir).length,0);
});

test("fail-closed:密钥、密钥容器文件名、坏 frontmatter、路径越界都拒收且不落盘", async () => {
  const dataDir = mfcTemp("mfc-skill-guard-");
  const cases: Array<{ why: RegExp; files: Parameters<typeof uploadHostSkill>[2] }> = [
    {
      why: /密钥赋值|令牌/,
      files: [{ path: "SKILL.md", content_base64: encode(
        skillMd("带密钥", "api_key: sk_live_abcd1234efgh")) }],
    },
    {
      why: /密钥容器/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: "assets/deploy.pem", content_base64: encode("x") },
      ],
    },
    {
      why: /缺少 YAML frontmatter|装载器不接受/,
      files: [{ path: "SKILL.md", content_base64: encode("没有 frontmatter\n") }],
    },
    {
      why: /路径段不合法|路径不合法/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: "../escape.md", content_base64: encode("x") },
      ],
    },
    {
      why: /路径段不合法/,
      files: [
        { path: "SKILL.md", content_base64: encode(skillMd("好的")) },
        { path: ".env.local", content_base64: encode("x") },
      ],
    },
  ];
  for (const { why, files } of cases) {
    await assert.rejects(
      uploadHostSkill(
        dataDir, "guarded", files, "admin", ENGINEERING_METADATA),
      (error) => error instanceof SkillLibraryError && why.test(error.message),
      `该拒的没拒: ${why}`);
    assert.ok(!existsSync(join(dataDir, "skills", "guarded")),
      "拒收就一个字节都不许落进生效位");
  }
  // 密钥报错不许回显明文:掩码到末 4 位。
  await assert.rejects(
    uploadHostSkill(dataDir, "guarded", [
      { path: "SKILL.md", content_base64: encode(
        skillMd("带密钥", "token = ghp_secretsecretsecret")) },
    ], "admin", ENGINEERING_METADATA),
    (error) => error instanceof SkillLibraryError
      && error.message.includes("••••")
      && !error.message.includes("ghp_secretsecretsecret"));
  assert.ok(!existsSync(join(dataDir, "skill-staging"))
    || statSync(join(dataDir, "skill-staging")).isDirectory(),
    "暂存区允许存在但拒收后不留包");
  const shelf = listHostSkillShelf(dataDir);
  assert.equal(shelf.skills.length, 0);
  // 占位符写法必须放行——掩码扫描不能把"如何配置令牌"的教学也杀掉。
  const ok = await uploadHostSkill(dataDir, "guarded", [
    { path: "SKILL.md", content_base64: encode(
      skillMd("教学", "配置示例:api_key: <token>,不要写真值。")) },
  ], "admin", ENGINEERING_METADATA);
  assert.equal(ok.action, "upload");
});

test("下线归档可回退;不存在的下线与坏版本号回退明确报错", async () => {
  const dataDir = mfcTemp("mfc-skill-off-");
  await uploadHostSkill(dataDir, "review-notes", [
    { path: "SKILL.md", content_base64: encode(skillMd("检视笔记")) },
  ], "admin", ENGINEERING_METADATA);
  const off = await offlineHostSkill(dataDir, "review-notes", "admin");
  assert.equal(off.action, "offline");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 0,
    "下线即从货架消失(下一单不再装载)");
  const versions = listSkillVersions(dataDir, "review-notes");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].action, "offline");

  const back = await rollbackHostSkill(
    dataDir, "review-notes", versions[0].version_id, "admin");
  assert.equal(back.action, "rollback");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 1, "回退=重新上架");

  await assert.rejects(offlineHostSkill(dataDir, "ghost", "admin"),
    (error) => error instanceof SkillLibraryError
      && /没有这个生效中的/.test(error.message));
  await assert.rejects(
    rollbackHostSkill(dataDir, "review-notes", "../../etc", "admin"),
    (error) => error instanceof SkillLibraryError
      && /版本号不合法/.test(error.message));
});

test("B1验收1：Skill 提交审查是唯一上架入口，直传与旧语言动作退役", async () => {
  const dir = mfcTemp("mfc-skill-route-");
  const dataDir = join(dir, "data");
  for (const name of ["Java", "C++", "JavaScript"]) createTechnologyStack(dataDir, { name }, "fixture");
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("dev", "developer-pass-1", "developer");
  const service = new TaskService({
    dataDir, provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    assert.equal((await fetch(`${base}/skills`)).status, 401,
      "货架不是公开页,登录才可读");
    const dev = await login("dev", "developer-pass-1");
    const boss = await login("boss", "administrator-pass");
    const payload = JSON.stringify({
      nature: "engineering", business_module_ids: [], repositories: [],
      technologies: ["cpp"], files: [
      { path: "SKILL.md", content_base64: encode(skillMd("路由演练")) },
    ] });
    for (const cookie of [dev, boss]) {
      const direct = await fetch(`${base}/skills/route-demo`, {
        method: "PUT", headers: { cookie }, body: payload,
      });
      assert.equal(direct.status, 404, "直传入口退役，管理员也不能绕过审查");
    }
    const pending = await fetch(`${base}/skills/route-demo/submissions`, {
      method: "POST", headers: { cookie: dev }, body: payload,
    });
    assert.equal(pending.status, 200);
    const submission = await pending.json() as { id: string };
    assert.equal(listHostSkillShelf(dataDir).skills.length, 0,
      "提交草稿只进入待审区，不能直接上架");
    const accepted = await fetch(`${base}/skills/route-demo/submissions/${submission.id}/approve`, {
      method: "POST", headers: { cookie: boss },
    });
    assert.equal(accepted.status, 200);

    const view = await (await fetch(`${base}/skills`,
      { headers: { cookie: dev } })).json() as {
        skills: Array<{ nature: string; technologies: string[] }>;
        operations: Array<{ operator: string }>;
      };
    assert.equal(view.skills.length, 1, "开发者看得见货架与留痕");
    assert.equal(view.skills[0].nature, "engineering");
    assert.deepEqual(view.skills[0].technologies, ["cpp"]);
    assert.equal(view.operations[0].operator, "boss",
      "留痕记录的是真实操作人,不是前端自报");
    const document = await (await fetch(`${base}/skills/route-demo`,
      { headers: { cookie: dev } })).json() as {
        content: string; path: string; digest: string; package_digest: string;
      };
    assert.match(document.content, /路由演练/,
      "登录成员应能从名称打开实际 SKILL.md");
    assert.equal(document.path, "route-demo/SKILL.md");
    const currentSkill = listHostSkillShelf(dataDir).skills[0];
    assert.equal(document.digest, currentSkill.digest);
    assert.equal(document.package_digest, currentSkill.package_digest,
      "HTTP 正文详情必须把当前正文与整包身份一起返回");

    const retagged = await fetch(`${base}/skills/route-demo/classification`, {
      method: "PATCH", headers: { cookie: boss },
      body: JSON.stringify({ nature: "engineering",
        business_module_ids: [], repositories: [],
        technologies: ["java", "js"] }),
    });
    assert.equal(retagged.status, 200, await retagged.text());
    const retaggedShelf = await (await fetch(`${base}/skills`,
      { headers: { cookie: dev } })).json() as {
        skills: Array<{ technologies: string[] }> };
    assert.deepEqual(retaggedShelf.skills[0].technologies,
      ["java", "javascript"]);

    const badLegacyTags = await fetch(`${base}/skills/route-demo/languages`, {
      method: "PATCH", headers: { cookie: boss },
      body: JSON.stringify({ languages: ["agnostic", "java"] }),
    });
    assert.equal(badLegacyTags.status, 404,
      "旧语言编辑动作已退役");

    const coupled = await fetch(`${base}/skills/route-demo/classification`, {
      method: "PATCH", headers: { cookie: boss },
      body: JSON.stringify({ nature: "business",
        business_module_ids: ["orders"], repositories: [],
        technologies: ["java"] }),
    });
    assert.equal(coupled.status, 400);
    assert.match(await coupled.text(), /业务知识不能标工程语言/);

    const unknownModule = await fetch(
      `${base}/skills/route-demo/classification`, {
        method: "PATCH", headers: { cookie: boss },
        body: JSON.stringify({ nature: "business",
          business_module_ids: ["missing-module"], repositories: [],
          technologies: [] }),
      });
    assert.equal(unknownModule.status, 400,
      "业务型 Skill 不能挂到不存在的模块");
    assert.match(await unknownModule.text(), /没有业务模块/);

    const badUpload = await fetch(`${base}/skills/route-demo/submissions`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ ...ENGINEERING_METADATA, files: [{ path: "SKILL.md",
        content_base64: encode(skillMd("坏的", "token = ghp_abcdefghijkl")) }] }),
    });
    assert.equal(badUpload.status, 400, "掩码扫描把关在路由上同样生效");

    const offline = await fetch(`${base}/skills/route-demo`, {
      method: "DELETE", headers: { cookie: boss } });
    assert.equal(offline.status, 200);
    const versions = await (await fetch(
      `${base}/skills/route-demo/versions`,
      { headers: { cookie: dev } })).json() as {
        versions: Array<{ version_id: string }>;
      };
    assert.equal(versions.versions.length, 2,
      "审查上架后，改分类与下线都形成独立可回退版本");
    const rollback = await fetch(`${base}/skills/route-demo/rollback`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ version: versions.versions[0].version_id }),
    });
    assert.equal(rollback.status, 200, "下线可以按版本痕回退");
  } finally {
    await service.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("包内路径放开中文(实锤:references/0010_如何使用Kernel.md 被拒);点开头与遍历照拒", async () => {
  const dataDir = mfcTemp("mfc-skill-lib-cjk-");
  const record = await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("单测写法")) },
    // 内网真实被拒的路径原样收录,防回归。
    { path: "references/0010_如何使用Kernel.md", content_base64: encode("内核用法\n") },
  ], "admin-a", ENGINEERING_METADATA);
  assert.equal(record.files, 2);
  assert.ok(existsSync(join(
    dataDir, "skills", "java-autout", "references", "0010_如何使用Kernel.md")));

  // 目录名保持 ASCII(进 URL/配置/prompt),中文目录名仍拒。
  await assert.rejects(uploadHostSkill(dataDir, "中文目录", [
    { path: "SKILL.md", content_base64: encode(skillMd("x")) },
  ], "admin-a", ENGINEERING_METADATA), SkillLibraryError);
  // 点开头(.env)与 ".." 遍历依旧没门。
  await assert.rejects(uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("x")) },
    { path: "refs/.env", content_base64: encode("A=1\n") },
  ], "admin-a", ENGINEERING_METADATA), SkillLibraryError);
  await assert.rejects(uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("x")) },
    { path: "../escape.md", content_base64: encode("x\n") },
  ], "admin-a", ENGINEERING_METADATA), SkillLibraryError);
});

test("提交待审:验收闸同上架,通过才上架,驳回留痕,不许二次裁决", async () => {
  const dataDir = mfcTemp("mfc-skill-sub-");
  // 不合格的包(缺 SKILL.md)连待审区都进不去。
  await assert.rejects(submitHostSkill(dataDir, "java-autout", [
    { path: "notes.md", content_base64: encode("没有 SKILL.md\n") },
  ], "dev-a", ENGINEERING_METADATA), SkillLibraryError);

  const submitted = await submitHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("开发者提交的写法")) },
  ], "dev-a", ENGINEERING_METADATA);
  assert.equal(submitted.status, "pending");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 0,
    "提交≠上架,货架必须还是空的");

  // 审核通过 → 上架生效,提交人/审核人都留痕。
  const approved = await approveSkillSubmission(
    dataDir, "java-autout", submitted.id, "admin-b");
  assert.equal(approved.action, "upload");
  assert.equal(listHostSkillShelf(dataDir).skills.length, 1);
  const trail = listSkillOperations(dataDir).map((op) => op.action);
  assert.ok(trail.includes("submit") && trail.includes("approve"));
  // 已裁决的不许再裁。
  await assert.rejects(approveSkillSubmission(
    dataDir, "java-autout", submitted.id, "admin-b"), SkillLibraryError);

  // 第二份提交走驳回:货架不动,原因留痕。
  const second = await submitHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("另一版写法")) },
  ], "dev-c", ENGINEERING_METADATA);
  const rejected = await rejectSkillSubmission(
    dataDir, "java-autout", second.id, "admin-b", "描述不够具体");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reject_reason, "描述不够具体");
  assert.equal(listSkillSubmissions(dataDir)
    .filter((item) => item.status === "pending").length, 0);
  await assert.rejects(rejectSkillSubmission(
    dataDir, "java-autout", second.id, "admin-b"), SkillLibraryError);

  // 与 /skills/:dir 子路由撞名的目录名不许当 skill 目录。
  await assert.rejects(submitHostSkill(dataDir, "submissions", [
    { path: "SKILL.md", content_base64: encode(skillMd("x")) },
  ], "dev-a", ENGINEERING_METADATA), SkillLibraryError);
});
