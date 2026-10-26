import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FileQuestionMark, FolderOpen, LoaderCircle, RefreshCw, ScanEye } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { IconBtn } from './ui';
import OfficeHtmlView from './OfficeHtmlView';
import { errorText } from '../lib/workspace';
import { shellApi } from '../lib/piAdmin';
import { isDesktopRuntime } from '../lib/piRpc';
import type { OfficeSelection } from '../lib/office';
import type { ShowPreview } from '../lib/show';

/**
 * `show` 卡片的右栏预览。
 *
 * 文件可能在工作区外（agent 产出的临时目录），所以走独立的
 * `show_preview`，不复用 workspace_request 的根目录约束。
 * Office 文档由 OfficeCLI 渲染成 HTML；失败时仍给「用系统应用打开」兜底。
 */

const TEXT_LINE_LIMIT = 4000;
const actionClass =
  'flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-hover)] px-2.5 text-[12px] text-[var(--text)] transition-colors hover:bg-[var(--bg-active)] disabled:opacity-40';

const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;

function TextPreview({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const visible = lines.slice(0, TEXT_LINE_LIMIT);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      <div className="min-w-max py-2 font-mono text-[12px] leading-5 text-[var(--text-2)]">
        {visible.map((text, index) => (
          <div key={index} className="flex">
            <span className="sticky left-0 z-10 w-10 shrink-0 select-none bg-[var(--bg-main)] pr-2 text-right text-[11px] text-[var(--text-3)]">
              {index + 1}
            </span>
            <span className="whitespace-pre pl-3 pr-4">{text || ' '}</span>
          </div>
        ))}
      </div>
      {lines.length > TEXT_LINE_LIMIT && (
        <div className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1.5 text-[11.5px] text-[var(--text-3)]">
          仅显示前 {TEXT_LINE_LIMIT} 行，共 {lines.length} 行；完整内容请用系统应用打开。
        </div>
      )}
    </div>
  );
}

export default function PreviewView({
  path,
  active,
  onAttachOffice,
}: {
  path?: string;
  active: boolean;
  onAttachOffice?: (selection: OfficeSelection) => void;
}) {
  const [data, setData] = useState<ShowPreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [pdfUrl, setPdfUrl] = useState('');
  const loaded = useRef<{ path?: string; nonce: number }>({ nonce: -1 });

  useEffect(() => {
    if (!active || !path || !isDesktopRuntime()) return;
    if (loaded.current.path === path && loaded.current.nonce === nonce) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    invoke<ShowPreview>('show_preview', { path })
      .then((next) => {
        if (cancelled) return;
        loaded.current = { path, nonce };
        setData(next);
      })
      .catch((cause) => {
        if (cancelled) return;
        // 失败也记成已加载：用户可以用刷新按钮重试，但切标签页不该反复打 IPC。
        loaded.current = { path, nonce };
        setData(null);
        setError(errorText(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, path, nonce]);

  // PDF 用 blob URL 而不是 data URL：WebView2 的内置阅读器对 blob 更稳，
  // 也避免把几十 MB 的 base64 直接塞进 iframe 的 src。
  useEffect(() => {
    if (data?.kind !== 'pdf') {
      setPdfUrl('');
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(data.data), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      setPdfUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch (cause) {
      setError(`PDF 数据解码失败：${errorText(cause)}`);
      setPdfUrl('');
      return;
    }
  }, [data]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const openSystem = useCallback(() => {
    if (!path) return;
    shellApi.openWithSystem(path).catch((cause) => setError(errorText(cause)));
  }, [path]);
  const reveal = useCallback(() => {
    if (!path) return;
    shellApi.showInExplorer(path).catch((cause) => setError(errorText(cause)));
  }, [path]);

  if (!isDesktopRuntime()) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--text-3)]">
        浏览器预览模式不提供本地文件预览，请运行桌面端。
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <ScanEye size={14} className="shrink-0 text-[var(--text-2)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-2)]" title={path}>
          {path ? basename(path) : '预览'}
        </span>
        {loading && <LoaderCircle size={13} className="shrink-0 animate-spin text-[var(--text-3)]" />}
        <IconBtn title="刷新预览" onClick={reload}>
          <RefreshCw size={13} />
        </IconBtn>
        <IconBtn title="用系统应用打开" onClick={openSystem}>
          <ExternalLink size={13} />
        </IconBtn>
        <IconBtn title="在文件夹中显示" onClick={reveal}>
          <FolderOpen size={13} />
        </IconBtn>
      </div>
      {error && <div className="shrink-0 border-b border-[var(--border)] px-3 py-2 text-[12px] text-[#f85149]">{error}</div>}
      {loading && !data && (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12.5px] text-[var(--text-3)]">
          <LoaderCircle size={14} className="animate-spin" />
          正在生成预览…
        </div>
      )}
      {!loading && !data && !error && (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[13px] text-[var(--text-3)]">
          没有可预览的内容
        </div>
      )}
      {data?.kind === 'text' && <TextPreview content={data.content} />}
      {data?.kind === 'image' && (
        <div className="scroll-thin flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--bg-hover)] p-4">
          <img
            src={data.dataUrl}
            alt={basename(data.path)}
            className="max-h-full max-w-full object-contain"
            onError={() => setError('图片无法解码，请用系统应用打开')}
          />
        </div>
      )}
      {data?.kind === 'html' && (
        <OfficeHtmlView
          path={data.path}
          html={data.html}
          onAttachOffice={onAttachOffice}
          onError={(message) => setError(message)}
        />
      )}
      {data?.kind === 'pdf' && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-hover)] px-3 py-1 text-[11px] text-[var(--text-3)]">
          内嵌阅读器不可用时，请用右上角「用系统应用打开」。
        </div>
      )}
      {data?.kind === 'pdf' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#525659]">
          {pdfUrl ? (
            <iframe title="PDF 预览" src={pdfUrl} className="min-h-0 flex-1 border-0" />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-[12.5px] text-[var(--text-3)]">
              PDF 加载失败，请用系统应用打开。
            </div>
          )}
        </div>
      )}
      {data?.kind === 'unsupported' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileQuestionMarkIcon />
          <div className="max-w-[320px] text-[13px] leading-5 text-[var(--text-2)]">{data.message}</div>
          <div className="flex gap-2">
            <button className={actionClass} onClick={openSystem}>
              <ExternalLink size={13} /> 用系统应用打开
            </button>
            <button className={actionClass} onClick={reveal}>
              <FolderOpen size={13} /> 在文件夹中显示
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FileQuestionMarkIcon() {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--bg-hover)] text-[var(--text-3)]">
      <FileQuestionMark size={22} />
    </span>
  );
}
