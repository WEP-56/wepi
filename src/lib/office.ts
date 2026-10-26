/**
 * Office 选区：OfficeCLI 的 HTML 预览里选中的段落/单元格。
 *
 * 这里只放跨组件共享的类型和小工具；HTML 渲染、截图在 Rust/PreviewView，
 * 附件构造在 lib/attachments，避免把 UI 依赖拖进 data.ts。
 */

export type OfficePreviewKind = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'other';

export interface OfficeSelectionBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OfficeSelection {
  /** 文档绝对路径 */
  path: string;
  kind: OfficePreviewKind;
  /** DOCX 的页 / PPTX 的幻灯片页；XLSX 没有页码 */
  page?: number;
  /** XLSX 的工作表名，例如 Feuil1 */
  sheet?: string;
  /** XLSX 的 A1 单元格或范围，例如 B4 / B4:C6 */
  range?: string;
  /** 选中对象的纯文本；空单元格允许为空字符串 */
  text: string;
  /** OfficeCLI HTML 里的 data-path，可直接交给 officecli get/set */
  pathHint?: string;
  /** 相对页面/幻灯片/工作表内容的归一化位置，0..1 */
  bounds?: OfficeSelectionBounds;
  renderer?: 'officecli-html';
}

const OFFICE = /\.(docx?|docm|pptx?|pptm|xlsx?|xlsm|odt|odp|ods)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const PDF = /\.pdf$/i;

export function isOfficePath(path: string): boolean {
  return OFFICE.test(path.trim());
}

/** 文件标签页只负责代码/文本；这些类型一律走预览标签页。 */
export function isPreviewOnlyPath(path: string): boolean {
  const value = path.trim();
  return isOfficePath(value) || PDF.test(value) || IMAGE.test(value);
}

export function officeKindOf(path: string): OfficePreviewKind {
  const extension = /\.([a-z0-9]+)$/i.exec(path.trim())?.[1]?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'doc' || extension === 'docx' || extension === 'docm' || extension === 'odt') return 'docx';
  if (extension === 'ppt' || extension === 'pptx' || extension === 'pptm' || extension === 'odp') return 'pptx';
  if (extension === 'xls' || extension === 'xlsx' || extension === 'xlsm' || extension === 'ods') return 'xlsx';
  return 'other';
}

/** chip 上的一行定位信息：Sheet!A1 或 第 N 页。 */
export function officeSelectionLabel(selection: OfficeSelection): string {
  if (selection.sheet && selection.range) return `${selection.sheet}!${selection.range}`;
  if (selection.sheet) return selection.sheet;
  if (selection.page) return `第 ${selection.page} 页`;
  return selection.kind === 'pdf' ? 'PDF' : '文档';
}

export function officeSelectionSummary(selection: OfficeSelection): string {
  const text = selection.text.replace(/\s+/g, ' ').trim();
  const excerpt = text.length > 72 ? `${text.slice(0, 72)}…` : text;
  return [officeSelectionLabel(selection), excerpt].filter(Boolean).join(' · ');
}
