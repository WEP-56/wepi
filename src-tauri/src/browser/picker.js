/*
 * WEPI 页面元素拾取：注入内置浏览器的子 webview（eval 执行，页面本身没有应用 IPC）。
 *
 * 契约：
 * - Rust 侧用 __WEPI_PICK_KEY__ 替换出一个页面内唯一的键，把状态挂到 globalThis[key]；
 * - 用户点选后 state.result 变成元素快照，Rust 每 250ms 轮询读取，读到即收工；
 * - Esc 或 Rust 主动调用 state.cancel() 时 result 变成 { cancelled: true }。
 *
 * 注意：Windows 的 WebView2 ExecuteScript 会吞掉脚本异常、只回 null，
 * 所以这里整体包在 try/catch 里，任何失败都表现为「没结果」，由 Rust 超时兜底。
 */
((key) => {
  try {
    const previous = globalThis[key];
    if (previous && typeof previous.cancel === 'function') previous.cancel();

    const state = { result: null, cancel: () => finish(null) };
    globalThis[key] = state;

    const ACCENT = '#3b8bf6';
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;display:none;border:2px solid ' + ACCENT +
      ';background:rgba(59,139,246,.12);border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.35)';
    (document.documentElement || document.body).appendChild(overlay);

    // 表单值、可编辑文本、脚本、隐藏节点一律不进快照——这些既可能是隐私，也不该进提示词。
    const sensitive = 'input,textarea,select,option,script,style,noscript,[contenteditable],[hidden],[aria-hidden="true"]';
    const clean = (value, max) =>
      String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const escape = (value) =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /** 最近的、点得中的元素：穿透 shadow DOM 与覆盖层。 */
    function targetOf(event) {
      const path = event.composedPath ? event.composedPath() : [event.target];
      return path.find((node) => node instanceof Element && node !== overlay) || null;
    }

    /** CSS 路径：最多 6 层，遇到唯一 id 提前收尾。 */
    function selectorOf(element) {
      const parts = [];
      for (let node = element; node instanceof Element && parts.length < 6; node = node.parentElement) {
        let part = node.localName;
        if (node.id) {
          parts.unshift(part + '#' + CSS.escape(node.id));
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
      }
      return clean(parts.join(' > '), 1000);
    }

    /** 元素自身的可见文本，跳过敏感子树，最多 1200 字符。 */
    function textOf(element) {
      if (element.closest(sensitive)) return '';
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts = [];
      let length = 0;
      let count = 0;
      let node;
      while ((node = walker.nextNode()) && count++ < 500 && length < 1200) {
        if (node.parentElement && node.parentElement.closest(sensitive)) continue;
        const value = clean(node.textContent, 1200 - length);
        if (value) {
          parts.push(value);
          length += value.length + 1;
        }
      }
      return clean(parts.join(' '), 1200);
    }

    function finish(result) {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('click', onChoose, true);
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      state.result = result || { cancelled: true };
      state.cancel = null;
    }

    function onMove(event) {
      const element = targetOf(event);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = rect.left + 'px';
      overlay.style.top = rect.top + 'px';
      overlay.style.width = Math.max(0, rect.width) + 'px';
      overlay.style.height = Math.max(0, rect.height) + 'px';
    }

    function onChoose(event) {
      const element = targetOf(event);
      if (!element) return;
      // 吞掉这一次点击：拾取不该顺带触发页面跳转或按钮。
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = element.getBoundingClientRect();
      const tag = clean(element.localName, 80);
      const content = textOf(element);
      const attributes = ['id', 'class', 'role', 'aria-label', 'data-testid']
        .map((name) => {
          const value = clean(element.getAttribute(name), 180);
          return value ? ' ' + name + '="' + escape(value) + '"' : '';
        })
        .join('');
      finish({
        url: clean(location.href, 4096),
        title: clean(document.title, 300),
        selector: selectorOf(element),
        tag,
        text: content,
        html: '<' + tag + attributes + '>' + escape(content) + '</' + tag + '>',
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }

    function onKeydown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    }

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onChoose, true);
    document.addEventListener('keydown', onKeydown, true);
  } catch (error) {
    // 交给 Rust 侧的超时兜底：页面不可写时拾取会自然结束。
  }
})(__WEPI_PICK_KEY__);