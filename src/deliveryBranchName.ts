/** 沿用需求交付的分支格式；问题单的固定前缀由调用方传入 master。 */
export function deliveryBranchName(baseline: string, account: string, ticket: string): string {
  return `${baseline}_${account}_${ticket}`;
}
