export const WISH_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

let draftKeySequence = 0;

export interface WishImageFileLike {
  readonly type: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}

interface WishClipboardItemLike<T extends WishImageFileLike> {
  readonly kind: string;
  getAsFile(): T | null;
}

interface WishClipboardDataLike<T extends WishImageFileLike> {
  readonly items: ArrayLike<WishClipboardItemLike<T>>;
  readonly files: ArrayLike<T>;
}

export function nextWishImageDraftKey(
  file: Pick<WishImageFileLike, "name" | "size" | "lastModified">,
): string {
  draftKeySequence += 1;
  return `${file.name}-${file.size}-${file.lastModified}-${Date.now().toString(36)}-${draftKeySequence}`;
}

function supportedImage<T extends WishImageFileLike>(file: T | null): file is T {
  return Boolean(file && WISH_IMAGE_TYPES.includes(file.type as typeof WISH_IMAGE_TYPES[number]));
}

export function wishImageFilesFromClipboard<T extends WishImageFileLike>(
  clipboardData: WishClipboardDataLike<T>,
): T[] {
  const itemFiles = Array.from(clipboardData.items, (item) =>
    item.kind === "file" ? item.getAsFile() : null).filter(supportedImage);
  if (itemFiles.length > 0) return itemFiles;

  // Windows 上部分剪贴板来源不会完整填充 items，但仍会在 files 中提供截图。
  return Array.from(clipboardData.files).filter(supportedImage);
}

export function wishPasteModifier(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "⌘" | "Ctrl" {
  return /Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(userAgent) ? "⌘" : "Ctrl";
}
