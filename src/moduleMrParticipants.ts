import { readBusinessModule } from "./businessModuleLibrary.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { hasMrParticipants, normalizeMrParticipants, type MrParticipants } from "./mrParticipants.ts";

/** 知识任务已有明确所属模块，归档到公共知识仓时也沿用该模块的人员。 */
export function readModuleMrParticipants(dataDir: string, moduleId: string | undefined): MrParticipants | undefined {
  if (!moduleId) return undefined;
  return moduleParticipants(readBusinessModule(dataDir, moduleId).mr_participants);
}

function moduleParticipants(value: MrParticipants | undefined): MrParticipants | undefined {
  if (!value) return undefined;
  const participants = normalizeMrParticipants(value);
  return hasMrParticipants(participants) ? participants : undefined;
}

/** 一个模块的全部关联仓共用同一份名单；不从参考知识或仓名猜模块。 */
export function resolveModuleMrParticipants(dataDir: string, moduleId: string | undefined,
  repository: string | undefined): MrParticipants | undefined {
  if (!moduleId || !repository) return undefined;
  const module = readBusinessModule(dataDir, moduleId);
  if (!module.repositories.some(repo => repositoryIdentity(repo) === repositoryIdentity(repository))) return undefined;
  return moduleParticipants(module.mr_participants);
}
