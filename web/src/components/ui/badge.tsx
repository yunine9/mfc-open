import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/* shadcn base-nova 皮(2026-09-11 融进):slot/variant 经 useRender state
 * 下发(data-slot 自动带出),类形逐字取官方注册表。 */

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        /* #216 徽标动物园收编(.pill/.ui-badge/warmup-badge 等):状态语义
         * soft 底 variant,配方对齐 destructive(soft 底 + 同族深字),颜色
         * 全部经 tailwind.css @theme 桥指向 tokens.css 状态令牌。brand =
         * 存量 --accent(主动作紫;问题"闲置"、心愿"已采纳"原色),
         * neutral = 灰态(排队/暂停/取消/无信号),suspended 沿用 12% 弱底。 */
        info: "bg-active-soft text-active",
        success: "bg-success-soft text-success",
        warning: "bg-attention-soft text-attention",
        merge: "bg-merge-soft text-merge",
        neutral: "bg-muted text-muted-foreground",
        brand: "bg-accent text-primary",
        suspended: "bg-suspended/10 text-suspended",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
