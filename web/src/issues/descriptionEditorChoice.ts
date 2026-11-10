/**
 * 登记描述编辑器选型(#271,2026-09-17 拍板):true = Quill 富文本
 * (工具栏输入形态);false = milkdown 所见即所得。两者对外契约一致
 * (markdown 进出、图片走暂存体系),切换只是换壳——存储零迁移,
 * 翻转常量重新构建即回退,存量 description 两种模式下都能读写。
 */
export const USE_RICH_TEXT_DESCRIPTION_EDITOR = true;
