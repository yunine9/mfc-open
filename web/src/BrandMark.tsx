import { cn } from "cn";

/** 侧栏、登录页和演示图例共用的平台标识。 */
export function BrandMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn("grid size-[26px] shrink-0 place-items-center rounded-[8px] bg-(--ink) text-(--ink-fg) shadow-[var(--shadow-primary)] [&_svg]:size-3.5 [&_svg]:[stroke-width:2.4]", className)}>
    <svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg>
  </span>;
}
