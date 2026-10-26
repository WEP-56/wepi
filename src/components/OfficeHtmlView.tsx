import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { IconBtn } from './ui';
import { officeKindOf, type OfficeSelection } from '../lib/office';

/**
 * OfficeCLI 的 HTML 预览。
 *
 * OfficeCLI 输出的 HTML 已经带 page/slide/sheet 和 data-path；这里只做两件事：
 * 1. 用 sandbox iframe 隔离文档 HTML（文档内容不可信，不能直接进主 React 树）；
 * 2. 注入一个选区脚本，把「段落/单元格 + 位置 + 文本」postMessage 回主窗口。
 *
 * 截图不在点击时同步生成：OfficeCLI 的 range 截图要 10–20 秒，会卡住
 * 「点击→进输入框」；选区的 data-path/文本/页码已经足够 agent 定位。
 */

const SELECTION_SCRIPT = `
(function () {
  try {
    if (window.__wepiOfficeSelect) return;
    var SELECTABLE = 'td[data-path], th[data-path], .para, .shape[data-path], p, li, h1, h2, h3, h4, h5, h6, blockquote, pre';
    var SKIP = '.sidebar, .sheet-tabs, .slide-label, .thumb, .file-title, .col-header, .row-header, .corner-cell';
    var overlay = document.createElement('div');
    overlay.setAttribute('data-wepi-office-highlight', '1');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;display:none;border:2px solid #3b8bf6;background:rgba(59,139,246,.12);border-radius:3px;box-shadow:0 0 0 1px rgba(0,0,0,.28)';
    document.documentElement.appendChild(overlay);

    var state = { enabled: false };

    function elementOf(event) {
      var node = event.target;
      if (!node || node.nodeType !== 1) return null;
      var target = node.closest(SELECTABLE);
      if (!target || target.closest(SKIP)) return null;
      if (target.matches('td, th') && !target.getAttribute('data-path')) return null;
      return target;
    }

    function pathOf(target) {
      var node = target.closest('[data-path]');
      return node ? node.getAttribute('data-path') : undefined;
    }

    function pageOf(target) {
      var page = target.closest('.page[data-page]');
      if (page) return Number(page.getAttribute('data-page')) || undefined;
      var slide = target.closest('.slide-container[data-slide]');
      if (slide) return Number(slide.getAttribute('data-slide')) || undefined;
      return undefined;
    }

    function sheetOf(target) {
      var sheet = target.closest('.sheet-content[data-sheet]');
      if (!sheet) return {};
      var index = sheet.getAttribute('data-sheet');
      var tab = document.querySelector('.sheet-tab[data-sheet="' + index + '"]');
      return { sheet: tab ? (tab.textContent || '').trim() : undefined };
    }

    function rangeOf(path) {
      if (!path) return undefined;
      var parts = path.split('/');
      var last = parts[parts.length - 1] || '';
      return /^[A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?$/.test(last) ? last : undefined;
    }

    function boundsOf(target) {
      var container = target.closest('.page, .slide, .sheet-content') || target;
      var box = container.getBoundingClientRect();
      var rect = target.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return undefined;
      return {
        left: (rect.left - box.left) / box.width,
        top: (rect.top - box.top) / box.height,
        width: rect.width / box.width,
        height: rect.height / box.height
      };
    }

    function textOf(target) {
      return (target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
    }

    function paint(target) {
      var rect = target.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = Math.max(0, rect.width) + 'px';
      overlay.style.height = Math.max(0, rect.height) + 'px';
    }

    function hide() {
      overlay.style.display = 'none';
    }

    function setEnabled(enabled) {
      state.enabled = !!enabled;
      hide();
      document.documentElement.style.cursor = state.enabled ? 'crosshair' : '';
    }

    function onMove(event) {
      if (!state.enabled) return;
      var target = elementOf(event);
      if (target) paint(target);
      else hide();
    }

    function onClick(event) {
      if (!state.enabled) return;
      var target = elementOf(event);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      var pathHint = pathOf(target);
      var sheet = sheetOf(target);
      var payload = {
        page: pageOf(target),
        sheet: sheet.sheet,
        range: rangeOf(pathHint),
        text: textOf(target),
        pathHint: pathHint,
        bounds: boundsOf(target)
      };
      setEnabled(false);
      try {
        parent.postMessage({ type: 'wepi-office-picked', payload: payload }, '*');
      } catch (_) {}
    }

    function onKey(event) {
      if (event.key !== 'Escape' || !state.enabled) return;
      event.preventDefault();
      event.stopPropagation();
      setEnabled(false);
      try {
        parent.postMessage({ type: 'wepi-office-cancel' }, '*');
      } catch (_) {}
    }

    window.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'wepi-office-select') setEnabled(event.data.enabled);
    });
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.__wepiOfficeSelect = state;
  } catch (error) {
    try {
      parent.postMessage({ type: 'wepi-office-error', message: String(error && error.message || error) }, '*');
    } catch (_) {}
  }
})();
`;

function injectSelectionScript(html: string): string {
  const script = `<script>${SELECTION_SCRIPT}<\/script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return `${html}${script}`;
}

const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;

interface PickedPayload {
  page?: number;
  sheet?: string;
  range?: string;
  text?: string;
  pathHint?: string;
  bounds?: OfficeSelection['bounds'];
}

export default function OfficeHtmlView({
  path,
  html,
  onAttachOffice,
  onError,
}: {
  path: string;
  html: string;
  onAttachOffice?: (selection: OfficeSelection) => void;
  onError?: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [ready, setReady] = useState(false);
  const srcDoc = useMemo(() => injectSelectionScript(html), [html]);

  const sendSelectionMode = useCallback((enabled: boolean) => {
    frame.current?.contentWindow?.postMessage({ type: 'wepi-office-select', enabled }, '*');
  }, []);

  useEffect(() => {
    if (!ready) return;
    sendSelectionMode(selecting);
  }, [ready, selecting, sendSelectionMode]);

  const pick = useCallback(
    (payload: PickedPayload) => {
      setSelecting(false);
      onAttachOffice?.({
        path,
        kind: officeKindOf(path),
        page: payload.page,
        sheet: payload.sheet,
        range: payload.range,
        text: payload.text ?? '',
        pathHint: payload.pathHint,
        bounds: payload.bounds,
        renderer: 'officecli-html',
      });
    },
    [onAttachOffice, path],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; payload?: PickedPayload; message?: string } | null;
      if (!data) return;
      if (data.type === 'wepi-office-picked' && data.payload) pick(data.payload);
      if (data.type === 'wepi-office-cancel') setSelecting(false);
      if (data.type === 'wepi-office-error') onError?.(data.message || '文档选区脚本失败');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onError, pick]);

  useEffect(() => {
    setSelecting(false);
    setReady(false);
  }, [html]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-hover)] px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-3)]">
          {selecting ? '移动到段落/单元格上高亮，点击加入输入框；Esc 退出' : 'OfficeCLI 渲染；复杂版式可右上角用系统应用打开'}
        </span>
        {onAttachOffice && (
          <IconBtn
            title={selecting ? '退出选择（Esc）' : '选择文档内容'}
            active={selecting}
            onClick={() => setSelecting((value) => !value)}
          >
            <Crosshair size={14} />
          </IconBtn>
        )}
      </div>
      <iframe
        ref={frame}
        title={`${basename(path)} 预览`}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        onLoad={() => {
          setReady(true);
          sendSelectionMode(selecting);
        }}
      />
    </div>
  );
}
