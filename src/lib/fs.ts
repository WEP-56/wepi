export interface PickedDir {
  name: string;
  path: string;
}

/**
 * 选择本地目录。
 *
 * - 桌面端（Tauri / Electron）：在 preload 中暴露 `window.wepi.pickDirectory()`，返回绝对路径即可。
 *     Tauri:    `open({ directory: true })`
 *     Electron: `dialog.showOpenDialog({ properties: ['openDirectory'] })`
 * - 浏览器（Chromium）：使用 File System Access API，只能拿到文件夹名称，拿不到绝对路径。
 * - 其他浏览器：回退到 <input webkitdirectory>。
 */
export async function pickDirectory(): Promise<PickedDir | null> {
  const w = window as unknown as {
    wepi?: { pickDirectory?: () => Promise<PickedDir | null> };
    showDirectoryPicker?: (o?: object) => Promise<{ name: string }>;
  };

  if (w.wepi?.pickDirectory) return w.wepi.pickDirectory();

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
