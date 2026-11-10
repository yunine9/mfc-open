/** Archify semantic roles, not task status or a decorative color rotation. */
export const moduleTypes = ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external'] as const;
export function moduleType(value: unknown): typeof moduleTypes[number] {
  return moduleTypes.includes(value as typeof moduleTypes[number]) ? value as typeof moduleTypes[number] : 'external';
}
export function moduleDot(value: unknown): string {
  return ({frontend:'cyan',backend:'emerald',database:'violet',cloud:'amber',security:'rose',messagebus:'orange',external:'slate'})[moduleType(value)];
}
export const moduleLegend = {mode:'auto',entries:{frontend:{label:'界面与交互'},backend:{label:'处理与编排'},database:{label:'数据与版本存储'},cloud:{label:'基础设施'},security:{label:'安全控制'},messagebus:{label:'消息与队列'},external:{label:'资料与外部依赖'}}};
/** Reviewed classification of the existing local sample; original GLM output stays intact.
 * Template/Story are document inputs, not databases. Version storage is filesystem-backed.
 * Opinion handoff is coordination logic, not evidence of a message broker.
 */
export function classifyStoryFixture(data: any) {
  const roles: Record<string, string> = {'main-task':'frontend','story-generator':'backend','template-asset':'external','subtask-stories':'external','review-reader':'frontend','doc-session':'backend','version-store':'database','subtask-loop':'backend'};
  return {...data,modules:data.modules.map((m:any)=>({...m,type:m.type ?? roles[m.id]}))};
}
