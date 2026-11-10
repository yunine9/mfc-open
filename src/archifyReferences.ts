import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIFY_ROOT } from "./archifyRender.ts";

/** 提供固定版本的参考和离线渲染器，让 Agent 能验证布局，而不只检查 JSON 格式。 */
export function materializeArchifyReferences(directory: string, options: { hostValidation?: boolean; required?: boolean } = {}): string {
  try {
    mkdirSync(directory, { recursive: true });
    for (const name of ["schemas", "examples", "renderers", "assets", "LICENSE", "THIRD_PARTY_NOTICES.md", "UPSTREAM.json"]) {
      cpSync(join(ARCHIFY_ROOT, name), join(directory, name), { recursive: true });
    }
    const instructions = [
      "# Archify 离线参考与预览",
      "先读取 schemas/ 和 examples/ 中的对应类型，勿照抄示例业务。",
      "平台架构图必须写入独立的 architecture.json，禁止把 Archify JSON 塞进 Story。",
      ...(options.hostValidation ? ["本会话由平台执行实际渲染，不执行命令、不写临时文件。写好 architecture.json 后结束本轮，平台会反馈错误供继续修正。"] : [
        "提交前将 architecture.json 中每个 source 提取为临时 JSON，使用这里的固定渲染器逐图试渲染：",
        "node <本目录>/renderers/<diagram_type>/render-<diagram_type>.mjs <临时JSON> <临时HTML>",
      ]),
      "选图：模块/服务/存储及依赖用 architecture；业务步骤和分支用 workflow；参与者调用与返回顺序用 sequence；数据流转与转换用 dataflow；对象状态迁移用 lifecycle。",
      "先抽取全文的职责、参与者、接口、数据与场景，再选必要图。4+1 的 view 是设计视角，diagram_type 是表达方式，二者不是一一对应。类图不受支持，不用拓扑冒充。",
      "参考入口：schemas/common.schema.json；各类型 schemas/<diagram_type>.schema.json；示例分别为 examples/web-app.architecture.json、agent-tool-call.workflow.json、cache-miss-request.sequence.json、event-stream.dataflow.json、agent-run.lifecycle.json。",
      "先读所选类型的 schema 和完整示例，沿用其字段结构和枚举。节点 id 唯一、连线引用真实节点，坐标/尺寸、端口和标签遵守该类型约定；扩大间距避免文字、节点和连线遮挡，不照抄示例业务。",
      "渲染器不需要安装依赖。图源禁用 brand、repository、sources 外部读取字段。",
      "JSON 合法不表示图可展示。按诊断修复连线端点、标签遮挡等问题，再试渲染；不要关闭布局校验。",
      "Story 是设计正本，architecture.json 是平台内部派生产物；设计变化时同步重新生成，临时 JSON/HTML 仅作验证。",
      "如实报告验证结果。无法运行或修复时告知用户具体缺口，不新增流程门禁。",
    ].join("\n");
    writeFileSync(join(directory, "README.md"), instructions);
    return `Archify 离线资料与渲染器：${directory}/README.md；先查对应 schema 和示例，按 README 约定完成渲染验证。`;
  } catch (error) {
    const message = `Archify 参考资料准备失败：${error instanceof Error ? error.message : String(error)}`;
    if (options.required) throw new Error(message);
    return `${message}。无法可靠表达的图保留 PlantUML 和文字，不编造受支持语法。`;
  }
}
