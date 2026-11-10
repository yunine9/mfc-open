export type HelpAudience = "所有人" | "开发成员" | "管理员";
export type HelpViewerRole = "developer" | "admin";

export interface AudienceScopedHelpItem {
  id: string;
  audience: HelpAudience;
}

/**
 * 帮助权限不是目录装饰：直链、快捷入口和相关推荐都必须共用同一条
 * 可见性规则，避免把隐藏文章从旁路重新露出来。
 */
export function canViewHelpItem(
  item: AudienceScopedHelpItem,
  viewerRole?: HelpViewerRole,
): boolean {
  if (!viewerRole || item.audience === "所有人") return true;
  return viewerRole === "admin"
    ? item.audience === "管理员"
    : item.audience === "开发成员";
}

export function filterVisibleHelpItems<T extends AudienceScopedHelpItem>(
  items: readonly T[],
  viewerRole?: HelpViewerRole,
): T[] {
  return items.filter((item) => canViewHelpItem(item, viewerRole));
}

/** 直链不可见或不存在时，稳定回到该角色能看到的第一篇文章。 */
export function resolveVisibleHelpItem<T extends AudienceScopedHelpItem>(
  items: readonly T[],
  id: string | undefined,
  viewerRole?: HelpViewerRole,
): T | undefined {
  const visible = filterVisibleHelpItems(items, viewerRole);
  return visible.find((item) => item.id === id) ?? visible[0];
}

/** 按原 id 顺序取可见文章；相关推荐等入口不会因回退产生重复卡片。 */
export function visibleHelpItemsById<T extends AudienceScopedHelpItem>(
  items: readonly T[],
  ids: readonly string[],
  viewerRole?: HelpViewerRole,
): T[] {
  return ids.flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item && canViewHelpItem(item, viewerRole) ? [item] : [];
  });
}
