/**
 * 服务端任务摘要与前端镜像逐字段对账(静态,不起服务)。
 *
 * 为什么要有:前端"不推断状态,一切文案来自任务 API 镜像",镜像就是
 * web/src/api.ts 里手抄的一份 TaskSummary。服务端加字段、镜像忘了补,页面
 * 读到 undefined 静默失效(4c149aa 补 feedback 镜像、本轮补 stall_class,
 * 都是事后发现)。问题流那边 176b0e0 已经有"服务端真实投影与 api.ts 镜像
 * 逐字段对账",需求任务这边没有——本文件补上:服务端 TaskSummary 的每个
 * 字段(含内联对象的子字段)都必须在镜像里有同名字段。
 *
 * 只查"服务端有、镜像没有";镜像多出来的字段另有前端契约管。类型是否一致
 * 不在此查(两边类型写法不同,机械比对噪声大),名字对上是最低要求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function interfaceFields(file: string, name: string, ...relatedFiles: string[]): Set<string> {
  // 只展开列出的类型来源，包括镜像中的 PrepushRuntime 和服务端单独定义的 TaskDeliverySummary。
  const named = new Map<string, ts.NodeArray<ts.TypeElement>>();
  const parents = new Map<string, string[]>();
  for (const path of [file, ...relatedFiles]) {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf-8"), ts.ScriptTarget.Latest, true);
    source.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node)) {
        named.set(node.name.text, node.members);
        parents.set(node.name.text, node.heritageClauses?.flatMap(clause =>
          clause.types.map(type => type.expression.getText())) ?? []);
      }
      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) named.set(node.name.text, node.type.members);
    });
  }
  // 纯数据类型抽到独立模块后，继承的字段仍须逐项核对，不能只检查宿主补充字段。
  const inheritedMembers = (name: string, seen = new Set<string>()): ts.TypeElement[] => {
    if (seen.has(name)) return [];
    const next = new Set([...seen, name]);
    return [...(parents.get(name) ?? []).flatMap(parent => inheritedMembers(parent, next)),
      ...(named.get(name) ?? [])];
  };
  const fields = new Set<string>();
  const membersOf = (type: ts.TypeNode | undefined, seen: Set<string>): ts.NodeArray<ts.TypeElement> | undefined => {
    if (!type) return undefined;
    if (ts.isTypeLiteralNode(type)) return type.members;
    if (ts.isArrayTypeNode(type)) return membersOf(type.elementType, seen);
    if (ts.isParenthesizedTypeNode(type)) return membersOf(type.type, seen);
    if (ts.isUnionTypeNode(type)) {
      for (const part of type.types) { const found = membersOf(part, seen); if (found) return found; }
      return undefined;
    }
    if (ts.isTypeReferenceNode(type)) {
      const ref = type.typeName.getText();
      if ((ref === "Array" || ref === "ReadonlyArray") && type.typeArguments?.[0]) return membersOf(type.typeArguments[0], seen);
      if (named.has(ref) && !seen.has(ref)) { seen.add(ref); return ts.factory.createNodeArray(inheritedMembers(ref)); }
    }
    return undefined;
  };
  const collect = (members: ts.NodeArray<ts.TypeElement>, prefix: string, seen: Set<string>) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const key = prefix + (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : member.name.getText());
      fields.add(key);
      const nested = membersOf(member.type, new Set(seen));
      if (nested) collect(nested, `${key}.`, new Set([...seen, key]));
    }
  };
  assert.ok(named.has(name), `${file} 里找不到 interface ${name}`);
  collect(ts.factory.createNodeArray(inheritedMembers(name)), "", new Set([name]));
  return fields;
}

/** 服务端有、镜像刻意不镜像的字段:每一条都要写清为什么前端不需要。 */
const NOT_MIRRORED = new Set<string>([
  "ui_fixture",                       // 只在 UI 场景库冻结状态时写,正式任务永远没有
  "workspace",                        // 服务端现场绝对路径,页面不该拿到宿主路径
  "delivery_scope_exemptions",        // 主责任人放行过的越界文件,服务端复判用
  "repository_supplement_resolved",   // 仓库补充信息已解析的内部标记
  "delivery.mr_id",                   // 平台内部编号;页面用 mr_url
  "delivery.source_branch",           // 分支对是门禁查询与冲突修复的参数
  "delivery.target_branch",
  "delivery.checks",                  // 逐项流水线结果由内核裁决;页面看 pipeline 汇总
  "delivery.codecheck",               // 推送前 codecheck 预检的原始结果(#559),服务端门禁与回执用;页面看流水线汇总
  "delivery.git_push",                // 推送收据:内核比对三方 SHA 用
  "delivery.foreign_commits",         // 派给修复 Agent 的"别回滚"清单
  "delivery.last_reviewed_head",      // 复检卡的锚点,服务端算复检范围用
  "delivery.sha",                     // 验证过的提交,页面看 mr_url / pipeline
  "delivery.attested",                // 内核 quality.pipeline 的镜像,服务端门禁用
  "delivery.verify_deadline",         // 自愈预算到期时刻,重启对表用
  "delivery.evidence_gap.failure_log", // 原始日志走材料接口,不塞进摘要
  "delivery.evidence_gap.retry_deadline",
  "delivery.evidence_gap.human_evidence",
  "delivery.evidence_gap.human_dimensions",
  "delivery.loop.workspace_review_pending", // 修复环内部刹车锚与派单指纹
  "delivery.loop.last_sha",
  "delivery.loop.review_ids",
  "delivery.loop.replied_ids",
  "delivery.loop.workspace_review_receipt_retry_for",
  "delivery.loop.feedback_receipt_retry_for",
  "delivery.review_processing_dispatched_for",
  "requirement_graph.review_snapshot",        // 拆分方案确认时封存的指纹(sha256/waiting_id),防篡改核对用
  "requirement_graph.reviewed_plan_revisions", // 已检视过的方案版本号,服务端判"要不要再举卡"
]);

