import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "../../web/src/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle, SheetClose } from "../../web/src/components/ui/sheet";
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogCancel } from "../../web/src/components/ui/alert-dialog";
import { Popover, PopoverTrigger, PopoverContent } from "../../web/src/components/ui/popover";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../web/src/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../../web/src/components/ui/dropdown-menu";

let clicked = 0;
function Choice({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <Select open={open} onOpenChange={setOpen} defaultValue="a" onValueChange={() => clicked++}>
    <SelectTrigger data-testid="choice-trigger"><SelectValue /></SelectTrigger>
    <SelectContent alignItemWithTrigger={false}><SelectItem value="a">原选项</SelectItem><SelectItem value="b" data-testid="choice">新选项</SelectItem></SelectContent>
  </Select>;
}
function Scenario({ kind }: { kind: string }) {
  const [open, setOpen] = useState(true);
  return <div style={{ position:"fixed", inset:0, zIndex:720, background:"white", padding:80 }} className="tw-root">
    <button data-testid="page" onClick={() => clicked++}>背景导航</button>
    {kind === "popover" && <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>任务详情</PopoverTrigger><PopoverContent><button data-testid="action" onClick={() => clicked++}>详情操作</button></PopoverContent>
    </Popover>}
    {kind === "select" && <Choice />}
    {kind === "menu" && <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>菜单</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem data-testid="action" onClick={() => clicked++}>菜单操作</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>}
    {kind === "sheet" && <Sheet open={open} onOpenChange={setOpen}><SheetContent className="tw-root">
      <SheetTitle>检视抽屉</SheetTitle><SheetClose data-testid="action" onClick={() => clicked++}>关闭抽屉</SheetClose>
    </SheetContent></Sheet>}
    {kind === "alert" && <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent className="tw-root">
      <AlertDialogTitle>确认操作</AlertDialogTitle><AlertDialogCancel data-testid="action" onClick={() => clicked++}>取消</AlertDialogCancel>
    </AlertDialogContent></AlertDialog>}
    {kind === "nested" && <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root">
      <DialogTitle>弹窗中的表单</DialogTitle><Choice initiallyOpen={false} /><DialogClose data-testid="close">关闭弹窗</DialogClose>
    </DialogContent></Dialog>}
  </div>;
}
const root = createRoot(document.getElementById("app")!);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
function hit(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw Error(`找不到 ${selector}`);
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) throw Error(`${selector} 不可见`);
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  if (!top || !element.contains(top)) throw Error(`${selector} 被遮挡，命中 ${top?.tagName}.${(top as HTMLElement)?.className}`);
  return element;
}
function escape() { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true})); }
async function run() {
  const results: string[] = [];
  for (const kind of ["popover", "select", "menu", "sheet", "alert", "nested"]) {
    try {
      root.render(<Scenario key={kind} kind={kind} />); await settle();
      if (kind === "nested") { hit('[data-testid="choice-trigger"]').click(); await settle(); }
      const before = clicked;
      hit(`[data-testid="${["select","nested"].includes(kind) ? "choice" : "action"}"]`).click(); await settle();
      if (clicked !== before + 1) throw Error("点击未送到目标操作");
      if (kind === "popover") { escape(); await settle(); }
      if (kind === "nested") { hit('[data-testid="close"]').click(); await settle(); }
      if (["popover", "select", "menu"].includes(kind)) {
        const count = clicked; hit('[data-testid="page"]').click();
        if (clicked !== count + 1) throw Error("关闭后背景仍被锁住");
      }
      // 模态框退出还涉及焦点恢复和动画生命周期，在真实服务中用原生点击单独验证。

      results.push(`${kind}:passed`);
    } catch (error) { results.push(`${kind}:${String(error)}`); }
  }
  document.getElementById("result")!.textContent = results.join("\n");
}
void run();
