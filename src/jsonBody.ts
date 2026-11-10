/**
 * 读 HTTP 响应体的唯一姿势。
 *
 * 为什么要这么个小东西:`Response.json()` 在类型上是 unknown——正确
 * 但每个调用点都要自己收拾,于是全仓 61 处类型报错,typecheck 一直
 * 开不起来;开不起来就漏掉了"字段名写错静默变 undefined"这类 bug
 * (实测:task.delivery 实为 task.summary.delivery,靠端到端断言才逮住)。
 *
 * 这里把"外部 JSON 是弱类型"这件事集中承认一次:调用方按需给形状,
 * 不给就是 any——**这不是断言它安全**,外部数据该校验的仍要校验
 * (平台状态映射、鉴权这些地方都有各自的把关)。
 */

export async function readJson<T = any>(
  response: { json(): Promise<unknown> },
): Promise<T> {
  return (await response.json()) as T;
}
