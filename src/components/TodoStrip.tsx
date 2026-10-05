import { useState } from 'react';
import { ChevronDown, ChevronUp, ListChecks } from 'lucide-react';
import type { TodoWidgetItem } from '../lib/extensionUi';

/**
 * 输入框上方的 todo 常驻条（对齐 PiDeck SessionTodoStrip 的形态）。
 *
 * 折叠时一行：图标 + 进度文案 + chevron；展开显示完整条目列表（max-h 滚动）。
 * 纯文字无边框：与输入框区域保持留白衔接，不画分隔线（此前 border-b 与
 * 输入框上边缘重合形成双线，已删）。
 *
 * 数据快照保留在会话侧（数据不丢）；本组件只管呈现——**全部完成时整体
 * 隐藏**（悬空的「3/3」对用户是噪音；PiDeck 的 todo 条同款语义：内容
 * 指纹变化才重新出现）。想再看时可让 AI 调 todo list。
 */
export function TodoStrip({ items }: { items: TodoWidgetItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const completed = items.filter((item) => item.status === 'completed').length;
  // 全部完成：任务收尾，视觉隐藏（数据仍在，未完成项出现时自然恢复显示）。
  if (completed === items.length) return null;

  return (
    <div className="mb-1.5">
      <button
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] text-[var(--text-2)] hover:text-[var(--text)]"
        onClick={() => setExpanded((value) => !value)}
      >
        <ListChecks size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate font-medium">
          待办计划 {completed}/{items.length}
        </span>
        {expanded ? <ChevronUp size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
      </button>
      {expanded ? (
        <ul className="scroll-thin max-h-[180px] overflow-y-auto px-2 pb-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 py-0.5 text-[12.5px]">
              <span
                className={
                  item.status === 'completed'
                    ? 'shrink-0 text-[var(--text-3)]'
                    : item.status === 'in_progress'
                      ? 'shrink-0 text-[var(--accent)]'
                      : 'shrink-0 text-[var(--text-3)]'
                }
              >
                {item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'}
              </span>
              <span className={item.status === 'completed' ? 'min-w-0 flex-1 text-[var(--text-3)] line-through' : 'min-w-0 flex-1 text-[var(--text)]'}>
                <span className="mr-1 font-mono text-[11px] text-[var(--text-3)]">#{item.id}</span>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
