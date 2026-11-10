/**
 * 终止会话确认框(#541):工作台头部「终止会话」与列表卡片「终止」两个
 * 入口弹同一个框(本组件是唯一实现,两处各自持有开关状态)。
 *
 * 交互口径(对齐拍板,#540):
 * - 终止原因下拉八项必选不可跳过,默认「问题已处理」,回车即按当前
 *   选中项确认(焦点初落在确认钮,文本框里回车是换行、下拉触发钮上
 *   回车是展开,这两处不劫);
 * - 选「其他原因」时下方展开选填说明文本框,留存备分析;
 * - 终止联动事前提示(ADR-0072):有单号且选中完结类原因(问题已处理/
 *   无需处理)时提示「将同时把该单自动接单改为排除」——该单已被排除
 *   的不提示(「将改为」对已排除者是噪音);提示归提示,不加勾选框、
 *   不做事后二次弹窗,回车两秒退出的低摩擦不破;
 * - 「返回」无副作用退出(Esc/点背板同路,均不产生任何写入);
 * - 框内不出现任何指标、考核字眼(原因只是人话选择,不做评分)。
 *
 * 壳与防重纪律抄异常重跑确认框(SessionView 的 revive Dialog 先例):
 * busy 时开合与按钮全禁,后端拒绝经调用侧既有错误通道落账,框内不另
 * 造报错面。提交有 sent 闸:回车与按钮双路只发一次。
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CANCEL_REASON_OPTIONS, EXCLUSION_LINK_CANCEL_REASONS } from "./cancelReasons";
import type { IssueCancelReason } from "../api";

export interface CancelSessionInput {
  reason: IssueCancelReason;
  /** 仅 reason="other" 由用户填写时携带(选填,提交前已 trim)。 */
  reasonText?: string;
}

export function CancelSessionDialog({ open, busy, onOpenChange, onConfirm,
  ticket, autoClaimExcluded }: {
  open: boolean;
  /** 发起中禁用开合与按钮,防状态在途重复发起(与 revive 同纪律)。 */
  busy?: boolean;
  /** 关闭(返回/Esc/点背板)一律无副作用;只有 onConfirm 才发起取消。 */
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: CancelSessionInput) => void;
  /** 会话的单号(ADR-0072 联动提示的前提):无单会话没有可排除的
   *  对象,缺席=不提示。 */
  ticket?: string;
  /** 该单已被排除自动接单(IssueSummary.auto_claim_excluded,服务端
   *  稀疏在场):已排除的单不再提示「将改为排除」。 */
  autoClaimExcluded?: boolean;
}) {
  const [reason, setReason] = useState<IssueCancelReason>("resolved");
  const [reasonText, setReasonText] = useState("");
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // 回车与按钮双路共用的 sent 闸:一次打开只发一次。
  const sentRef = useRef(false);
  // 每次打开重置回默认档:上一次的选择与说明不残留(必选语义从默认
  // 「问题已处理」开始,回车即按它确认)。
  useEffect(() => {
    if (open) {
      setReason("resolved");
      setReasonText("");
      sentRef.current = false;
    }
  }, [open]);

  function confirm() {
    if (sentRef.current || busy) return;
    sentRef.current = true;
    const text = reasonText.trim();
    onConfirm({
      reason,
      ...(reason === "other" && text ? { reasonText: text } : {}),
    });
  }

  return <Dialog open={open}
    onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent aria-label="终止会话确认"
      initialFocus={confirmRef}
      onKeyDown={(event) => {
        // 回车即确认(按当前选中项);文本框里回车是换行,按钮与下拉
        // 触发钮各有自己的回车语义,都不劫。
        if (event.key !== "Enter" || event.shiftKey) return;
        const target = event.target as HTMLElement;
        if (target.tagName === "TEXTAREA" || target.closest("button")
          || target.closest('[data-slot="select-trigger"]')) return;
        event.preventDefault();
        confirm();
      }}>
      <DialogHeader>
        <DialogTitle>终止会话</DialogTitle>
        <DialogDescription>
          将终止会话并清理现场，此操作不可撤销。请选择终止原因：
        </DialogDescription>
      </DialogHeader>
      <Select value={reason} items={CANCEL_REASON_OPTIONS}
        onValueChange={(value) => setReason((value ?? "resolved") as IssueCancelReason)}>
        <SelectTrigger aria-label="终止原因" className="w-full" disabled={busy}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {CANCEL_REASON_OPTIONS.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {/* 终止联动事前提示(ADR-0072):有单+完结类原因
          (EXCLUSION_LINK_CANCEL_REASONS,镜像服务端联动词表)+未排除
          才显示。文案拍板于评审对话,指路 DTS 列表(该列默认隐藏,需在
          列显隐里打开)——不加勾选框、确认后不二次弹窗。 */}
      {ticket && !autoClaimExcluded
        && EXCLUSION_LINK_CANCEL_REASONS.has(reason)
        && <p className="text-[13px] leading-relaxed text-muted-foreground">
          终止后将同时把该单的自动接单改为「排除」，见DTS列表自动接单列
        </p>}
      {reason === "other" && <Textarea aria-label="终止说明（选填）" rows={3}
        disabled={busy}
        placeholder="想具体说说吗？（选填）"
        value={reasonText}
        onChange={(event) => setReasonText(event.target.value)} />}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy}
          onClick={() => onOpenChange(false)}>返回</Button>
        <Button type="button" variant="destructive" ref={confirmRef}
          disabled={busy} onClick={confirm}>终止会话</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
