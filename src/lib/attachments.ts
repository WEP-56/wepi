import { uid, type Attachment } from '../data';
import { isDesktopRuntime, readImageDataUrl, saveTempImage } from './piRpc';

/* ------------------------------------------------------------------ */
/*  类型判定                                                            */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

export const isImagePath = (path: string) => IMAGE_EXT.test(path.trim());

export const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

const isDataUrl = (value: string) => value.startsWith('data:');

/* ------------------------------------------------------------------ */
/*  构造附件                                                            */
/* ------------------------------------------------------------------ */

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 由浏览器 File（粘贴 / 浏览器端拖拽）构造附件：图片读成 data URL。 */
export async function attachmentFromFile(file: File): Promise<Attachment> {
  const id = uid();
  const path = (file as File & { path?: string }).path;
  if (file.type.startsWith('image/')) {
    const value = await readFileAsDataUrl(file);
    return { id, kind: 'image', name: file.name || '粘贴的图片', value, path };
  }
  return { id, kind: 'file', name: file.name, value: path || file.name, path };
}

/**
 * 由磁盘绝对路径构造附件（原生拖拽 / 文件选择器）。
 * 图片会立即读出 data URL 以便预览；读取失败时降级为文件附件，不让整体失败。
 */
export async function attachmentFromPath(path: string): Promise<Attachment> {
  const name = baseName(path);
  if (!isImagePath(path)) return { id: uid(), kind: 'file', name, value: path, path };
  const value = await resolveImageSrc({ id: '', kind: 'image', name, value: '', path });
  if (!value) return { id: uid(), kind: 'file', name, value: path, path };
  return { id: uid(), kind: 'image', name, value, path };
}

/* ------------------------------------------------------------------ */
/*  图片源解析（带内存缓存）                                             */
/* ------------------------------------------------------------------ */

const srcCache = new Map<string, Promise<string | null>>();

/**
 * 取得图片可渲染的 src：
 * - 已有 data URL / blob / http 直接使用；
 * - 持久化后 data URL 被剥离、只剩 path 时，按需从磁盘重新读取（桌面端）。
 */
export function resolveImageSrc(att: Attachment): Promise<string | null> {
  if (att.value && (isDataUrl(att.value) || /^(blob:|https?:)/.test(att.value))) {
    return Promise.resolve(att.value);
  }
  if (!att.path || !isDesktopRuntime()) return Promise.resolve(null);
  const cached = srcCache.get(att.path);
  if (cached) return cached;
  const task = readImageDataUrl(att.path).catch(() => null);
  srcCache.set(att.path, task);
  return task;
}

/* ------------------------------------------------------------------ */
/*  剪贴板                                                              */
/* ------------------------------------------------------------------ */

/** 从剪贴板事件中取出图片附件（截图粘贴的主要入口）。 */
export async function attachmentsFromClipboard(data: DataTransfer | null): Promise<Attachment[]> {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith('image/')) files.push(file);
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  const seen = new Set<string>();
  const unique = files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Promise.all(unique.map(attachmentFromFile));
}

/* ------------------------------------------------------------------ */
/*  文件选择器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 打开系统文件选择器。
 * - 桌面端：dialog 插件，拿到绝对路径（Pi 需要它才能读到文件）。
 * - 浏览器：<input type=file>，只能拿到文件名与内容。
 */
export async function pickAttachments(accept: 'image' | 'any'): Promise<Attachment[]> {
  const filters = accept === 'image'
    ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    : undefined;
  if (isDesktopRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ multiple: true, directory: false, title: accept === 'image' ? '选择图片' : '选择文件', filters });
    const paths = (Array.isArray(selected) ? selected : selected ? [selected] : []).filter((p): p is string => typeof p === 'string' && !!p);
    return Promise.all(paths.map(attachmentFromPath));
  }
  return new Promise<Attachment[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept === 'image') input.accept = 'image/*';
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(await Promise.all(files.map(attachmentFromFile)));
    };
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/* ------------------------------------------------------------------ */
/*  持久化与提示词                                                       */
/* ------------------------------------------------------------------ */

/**
 * 写入 localStorage 前剥离图片的 data URL：
 * 单张截图动辄数 MB，会把整个 store 的配额撑爆（配额失败是静默的，
 * 会让会话本身也停止落盘）。图片保留 path，重启后按需重新读取。
 */
export function forPersistence(attachments: Attachment[]): Attachment[] {
  return attachments.map((att) => (att.kind === 'image' && isDataUrl(att.value) ? { ...att, value: '' } : att));
}

/**
 * 发送前补齐图片的磁盘路径：粘贴的图片没有来源路径，
 * 桌面端先落盘到临时目录，Pi 才能按路径真正读到它。
 */
export async function ensureAttachmentPaths(attachments: Attachment[]): Promise<Attachment[]> {
  if (!isDesktopRuntime()) return attachments;
  return Promise.all(attachments.map(async (att) => {
    if (att.kind !== 'image' || att.path || !isDataUrl(att.value)) return att;
    try {
      return { ...att, path: await saveTempImage(att.value) };
    } catch {
      return att;
    }
  }));
}

/** 附件进入提示词的可读形式：路径优先，供 Agent 读取。 */
export function attachmentPromptBlock(attachments: Attachment[]): string {
  const lines = attachments.map((att) => {
    const target = att.path || att.value;
    return `- ${att.kind === 'image' ? '图片' : '文件'}：${target}`;
  });
  return lines.length ? `\n\n附件：\n${lines.join('\n')}` : '';
}
