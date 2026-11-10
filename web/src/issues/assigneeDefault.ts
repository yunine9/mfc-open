/**
 * 责任人缺省规则(ADR-0031):模块指向谁,问题就流向谁。
 *
 * 登记页责任人的唯一裁决,纯函数供组件与契约测试共用(同
 * descriptionTemplate 先例:UI 逻辑不进测试黑箱,规则一处说清):
 * - 未手选且未选模块 → 置空(提交前必填校验指路);
 * - 未手选且选了模块 → 填模块责任人(模块责任人可指派时),换模块
 *   跟随——自动填的是系统的缺省,不是用户的意愿,跟着模块走;
 * - 手选过(哪怕随后清空场景不存在,选人框总有值)→ 冻结,换模块
 *   不再动——那是用户表达过的意愿。
 */

export function resolveAssignee(input: {
  /** 用户手选的责任人;空串=未手选过(自动填的缺省不算手选)。 */
  manualPick: string;
  /** 所选业务模块的模块责任人;未选模块传 undefined。 */
  moduleOwner?: string;
  /** 模块责任人是否在可指派候选里(管理员/停用账号不在 developer
   * 候选——自动填进去会造出没人能推进的会话,宁缺勿错)。 */
  ownerAssignable: boolean;
}): string {
  if (input.manualPick) return input.manualPick;
  if (!input.moduleOwner) return "";
  return input.ownerAssignable ? input.moduleOwner : "";
}
