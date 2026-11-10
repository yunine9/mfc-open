/**
 * 「要不要跟着滚」的判断(纯函数,好测)。
 *
 * 用户原话(2026-08-22):"sse 流一直在刷,我想停在某一处看下,就给我刷到
 * 最下面了"。原来两个面板都是无条件 `scrollTo(scrollHeight)`,在一个还在
 * 刷新的流里等于不让人看——他每滚上去一次,下一条事件到达就把他拽回来。
 *
 * 判据只用一个可观测事实:**人此刻是不是就在底部**。在底部 = 他在看最新的,
 * 跟着滚才是他要的;不在底部 = 他在往回看,滚动就是抢他的鼠标。
 * 不猜"他是不是想看",也不搞"停 3 秒自动恢复"那种自作主张的定时器——
 * 什么时候回到最新是人点一下决定的。
 *
 * 留 40px 余量而不是要求严格等于:滚动条有亚像素、内容高度变化有一帧延迟,
 * 卡死在 0 上会出现"明明在底部却判成没在",于是新事件永远不跟随。
 */

export interface ScrollBox {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** 离底多少像素以内仍算"在看最新的"。 */
export const BOTTOM_SLACK = 40;

export function atBottom(box: ScrollBox): boolean {
  // 内容还没撑满容器时 scrollHeight ≈ clientHeight、scrollTop = 0,
  // 差值 ≤ 0 < 余量,判定为贴底——正确:那时根本没有"往回看"这回事。
  return box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_SLACK;
}

/** 暂停跟随期间积压了多少条。mark 是暂停那一刻的条数。
 * 永不为负:重开面板等场景会把 count 清零,负数积压会显示成 "-3 条新的"。 */
export function backlog(count: number, mark: number): number {
  return Math.max(0, count - mark);
}
