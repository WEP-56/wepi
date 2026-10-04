import { isDesktopRuntime } from './piRpc';

export interface PickedDir {
  name: string;
  path: string;
}

/**
 * 选择本地目录。
 *
 * - 桌面端（Tauri）：原生目录选择对话框（dialog 插件，系统风格），
 *   返回绝对路径。绝不使用 WebView 的 File System Access API——它在
 *   WebView2 中会弹「是否允许此网站查看和复制文件」的浏览器式权限
 *   提示，且只能拿到文件夹名、拿不到绝对路径。
 * - 浏览器预览：File System Access API（Chromium）→ <input webkitdirectory>。
 */
export async function pickDirectory(): Promise<PickedDir | null> {
  // 桌面端：系统原生对话框。
  if (isDesktopRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title: '选择项目文件夹' });
    if (typeof selected === 'string' && selected) {
      return { name: folderName(selected), path: selected };
    }
    return null;
  }

  // 浏览器预览：能拿到的只有文件夹名（无绝对路径）。
  const w = window as unknown as {
    showDirectoryPicker?: (o?: object) => Promise<{ name: string }>;
  };
  if (typeof w.showDirectoryPicker === 'function') {
    try {
      const h = await w.showDirectoryPicker({ mode: 'read' });
      return { name: h.name, path: h.name };
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return null;
      // 在受限 iframe 中会抛 SecurityError，继续走回退方案
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.onchange = () => {
      const f = input.files?.[0] as (File & { webkitRelativePath?: string }) | undefined;
      const name = f?.webkitRelativePath?.split('/')[0];
      resolve(name ? { name, path: name } : null);
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const looksAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|\/|\\\\|~)/.test(p);
