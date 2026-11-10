import { useEffect, useState } from "react";
import { productVersionRequest, type ProductVersion } from "./api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** 需求与问题共用配置目录；选择时仅带版本名，服务端再次解析当前映射。 */
export function ProductVersionPicker({ value, onChange, baseline, onLegacyBranch,
  className = "grid gap-2", labelClassName = "text-sm font-medium", required }: {
  value: string; onChange: (version: string, branch: string) => void;
  baseline?: string; onLegacyBranch?: (branch: string) => void;
  /** 版式钩子:宿主表单用它把字段对齐到自己的字段版式(默认即原版式)。 */
  className?: string;
  labelClassName?: string;
  /** 必填标记:字段头带红星(问题登记 2026-09-18 起必选)。 */
  required?: boolean;
}) {
  const [rows, setRows] = useState<ProductVersion[]>();
  const [error, setError] = useState("");
  async function refresh() {
    setError("");
    try { setRows((await productVersionRequest()).versions); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { void refresh(); }, []);
  const selected = rows?.find(row => row.version === value);
  useEffect(() => {
    if (selected && baseline !== undefined && selected.branch !== baseline) {
      onChange(selected.version, selected.branch);
    }
  }, [selected?.version, selected?.branch, baseline]);
  return <div className={className}>
    <span className={labelClassName}>产品版本
      {required && <> <i className="font-bold not-italic text-danger">*</i></>}</span>
    <Select value={value} required={!!onLegacyBranch && !!rows?.length} disabled={!rows?.length} items={[{ value: "", label: "选择产品版本" }, ...(rows ?? []).map(row => ({ value: row.version, label: row.version }))]}
      onValueChange={v => { const row = rows?.find(r => r.version === v); onChange(row?.version ?? "", row?.branch ?? ""); }}>
      <SelectTrigger className="w-full" aria-label="产品版本"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="">选择产品版本</SelectItem>{rows?.map(row => <SelectItem key={row.id} value={row.version}>{row.version}</SelectItem>)}</SelectContent>
    </Select>
    {selected && <small className="text-sm text-muted-foreground">对应分支：<code>{selected.branch}</code></small>}
    {rows?.length === 0 && <small className="text-sm text-muted-foreground">尚未配置版本，请在配置中心维护版本与分支。</small>}
    {!value && rows?.length === 0 && onLegacyBranch && <label className="grid gap-1 text-sm">{rows?.length ? "未选版本时使用的基线分支" : "基线分支"}<Input required value={baseline ?? ""} onChange={e => onLegacyBranch(e.target.value)} /></label>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {(error || rows?.length === 0) && <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>重新读取配置</Button>}
  </div>;
}
