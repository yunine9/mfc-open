/**
 * 分析会话里模型把仓库写成 repo-1/repo-2:那是 prompt 清单的序号,落到
 * 决策卡上人完全看不出指的是哪个仓(内网实锤 2026-09-04)。prompt 已改成
 * 按仓库名称呼,这里是第二道:举卡文本里残留的序号机械换成仓库名。序号
 * 与名字的对应由调用方给(按下单顺序 repo-1、repo-2…),这里不猜。
 */
export interface NamedRepository {
  id: string;
  name?: string;
}

export function humanizeRepositoryIds(
  text: string,
  repositories: readonly NamedRepository[],
): string {
  const names = new Map<string, string>();
  for (const repository of repositories) {
    const name = repository.name?.trim();
    if (name && name !== repository.id) names.set(repository.id, name);
  }
  if (!names.size || !text) return text;
  // 前后不能挨着字母/数字/连字符:别把 my-repo-1 或 repo-10 的前缀吃掉。
  return text.replace(/(?<![\w-])repo-(\d+)(?![\w-])/g, (whole, index) =>
    names.get(`repo-${index}`) ?? whole);
}
