/** 可填写性与不可用原因共用一份部署事实，页面不能静默隐藏代码仓。 */
export function launchRepositoryOptions(
  host: { repoPath?: string; repoPinned?: boolean } | undefined,
  requirementDisabled?: boolean,
): { enabled: boolean; required: boolean; disabled_reason?: string } {
  const disabledReason = !host
    ? requirementDisabled
      ? "本服务仅启用了问题处理，需求代码交付未启用。请前往问题处理页，或联系管理员启用需求流程。"
      : "本服务未启用代码交付，当前任务不会克隆代码仓。请联系管理员启用 kernel-mode，并检查内核、交付平台和任务镜像配置。"
    : host.repoPinned
      ? "本服务通过 repo 参数固定了代码仓，不能逐单选择。需要选择代码仓时，请联系管理员移除固定 repo 参数并启用 kernel-mode。"
      : undefined;
  return {
    enabled: !!host && !host.repoPinned,
    required: !!host && !host.repoPath,
    ...(disabledReason ? { disabled_reason: disabledReason } : {}),
  };
}
