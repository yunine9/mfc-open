// 票 #218:统一自旋态。`npx shadcn view @shadcn/spinner` 确认注册表结构为
// Loader2Icon + animate-spin,依赖均已装;按票不许跑 add,故按等价结构本地落地。
import { cn } from "cn"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
