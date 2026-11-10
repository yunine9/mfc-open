/**
 * 页内确认弹框：window.confirm 的全站替代(spec #52)。
 *
 * 调用侧只 import confirmDialog(promise 风格,返回是否确认)：
 *   if (!await confirmDialog({ title: "终止会话", danger: true })) return;
 * App 根部挂一次 ConfirmDialogHost 负责渲染;并发调用 FIFO 排队,
 * 同一时刻最多一张卡。视觉壳走 shadcn AlertDialog(base-ui 原语):
 * Esc=取消(原语在 document 层拦下并不再冒泡到 window——全屏工作台
 * 把 Escape 绑在 window 当"返回"的纪律不破)、点背板=取消、Tab 困笼
 * 与关闭归还焦点都由原语接管;危险档打开时焦点落在「取消」,防手滑
 * 连按回车。调用点不必关心这些,只声明 title/message/danger 即可。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmDialogOptions {
  title: string;
  /** 正文:字符串按原样换行渲染,也可以直接给 JSX(如后果清单)。 */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险档:破坏性确认按钮,打开时焦点落在「取消」,防手滑连按回车。 */
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
}

let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { options, resolve }];
    notify();
  });
}

function settle(confirmed: boolean) {
  const [head, ...rest] = queue;
  if (!head) return;
  queue = rest;
  head.resolve(confirmed);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // 危险档默认焦点在「取消」。首卡打开由 initialFocus 落位;FIFO 换卡
  // (上一张确认后队列里还有下一张)时弹层不重挂、initialFocus 不重放,
  // 这里按当前 head 把焦点钉回正确按钮。
  useEffect(() => {
    (current?.options.danger ? cancelRef : confirmRef).current?.focus();
  }, [current]);

  // 取消路径统一走 onOpenChange(false):Esc、点背板、以及取消按钮
  // (AlertDialogCancel 是 base-ui Close,自动经 onOpenChange 关闭)。
  return <AlertDialog open={current != null}
    onOpenChange={(open) => { if (!open) settle(false); }}>
    {current && <AlertDialogContent
      // z-(--z-topmost):确认必须压过一切弹层(全屏工作区 60、
      // Modal 950),背板随弹层一起抬,从全屏工作台发起的确认不被压住。
      className="tw-root z-(--z-topmost) [&_[data-slot=alert-dialog-overlay]]:z-(--z-topmost)"
      initialFocus={current.options.danger ? cancelRef : confirmRef}>
      <AlertDialogHeader>
        <AlertDialogTitle>{current.options.title}</AlertDialogTitle>
        {current.options.message != null && (
          <AlertDialogDescription
            render={<div className="whitespace-pre-line
              [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-5
              [&_ul]:grid [&_ul]:gap-1" />}>
            {current.options.message}
          </AlertDialogDescription>
        )}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel ref={cancelRef}>
          {current.options.cancelLabel ?? "取消"}
        </AlertDialogCancel>
        <AlertDialogAction variant={current.options.danger ? "destructive" : "default"}
          ref={confirmRef}
          onClick={() => settle(true)}>
          {current.options.confirmLabel ?? "确认"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>}
  </AlertDialog>;
}
