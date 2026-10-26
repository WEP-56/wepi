import {
  ExternalLink,
  Eye,
  FileCode2,
  FileQuestionMark,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Presentation,
} from 'lucide-react';
import type { ShowKind, ShowRequest, ShowTarget } from '../lib/show';
import { shellApi } from '../lib/piAdmin';
import { errorText } from '../lib/workspace';
import { cn } from '../utils/cn';

/**
 * `show` 工具执行成功、且回合彻底结束后，在最终回复下方出现的预览入口。
 *
 * 卡片只负责「把用户带到右栏」：真正读取/渲染由 PreviewView 的
 * `show_preview` 完成，所以这里不需要提前加载任何文件内容。
 */

type Icon = typeof Globe;

const meta: Record<ShowKind, { label: string; Icon: Icon; tone: string }> = {
  web: { label: '网页', Icon: Globe, tone: 'text-[var(--blue)]' },
  text: { label: '代码', Icon: FileCode2, tone: 'text-[#d2a8ff]' },
  image: { label: '图片', Icon: ImageIcon, tone: 'text-[#3fb950]' },
  pdf: { label: 'PDF', Icon: FileText, tone: 'text-[#f85149]' },
  office: { label: '文档', Icon: FileText, tone: 'text-[#58a6ff]' },
  file: { label: '文件', Icon: FileQuestionMark, tone: 'text-[var(--text-3)]' },
};

function iconFor(target: ShowTarget): Icon {
  if (target.kind !== 'office') return meta[target.kind].Icon;
  const extension = target.path?.split('.').pop()?.toLowerCase() ?? '';
  if (['pptx', 'pptm', 'ppt', 'odp'].includes(extension)) return Presentation;
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(extension)) return FileSpreadsheet;
  return FileText;
}

function labelFor(target: ShowTarget): string {
  if (target.kind !== 'office') return meta[target.kind].label;
  const extension = target.path?.split('.').pop()?.toLowerCase() ?? '';
  if (['docx', 'docm', 'doc', 'odt'].includes(extension)) return 'Word';
  if (['pptx', 'pptm', 'ppt', 'odp'].includes(extension)) return '演示文稿';
  if (['xlsx', 'xlsm', 'xls', 'ods'].includes(extension)) return '表格';
  return '文档';
}

export default function ShowCards({
  requests,
  onOpen,
  onToast,
}: {
  requests: ShowRequest[];
  onOpen: (target: ShowTarget) => void;
  onToast?: (message: string) => void;
}) {
  if (!requests.length) return null;
  const openSystem = (target: ShowTarget) => {
    const value = target.url ?? target.path;
    if (!value) return;
    shellApi.openWithSystem(value).catch((error) => onToast?.(errorText(error)));
  };
  return (
    <div className="mt-3 space-y-2">
      {requests.map((request) => (
        <div key={request.id} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--bg-hover)] text-[var(--blue)]">
              <Eye size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text)]">
              {request.title || '可预览产物'}
            </span>
            <span className="shrink-0 text-[11px] text-[var(--text-3)]">{request.targets.length} 项</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {request.targets.map((target) => {
              const Icon = iconFor(target);
              return (
                <div
                  key={`${target.kind}:${target.path ?? target.url}`}
                  className="group flex items-center gap-1 px-2 py-1.5 hover:bg-[var(--bg-hover)]"
                >
                  <button
                    onClick={() => onOpen(target)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left"
                  >
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-hover)]', meta[target.kind].tone)}>
                      <Icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-[var(--text)]">{target.name}</span>
                      <span className="block truncate font-mono text-[10.5px] text-[var(--text-3)]" title={target.detail}>
                        {target.detail}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10.5px] text-[var(--text-3)]">{labelFor(target)}</span>
                    <span className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[11.5px] text-[var(--text-2)] group-hover:border-[var(--border-strong)] group-hover:text-[var(--text)]">
                      打开预览
                    </span>
                  </button>
                  <button
                    title="用系统应用打开"
                    onClick={() => openSystem(target)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-3)] opacity-0 hover:bg-[var(--bg-active)] hover:text-[var(--text)] group-hover:opacity-100"
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
