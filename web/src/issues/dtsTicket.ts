/**
 * DTS 单号 → 门户单据页的跳转地址(列表里单号文字超链接的唯一出处)。
 * 后端同源常量在 src/issueFlow/gateways.ts(DTS_FILE_ORIGIN);前端不引
 * 后端模块,这里独立声明——改站点要两头同步。
 */

export const DTS_TICKET_ORIGIN = "https://dts.example.com";

export function dtsTicketUrl(ticket: string): string {
  return `${DTS_TICKET_ORIGIN}/DTSPortal/ticket/${encodeURIComponent(ticket)}`;
}
