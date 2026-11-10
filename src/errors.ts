/**
 * 任务控制面的两个错误类型。单独成文件是为了让纯规则模块(pushReviewPolicy
 * 等)也能抛它们而不必 import 两万行的 taskService——那会绕成循环依赖。
 * taskService 原样再导出,调用方与测试的 import 路径不变。
 */
export class NotFoundError extends Error {}
export class TaskControlError extends Error {}