test("任务摘要:服务端 TaskSummary 的每个字段都在 api.ts 镜像里", () => {
  const server = interfaceFields("src/taskService.ts", "TaskSummary", "src/taskDeliverySummary.ts", "src/requirementProjection.ts", "src/deliverySummary.ts");
  const mirror = interfaceFields("web/src/api.ts", "TaskSummary");
  const missing = [...server].filter((field) => !mirror.has(field) && !NOT_MIRRORED.has(field)
    // 父字段已豁免的,子字段一并豁免
    && ![...NOT_MIRRORED].some((allowed) => field.startsWith(`${allowed}.`)));
  assert.deepEqual(missing, [],
    `服务端有而前端镜像没有的字段(补进 web/src/api.ts,或写明理由加进 NOT_MIRRORED): ${missing.join(", ")}`);
  const stale = [...NOT_MIRRORED].filter((field) => !server.has(field));
  assert.deepEqual(stale, [], `豁免表里有服务端已经不存在的字段: ${stale.join(", ")}`);
});

test("交付报告状态枚举在持久化、API 与前端镜像中一致，包含部分成功", () => {
  const statusValues = (path: string, interfaceName: string, property?: string) => {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) as ts.InterfaceDeclaration;
    let members = declaration.members;
    if (property) members = ((members.find(member => ts.isPropertySignature(member) && member.name.getText() === property) as ts.PropertySignature).type as ts.TypeLiteralNode).members;
    const status = members.find(member => ts.isPropertySignature(member) && member.name.getText() === "status") as ts.PropertySignature;
    assert.ok(status.type && ts.isUnionTypeNode(status.type));
    return status.type.types.map(type => (type as ts.LiteralTypeNode).literal.getText()).sort();
  };
  const expected = ['"running"', '"completed"', '"partial"', '"failed"'].sort();
  assert.deepEqual(statusValues("src/deliverySummary.ts", "ReportState"), expected);
  assert.deepEqual(statusValues("src/deliverySummary.ts", "DeliveryReportView"), expected);
  assert.deepEqual(statusValues("web/src/api.ts", "TaskSummary", "delivery_report"), expected);
});

// ---- 检视意见(#261):问题域的检视 wire 是 GET /issues/:id/reviews 投出的
// ---- Annotation(src/annotations.ts,需求流共用的全量形状),镜像在
// ---- web/src/api.ts 的 IssueReview。Annotation 每个字段都必须在镜像里,
// ---- 或在下表写明"问题域 wire 为什么不出它"。

/** 服务端 Annotation 有、IssueReview 刻意不镜像的字段(全是需求流闭环/
 * 协作检视的形状,问题域不存在这些通道;问题域闭环靠意见处的逐条
 * respond 回复(ADR-0036)与分析确认卡的整体把关,ADR-0007/ADR-0025)。 */
const REVIEW_NOT_MIRRORED = new Set<string>([
  "route",              // 需求流的路由(owner_reply/decision/memory);问题域恒 agent
  "assignee",           // 责任人指派;问题会话没有协作检视
  "images",             // 附图是需求流批注写口;问题域圈注不收图(routes 不收该参)
  "sent_by",            // 问题域提交 markSent 不带 by,投影恒缺席
  "agent_assigned",     // 需求流交接锁
  "agent_context",      // 责任人转交补充说明
  "response",           // 已镜像,但镜像整体复用 Annotation["response"] 引用
                        // (ADR-0035 起随回复型意见出),子字段不逐个展开,按前缀豁免
  "author_replies",     // 已整体复用 Annotation["author_replies"]，与 response 同样不展开引用
  "owner_reply",        // 责任人原话记账
  "verified_at",        // 逐条确认是需求流闭环;问题域整卡确认
  "verified_by",
  "resolution",         // 逐条处置(fixed/not_adopted/…)
  "needs_owner_closure",// 责任人闭环标记
  "withdrawal_requested",
  "rework",             // 正文版本计数;问题域意见改字走软删重记
  "returned",           // 退回次数
  "reopened",           // reopen 投影
  "anchor_was",         // 返工历史锚点
  "clarifications",     // Agent 追问留档
]);

test("检视意见:Annotation 的每个字段都在 IssueReview 镜像里或有豁免", () => {
  const server = interfaceFields("src/annotations.ts", "Annotation");
  const mirror = interfaceFields("web/src/api.ts", "IssueReview");
  const missing = [...server].filter((field) => !mirror.has(field)
    && !REVIEW_NOT_MIRRORED.has(field)
    // 父字段已豁免的,子字段一并豁免
    && ![...REVIEW_NOT_MIRRORED].some((allowed) => field.startsWith(`${allowed}.`)));
  assert.deepEqual(missing, [],
    `检视 wire 有而前端镜像没有的字段(补进 IssueReview,或写明理由加进 REVIEW_NOT_MIRRORED): ${missing.join(", ")}`);
  const stale = [...REVIEW_NOT_MIRRORED].filter((field) => !server.has(field));
  assert.deepEqual(stale, [], `豁免表里有服务端已经不存在的字段: ${stale.join(", ")}`);
});
