import { memo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * 轻量 Markdown 渲染器。
 *
 * 目标是覆盖 Pi 实际输出的形态（标题、围栏代码块、嵌套「粗体 + 行内代码」、
 * 有序/无序列表、表格、引用、分隔线、链接），而不是完整实现 CommonMark。
 * 不引入 remark/shiki 等依赖：本应用以单文件方式打包，体积代价过高。
 */

const CODE_CLASS = 'mx-[1px] rounded-[5px] bg-[var(--bg-code)] px-[5px] py-[1px] font-mono text-[12.5px] text-[var(--text)]';

/**
 * 行内渲染，解析顺序很关键：
 *   粗体/删除线 → 行内代码/链接 → 斜体
 * 必须先切粗体再切行内代码，否则 `**\`code\`**` 里的 `**` 会与被切开的
 * 代码段各自成块、无法配对，最终把 `**` 当成普通字符渲染出来。
 */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const strongParts = text.split(/(\*\*[^*]+\*\*|~~[^~]+~~)/g);
  strongParts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyBase}s${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderCodeLinksItalic(part.slice(2, -2), `${key}-`)}
        </strong>,
      );
      return;
    }
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
      nodes.push(
        <span key={key} className="line-through opacity-70">
          {renderCodeLinksItalic(part.slice(2, -2), `${key}-`)}
        </span>,
      );
      return;
    }
    nodes.push(...renderCodeLinksItalic(part, `${key}-`));
  });
  return nodes;
}

const CODE_CLASS_LOCAL = CODE_CLASS;

/** 行内代码与链接（可出现在粗体内部）。 */
function renderCodeLinksItalic(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(/(`+[^`]+`+|\[[^\]]+\]\([^)\s]+\))/g);
  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyBase}c${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code key={key} className={CODE_CLASS_LOCAL}>
          {part.replace(/^`+/, '').replace(/`+$/, '')}
        </code>,
      );
      return;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      nodes.push(
        <a
          key={key}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--blue)] underline underline-offset-2 hover:opacity-80"
        >
          {link[1]}
        </a>,
      );
      return;
    }
    // 斜体：单星号/下划线成对出现才生效，避免误伤标识符里的 * 和 _。
    const italicParts = part.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
    italicParts.forEach((piece, j) => {
      if (!piece) return;
      const ikey = `${key}t${j}`;
      const isItalic =
        (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) ||
        (piece.startsWith('_') && piece.endsWith('_') && piece.length > 2);
      nodes.push(isItalic ? <em key={ikey} className="italic">{piece.slice(1, -1)}</em> : <span key={ikey}>{piece}</span>);
    });
  });
  return nodes;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-3)]">
        <span className="font-mono">{language || 'text'}</span>
        <span className="flex-1" />
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="scroll-thin overflow-x-auto px-3 py-2">
        <pre className="font-mono text-[12px] leading-[19px] whitespace-pre text-[var(--text-2)]">{code}</pre>
      </div>
    </div>
  );
}

function isTableSeparator(line: string) {
  return /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes('-');
}

const splitRow = (line: string) =>
  line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());

function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (key: string) => {
    if (!list) return;
    const items = list.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}-`)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={key} className="my-1.5 list-decimal space-y-0.5 pl-7 marker:text-[var(--text-2)]">{items}</ol>
      ) : (
        <ul key={key} className="my-1.5 list-disc space-y-0.5 pl-7 marker:text-[var(--text)]">{items}</ul>
      ),
    );
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 围栏代码块：吞掉 ``` 行，内部原样输出
    const fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushList(`ul${i}`);
      const language = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push(<CodeBlock key={`code${i}`} code={body.join('\n')} language={language} />);
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList(`ul${i}`);
      const level = heading[1].length;
      const content = renderInline(heading[2], `h${i}-`);
      const cls =
        level === 1
          ? 'mt-4 mb-2 text-[19px] font-semibold'
          : level === 2
            ? 'mt-4 mb-1.5 text-[16.5px] font-semibold'
            : level === 3
              ? 'mt-3 mb-1 text-[15px] font-semibold'
              : 'mt-2.5 mb-1 text-[14px] font-semibold';
      const Tag = (`h${Math.min(level, 6)}`) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={`h${i}`} className={cls}>{content}</Tag>);
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList(`ul${i}`);
      blocks.push(<hr key={`hr${i}`} className="my-3 border-[var(--border)]" />);
      continue;
    }

    // 引用
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushList(`ul${i}`);
      const body: string[] = [quote[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
        i += 1;
        body.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      blocks.push(
        <blockquote key={`q${i}`} className="my-2 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-2)]">
          {body.map((l, j) => <p key={j} className="my-0.5">{renderInline(l, `q${i}-${j}-`)}</p>)}
        </blockquote>,
      );
      continue;
    }

    // 表格：表头 + 分隔行 + 数据行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList(`ul${i}`);
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push(
        <div key={`tbl${i}`} className="scroll-thin my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {header.map((cell, j) => (
                  <th key={j} className="border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-left font-semibold">
                    {renderInline(cell, `th${i}-${j}-`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c} className="border border-[var(--border)] px-2 py-1 align-top">
                      {renderInline(row[c] ?? '', `td${i}-${r}-${c}-`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // 任务列表 / 无序列表 / 有序列表
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      flushList(`ul${i}`);
      blocks.push(
        <div key={`task${i}`} className="my-0.5 flex items-start gap-2 pl-1">
          <input type="checkbox" checked={task[1].toLowerCase() === 'x'} readOnly className="mt-[5px]" />
          <span>{renderInline(task[2], `tk${i}-`)}</span>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list?.ordered) flushList(`ul${i}`);
      list = list ?? { ordered: false, items: [] };
      list.items.push(bullet[1]);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (list && !list.ordered) flushList(`ul${i}`);
      list = list ?? { ordered: true, items: [] };
      list.items.push(numbered[1]);
      continue;
    }

    flushList(`ul${i}`);
    if (line.trim()) {
      blocks.push(<p key={`p${i}`} className="my-1.5">{renderInline(line, `p${i}-`)}</p>);
    }
  }
  flushList(`ul${lines.length}`);

  return <div className={'text-[14px] leading-[24px] text-[var(--text)] ' + (caret ? 'caret' : '')}>{blocks}</div>;
}

// 流式期间父组件每个批次都会重渲染，未变动的消息靠 memo 跳过整段解析。
export default memo(Markdown);
