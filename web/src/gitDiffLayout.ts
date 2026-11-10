export const DEFAULT_TREE_PANEL_WIDTH = 320;
export const MIN_TREE_PANEL_WIDTH = 240;
export const MAX_TREE_PANEL_WIDTH = 560;
export const MIN_DIFF_DETAIL_WIDTH = 420;

export const DEFAULT_DIFF_SPLIT = 50;
export const MIN_DIFF_SPLIT = 25;
export const MAX_DIFF_SPLIT = 75;

export const DEFAULT_DIFF_FONT_SIZE = 15;
export const MIN_DIFF_FONT_SIZE = 12;
export const MAX_DIFF_FONT_SIZE = 20;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** 目录栏可拉宽，但永远给右侧代码至少留出一块可读区域。 */
export function clampTreePanelWidth(
  requested: number,
  containerWidth: number,
): number {
  const availableMaximum = Math.max(
    MIN_TREE_PANEL_WIDTH,
    containerWidth - MIN_DIFF_DETAIL_WIDTH,
  );
  return Math.round(clamp(
    requested,
    MIN_TREE_PANEL_WIDTH,
    Math.min(MAX_TREE_PANEL_WIDTH, availableMaximum),
  ));
}

/** 双栏始终至少各留 25%，不允许把某一侧拖到完全消失。 */
export function clampDiffSplit(requested: number): number {
  return Math.round(clamp(requested, MIN_DIFF_SPLIT, MAX_DIFF_SPLIT) * 10) / 10;
}

export function diffSplitFromPointer(
  clientX: number,
  canvasLeft: number,
  canvasWidth: number,
): number {
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) return DEFAULT_DIFF_SPLIT;
  return clampDiffSplit(((clientX - canvasLeft) / canvasWidth) * 100);
}

export function clampDiffFontSize(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_DIFF_FONT_SIZE;
  return Math.round(clamp(requested, MIN_DIFF_FONT_SIZE, MAX_DIFF_FONT_SIZE));
}
