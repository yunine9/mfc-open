/**
 * 贴底跟随 hook:流式面板「人一往上翻就撒手」。
 *
 * 任务侧 EventTail 与问题侧现场页签共用同一实现(spec #2 用户故事 18:
 * 语义修复两域同享)——从 TaskCard.tsx 原文搬出成模块,行为零变化。
 * 「在不在底部」与「积压几条」的判据是纯函数,见 follow.ts
 * (atBottom/backlog,有用例);本文件只是把判据接上 ref/滚动事件
 * 与积压计数,不新增任何判断。
 *
 * 回声守卫(2026-09-01):程序滚动自己会触发 scroll 事件,而流式内容
 * 在两次滚动之间继续增长时,滞后的旧回声会被 atBottom 误判成「人在
 * 上翻」,贴底跟随在首屏装载期就被竞态松开——用户进现场页签看到的是
 * 最旧的顶部。守卫:记下程序滚动落点,位置仍等于落点的事件不参与
 * 「人上翻」判定;真正的人手滚动位置必然偏离落点。
 */
import { useEffect, useRef, useState } from "react";
import { atBottom, backlog } from "./follow";

export function useStickyBottom<T extends HTMLElement>(count: number) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const mark = useRef(count);
  /** 最近一次程序滚动的落点(scrollTop)。 */
  const setTop = useRef(0);
  const [behind, setBehind] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (pinned.current) {
      followBottom(node);
      mark.current = count;
      setBehind(0);
    } else {
      setBehind(backlog(count, mark.current));
    }
  }, [count]);

  const followBottom = (node: T) => {
    setTop.current = node.scrollHeight;
    node.scrollTo({ top: node.scrollHeight });
  };

  /** 无条件回到底部并恢复跟随:面板挂载/切回时用——用户第一眼要看的
   *  是最新消息,历史分批装载期间也钉在底部,人上翻才撒手。
   *  必须瞬时滚动:smooth 的中途 scroll 事件偏离最终落点,会被回声
   *  守卫误判成「人上翻」,pinned 在飞行途中就被掐灭——进现场停不在
   *  底部、"已暂停跟随"横幅反复闪烁,都是它(2026-09-03)。 */
  const resync = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = true;
    mark.current = count;
    setBehind(0);
    followBottom(node);
  };

  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    // 位置仍停在程序滚动落点上的事件是自己的回声(或内容增长间隙里的
    // 旧事件),不据此判定;人手滚动位置必然偏离落点。
    if (Math.abs(node.scrollTop - setTop.current) < 2) return;
    const bottom = atBottom(node);
    if (bottom === pinned.current) return;
    pinned.current = bottom;
    if (bottom) { mark.current = count; setBehind(0); }
  };

  const toBottom = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = true;
    mark.current = count;
    setBehind(0);
    followBottom(node);
  };

  return { ref, behind, paused: !pinned.current, onScroll, toBottom, resync };
}
