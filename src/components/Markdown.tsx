import { memo, type ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const k = keyBase + i;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1)
      return (
        <code key={k} className="mx-[1px] rounded-[5px] bg-[var(--bg-code)] px-[5px] py-[1px] font-mono text-[12.5px] text-[var(--text)]">
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith('**') && p.endsWith('**'))
      return (
        <strong key={k} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    return <span key={k}>{p}</span>;
  });
}

function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (i: number) => {
    if (list.length) {
      blocks.push(
        <ul key={'ul' + i} className="my-1.5 list-disc space-y-0.5 pl-7 marker:text-[var(--text)]">
          {list.map((l, j) => (
            <li key={j}>{inline(l, `l${i}-${j}-`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  lines.forEach((line, i) => {
    if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ''));
    } else {
      flush(i);
      if (line.trim()) blocks.push(<p key={'p' + i} className="my-1.5">{inline(line, `p${i}-`)}</p>);
    }
  });
  flush(lines.length);
  return <div className={'text-[14px] leading-[24px] text-[var(--text)] ' + (caret ? 'caret' : '')}>{blocks}</div>;
}

// 流式期间父组件每个批次都会重渲染，未变动的消息靠 memo 跳过整段 Markdown 解析。
export default memo(Markdown);
