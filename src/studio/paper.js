/**
 * 让 iframe 里那张纸变得可以直接改。
 *
 * iframe 是 srcdoc 装的、同源,所以能直接操作里面的 document,
 * 不用 postMessage 来回传。往里注入的所有 UI(操作轨、插入指示线)
 * 都只活在这个 iframe 的 DOM 里,导出走的是服务端重新渲染,
 * 这些编辑期的装饰不可能漏进产物。
 */

import { getAt, isMarkupField, isOptional, isContinuable, focusFieldOfType, rowPathOfField, rowType, label, missingFields } from './model.js';
import { tokens, fromTokens, isSafeUrl } from '/src/markup.js';

/** 注入到 iframe 里的编辑期样式 */
const EDIT_CSS = `
[data-bind]{
  cursor:text;
  border-radius:2px;
  transition:background .12s;
}
/* 悬停只淡淡提示一下可以点，不画框 */
[data-bind]:hover{background:rgba(79,179,168,.08)}
/* 编辑时和纸面完全一样：不换底色、不画框，只有光标 */
[data-bind].sk-editing{
  background:transparent;
  outline:0;
  cursor:text;
  caret-color:#2E8C82;
}
[data-bind].sk-editing a{cursor:text}
/* 越过纸边、会被裁掉的那几格 */
[data-bind].sk-cut{
  background:rgba(217,97,76,.16) !important;
  box-shadow:0 0 0 1.5px rgba(217,97,76,.55) !important;
}
#sk-fit{
  position:absolute;z-index:38;display:none;height:0;
  border-top:1.5px dashed;pointer-events:none;
  font:500 10.5px/1 -apple-system,BlinkMacSystemFont,sans-serif;
}
#sk-fit span{
  position:absolute;right:0;bottom:3px;padding:3px 6px;border-radius:4px;
  color:#fff;white-space:nowrap;
}
#sk-fit.clipped{display:block;border-color:#D9614C}
#sk-fit.clipped span{background:#D9614C}
#sk-fit.tight{display:block;border-color:#D9A23C}
#sk-fit.tight span{background:#D9A23C}
#sk-link{
  position:absolute;z-index:41;display:none;
  padding:3px;background:#25292E;border:1px solid #3D444C;border-radius:6px;
  box-shadow:0 3px 12px rgba(0,0,0,.34);
}
#sk-link.on{display:block}
#sk-link input{
  width:260px;padding:4px 7px;border:1px solid #3D444C;border-radius:4px;
  background:#1B1E22;color:#E8E6E3;outline:0;
  font:12px -apple-system,BlinkMacSystemFont,sans-serif;
}
#sk-link input:focus{border-color:#4FB3A8}
#sk-link input.bad{border-color:#D9614C}
@media print{#sk-rail,#sk-drop,#sk-fit,#sk-link,#sk-more,#sk-tip{display:none !important}}
/* 拖动时被拖的那块变淡，整页是抓手 */
[data-row].sk-dragging{opacity:.35}
html.sk-grabbing,html.sk-grabbing *{cursor:grabbing !important}
/* 侧栏点章节跳过来时闪一下 */
[data-row].sk-flash{background:rgba(79,179,168,.14);transition:background .6s}

/* 块把手：浮在块左边的页边里，淡灰图标，没有底色 */
#sk-rail{
  position:absolute;z-index:40;display:none;gap:0;
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;
}
#sk-rail.on{display:flex}
#sk-rail button{
  width:18px;height:22px;padding:0;border:0;border-radius:4px;
  background:none;color:rgba(55,53,47,.38);cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:background .1s,color .1s;
}
#sk-rail button:hover{background:rgba(55,53,47,.08);color:rgba(55,53,47,.72)}
#sk-rail button[data-act="grip"]{cursor:grab;width:16px}
#sk-rail.above button{height:16px;width:16px}
#sk-rail svg{display:block}

/* ⠿ 的菜单，跟纸面一个调子 */
#sk-more{
  position:absolute;z-index:42;display:none;min-width:150px;
  padding:4px;background:#fff;border-radius:7px;
  box-shadow:0 0 0 1px rgba(15,15,15,.06),0 3px 6px rgba(15,15,15,.1),0 9px 24px rgba(15,15,15,.16);
  font:13px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#37352F;
}
#sk-more.on{display:block}
#sk-more .hd{padding:6px 8px 5px;font-size:11px;color:rgba(55,53,47,.5)}
#sk-more hr{border:0;border-top:1px solid rgba(55,53,47,.09);margin:4px 0}
#sk-more button{
  display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:4px;
  background:none;color:inherit;text-align:left;cursor:pointer;font:inherit;
}
#sk-more button:hover{background:rgba(55,53,47,.07)}
#sk-more button svg{flex:none;color:rgba(55,53,47,.55)}
#sk-more button.danger:hover{background:rgba(235,87,87,.1);color:#D44C47}
#sk-more button.danger:hover svg{color:#D44C47}

/* 链接悬停卡片 */
#sk-tip{
  position:absolute;z-index:41;display:none;align-items:center;gap:6px;
  padding:4px 4px 4px 9px;background:#fff;border-radius:6px;
  box-shadow:0 0 0 1px rgba(15,15,15,.06),0 2px 4px rgba(15,15,15,.1),0 6px 16px rgba(15,15,15,.14);
  font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:rgba(55,53,47,.65);
  white-space:nowrap;
}
#sk-tip.on{display:flex}
#sk-tip button{
  display:flex;align-items:center;gap:3px;padding:4px 7px;border:0;border-radius:4px;
  background:rgba(55,53,47,.06);color:#37352F;cursor:pointer;font:inherit;
}
#sk-tip button:hover{background:rgba(55,53,47,.12)}
#sk-tip kbd{font:inherit;color:rgba(55,53,47,.4)}

#sk-drop{
  position:absolute;z-index:39;display:none;height:2px;
  background:#4FB3A8;border-radius:2px;
  box-shadow:0 0 5px rgba(79,179,168,.7);
}
#sk-drop.on{display:block}
`;

/**
 * @param {HTMLIFrameElement} frame
 * @param {object} ctx
 * @param {() => object} ctx.data              取当前数据
 * @param {(path, value) => void} ctx.onEdit   某个字段改了
 * @param {(act, rowPath, extra) => void} ctx.onStructure  加/删/移
 * @param {(rect|null) => void} ctx.onSelect   选中范围变了（格式条跟着走）
 * @param {() => void} ctx.onSave              触发保存
 */
export function mount(frame, ctx) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body) return;

  const style = doc.createElement('style');
  style.id = 'sk-edit-css';
  style.textContent = EDIT_CSS;
  doc.head.appendChild(style);

  const rail = buildRail(doc);
  const drop = doc.createElement('div');
  drop.id = 'sk-drop';
  const fitLine = doc.createElement('div');
  fitLine.id = 'sk-fit';
  fitLine.innerHTML = '<span></span>';
  const linkBox = doc.createElement('div');
  linkBox.id = 'sk-link';
  linkBox.innerHTML = '<input type="text" placeholder="链接地址，回车确定；清空后回车 = 去掉链接" spellcheck="false">';
  const linkInput = linkBox.querySelector('input');
  const more = doc.createElement('div');
  more.id = 'sk-more';
  const linkTip = doc.createElement('div');
  linkTip.id = 'sk-tip';
  linkTip.innerHTML = `<span class="u"></span><button data-act="open" title="在浏览器里打开">打开 ${ICON.out}</button><kbd>⌘ 点击</kbd>`;
  doc.body.append(rail, drop, fitLine, linkBox, more, linkTip);

  let hotRow = null; // 鼠标下面那一行
  let editing = null; // 正在编辑的元素
  let linkState = null; // ⌘K 打开的链接框：{ start, end, chars }

  // ── 点字进编辑 ──
  doc.addEventListener('mousedown', (e) => {
    if ([linkBox, more, rail, linkTip].some((n) => n.contains(e.target))) return;
    closeMore();
    // ⌘ 点链接：直接打开，不进编辑
    const a = e.target.closest?.('.sheet a[href]');
    if (a && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openHref(a.getAttribute('href'));
      return;
    }
    hideTip();
    const el = e.target.closest?.('[data-bind]');
    if (editing && editing !== el) commit(editing);
    if (!el || el === editing) return;
    e.preventDefault();
    // 编辑时显示的就是渲染结果，所以光标可以直接落在点的位置
    beginEdit(el, { x: e.clientX, y: e.clientY });
  });

  // 链接在编辑器里只是一种格式，点了不能把 iframe 导航走
  doc.addEventListener('click', (e) => {
    if (e.target.closest?.('a')) e.preventDefault();
  });

  /** @param {'start'|'end'|{x:number,y:number}} caretAt */
  function beginEdit(el, caretAt = 'end') {
    const path = el.dataset.bind;
    el.dataset.before = isMarkupField(path) ? String(getAt(ctx.data(), path) ?? '') : el.textContent;

    el.classList.add('sk-editing');
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.focus();

    let r = null;
    if (typeof caretAt === 'object') {
      r = doc.caretRangeFromPoint?.(caretAt.x, caretAt.y) ?? null;
      if (r && !el.contains(r.startContainer)) r = null;
    }
    if (!r) {
      r = doc.createRange();
      r.selectNodeContents(el);
      // 默认末尾：改一个字比重打一遍常见。'all' 给刚补上的占位用，打字即替换
      if (caretAt !== 'all') r.collapse(caretAt === 'start');
    }
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    editing = el;
    hideRail();
  }

  function commit(el) {
    if (!el) return;
    const path = el.dataset.bind;
    const before = el.dataset.before ?? '';
    const rich = isMarkupField(path);
    const runs = rich ? readRuns(el, true) : null;
    const text = el.textContent.replace(/\u00a0/g, ' ').trim();
    endEdit(el);

    // 标记字段：文字和格式都没变就保留原字符串，
    // 免得 `\*` 和 `*` 这类等价写法被改写，YAML 里出现无意义的 diff
    const changed = rich ? !sameRuns(runs, tokens(before)) : text !== before;
    if (!changed) return repaint(el, path, before);

    const value = rich ? fromTokens(runs) : text;
    ctx.onEdit(path, value);
    repaint(el, path, value);
  }

  function cancel(el) {
    if (!el) return;
    const path = el.dataset.bind;
    const before = el.dataset.before ?? '';
    endEdit(el);
    repaint(el, path, before);
  }

  function endEdit(el) {
    if (linkState) closeLink(undefined, false);
    el.contentEditable = 'false';
    el.classList.remove('sk-editing');
    delete el.dataset.before;
    editing = null;
    ctx.onSelect(null);
  }

  /**
   * 把编辑中的 DOM 读回片段，形状和 tokens() 的输出一致。
   * 只认皮肤产出的三种标记（span.lead / span.t / a.lk），外加浏览器
   * 合并删除时可能留下的 <b> 和 font-weight 内联样式，其余标签一律当文字。
   *
   * @param {boolean} clean 提交用：nbsp 换成空格、去掉首尾空白。
   *   切换格式时不能清理，否则字符偏移和选区对不上。
   */
  function readRuns(el, clean) {
    const out = [];
    const push = (text, f) => {
      if (!text) return;
      const prev = out[out.length - 1];
      if (prev && prev.bold === f.bold && prev.code === f.code && prev.href === f.href) prev.text += text;
      else out.push({ text, bold: f.bold, code: f.code, href: f.href });
    };
    const visit = (node, f) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) push(clean ? n.data.replace(/\u00a0/g, ' ') : n.data, f);
        else if (n.nodeType === 1 && n.tagName === 'BR') clean && push(' ', f);
        else if (n.nodeType === 1) visit(n, formatOf(n, f));
      }
    };
    visit(el, { bold: false, code: false, href: null });
    if (clean && out.length) {
      out[0].text = out[0].text.replace(/^\s+/, '');
      out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    }
    return out.filter((r) => r.text);
  }

  function formatOf(n, f) {
    const cls = n.classList;
    const fw = n.style?.fontWeight;
    return {
      bold: f.bold || cls.contains('lead') || n.tagName === 'B' || n.tagName === 'STRONG' || fw === 'bold' || +fw >= 600,
      code: f.code || cls.contains('t') || n.tagName === 'CODE',
      href: n.tagName === 'A' && n.getAttribute('href') ? n.getAttribute('href').trim() : f.href,
    };
  }

  /** 把值重新渲染回元素，标记字段要走一遍 inline() */
  function repaint(el, path, value) {
    if (isMarkupField(path)) el.innerHTML = ctx.renderInline(value);
    else el.textContent = value;
    // 可选字段清空了就整段消失，这个 DOM 里做不到，交给上层重渲染
    if (!value && isOptional(path)) ctx.onStructure('rerender');
  }

  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && more.classList.contains('on')) return closeMore();
    if (!editing || linkBox.contains(e.target)) return;
    // 输入法组字时的回车、退格是给候选框的，不是给编辑器的
    if (e.isComposing || e.keyCode === 229) return;
    const path = editing.dataset.bind;
    const rowPath = editing.closest('[data-row]')?.dataset.row;
    const type = rowPath ? rowType(rowPath) : null;
    const mod = e.metaKey || e.ctrlKey;

    // ── Escape：取消编辑 ──
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel(editing);
      return;
    }

    // ── ⌘S：提交并保存 ──
    if (mod && e.key === 's') {
      e.preventDefault();
      commit(editing);
      ctx.onSave();
      return;
    }

    // ── ⌘B / ⌘E 切换粗体、技术名，⌘K 加链接 ──
    // 浏览器自带的 ⌘B/⌘I/⌘U 会插 <b><i><u>，数据里存不下，统统拦掉
    if (mod && ['b', 'e', 'k', 'i', 'u'].includes(e.key)) {
      e.preventDefault();
      if (!isMarkupField(path)) return;
      if (e.key === 'b') toggleFormat('bold');
      else if (e.key === 'e') toggleFormat('code');
      else if (e.key === 'k') openLink();
      return;
    }

    // ── ⌥↑ / ⌥↓：移动当前行 ──
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && rowPath) {
      e.preventDefault();
      const sibs = siblings(doc, rowPath);
      const idx = sibs.findIndex((s) => s.dataset.row === rowPath);
      const to = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
      if (to < 0 || to >= sibs.length) return;
      // 提交当前编辑，焦点跨重渲染恢复由 editor.js 的 pendingFocus 处理
      commit(editing);
      ctx.onStructure('move', rowPath, { to, focusPath: path });
      return;
    }

    // ── Enter：提交；在可续条的行还要插一条新行并进入编辑 ──
    // 字段都是单行的，⇧Enter 插进来的 <br> 存不下，一起拦掉
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) return;
      commit(editing);
      // 告知上层：在 rowPath 下方加一行，然后把焦点给新行的 text 字段
      if (isContinuable(type) && rowPath) ctx.onStructure('add', rowPath, { focusNew: true });
      return;
    }

    // ── Backspace 在空的可续条行：删行，焦点回上一条末尾 ──
    if (e.key === 'Backspace' && isContinuable(type) && rowPath) {
      const cur = editing.textContent.replace(/\u00a0/g, ' ').trim();
      if (cur !== '') return; // 有内容不拦截
      e.preventDefault();

      const sibs = siblings(doc, rowPath);
      const idx = sibs.findIndex((s) => s.dataset.row === rowPath);
      // 只有一条时不删（空内容会触发重渲染让它消失，那才是用户想要的）
      if (sibs.length <= 1) return;

      // 找上一条的 data-bind 元素（sibs[idx-1] 本身就是 data-bind，或第一个子 [data-bind]）
      const prevRow = sibs[idx > 0 ? idx - 1 : 0];
      const prevBind = prevRow.matches('[data-bind]')
        ? prevRow
        : prevRow.querySelector('[data-bind]');
      const prevPath = prevBind?.dataset.bind ?? null;

      cancel(editing); // 先清空编辑状态，免得 commit 把空值写进去
      ctx.onStructure('del', rowPath, { focusPath: prevPath, focusCaret: 'end' });
      return;
    }

    // ── Tab / ⇧Tab：在 data-bind 字段之间跳 ──
    if (e.key === 'Tab') {
      e.preventDefault();
      const all = [...doc.querySelectorAll('[data-bind]')];
      const idx = all.indexOf(editing);
      if (idx === -1) return;
      commit(editing);
      const next = e.shiftKey
        ? all[(idx - 1 + all.length) % all.length]
        : all[(idx + 1) % all.length];
      if (next) beginEdit(next, 'end');
      return;
    }
  });

  doc.addEventListener('focusout', (e) => {
    // 焦点去了链接框不算离开，⌘K 关掉后会回来
    if (editing && e.target === editing && !linkBox.contains(e.relatedTarget)) commit(editing);
  });

  // 敲字时让上层量一下还装不装得下（上层自己防抖）
  doc.addEventListener('input', (e) => {
    if (editing && e.target === editing) ctx.onInput?.();
  });

  // 粘贴只要纯文字：别处复制来的 HTML 带着字体颜色，数据里存不下
  doc.addEventListener('paste', (e) => {
    if (!editing || linkBox.contains(e.target)) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData('text/plain') ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
    if (text) doc.execCommand('insertText', false, text);
  });
  doc.addEventListener('drop', (e) => editing && e.preventDefault());

  // 选中文字就浮出格式条（只在支持标记的字段上）
  doc.addEventListener('selectionchange', () => {
    if (!editing || linkState || !isMarkupField(editing.dataset.bind)) return ctx.onSelect(null);
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return ctx.onSelect(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    ctx.onSelect(r.width ? r : null);
  });

  // ── 格式切换 ──
  //
  // 不用 execCommand('bold')：它产出的 <b>/<span style> 每个浏览器不一样。
  // 做法是把内容摊成逐字的格式表，改选中那一段，再用 inline() 整格重画 ——
  // 和服务端渲染走同一套代码，画出来什么样，保存后就什么样。

  /** 选区在编辑格里的字符偏移，和 textContent 对齐 */
  function selOffsets() {
    const sel = win.getSelection();
    if (!sel?.rangeCount || !editing) return null;
    const r = sel.getRangeAt(0);
    if (!editing.contains(r.startContainer) || !editing.contains(r.endContainer)) return null;
    return { start: offsetIn(r.startContainer, r.startOffset), end: offsetIn(r.endContainer, r.endOffset) };
  }

  function offsetIn(node, offset) {
    const r = doc.createRange();
    r.selectNodeContents(editing);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  function pointAt(offset) {
    const walk = doc.createTreeWalker(editing, win.NodeFilter.SHOW_TEXT);
    let n = 0;
    let t;
    let last = null;
    while ((t = walk.nextNode())) {
      if (n + t.data.length >= offset) return [t, offset - n];
      n += t.data.length;
      last = t;
    }
    return last ? [last, last.data.length] : [editing, editing.childNodes.length];
  }

  function select(start, end = start) {
    const r = doc.createRange();
    r.setStart(...pointAt(start));
    r.setEnd(...pointAt(end));
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 摊成逐字：[{ch, bold, code, href}]。按 UTF-16 单位，和选区偏移同一把尺子 */
  function explode() {
    const chars = [];
    for (const r of readRuns(editing, false)) {
      for (const ch of r.text.split('')) chars.push({ ch, bold: r.bold, code: r.code, href: r.href });
    }
    return chars;
  }

  function redraw(chars, start, end) {
    const runs = [];
    for (const c of chars) {
      const prev = runs[runs.length - 1];
      if (prev && prev.bold === c.bold && prev.code === c.code && prev.href === c.href) prev.text += c.ch;
      else runs.push({ text: c.ch, bold: c.bold, code: c.code, href: c.href });
    }
    editing.innerHTML = ctx.renderInline(fromTokens(runs));
    select(start, end);
    ctx.onInput?.();
  }

  /** 选中的字已经全带这个格式就去掉，否则全加上 */
  function toggleFormat(key) {
    const o = selOffsets();
    if (!o || o.start === o.end) return;
    const chars = explode();
    const slice = chars.slice(o.start, o.end);
    const on = !slice.every((c) => c[key]);
    for (const c of slice) c[key] = on;
    redraw(chars, o.start, o.end);
  }

  // ── 链接 ──

  function openLink() {
    const o = selOffsets();
    if (!o) return;
    const chars = explode();
    let { start, end } = o;
    // 光标停在链接里没选字：编辑整条链接
    if (start === end) {
      const href = chars[start]?.href ?? chars[start - 1]?.href;
      if (!href) return;
      while (start > 0 && chars[start - 1].href === href) start--;
      while (end < chars.length && chars[end].href === href) end++;
    }
    const hrefs = new Set(chars.slice(start, end).map((c) => c.href));
    linkState = { start, end, chars };
    ctx.onSelect(null);

    const r = win.getSelection().getRangeAt(0).getBoundingClientRect();
    linkBox.style.left = `${Math.max(4, r.left + win.scrollX)}px`;
    linkBox.style.top = `${r.bottom + win.scrollY + 6}px`;
    linkBox.classList.add('on');
    linkInput.classList.remove('bad');
    linkInput.value = hrefs.size === 1 ? [...hrefs][0] ?? '' : '';
    linkInput.focus();
    linkInput.select();
  }

  /**
   * @param {string|null|undefined} href  字符串 = 设成这个地址，null = 去掉链接，undefined = 什么都不改
   * @param {boolean} refocus  回到编辑格（回车、Esc 时要；点到别处时不要）
   */
  function closeLink(href, refocus) {
    const st = linkState;
    if (!st) return;
    linkState = null;
    linkBox.classList.remove('on');
    if (!editing) return;
    if (refocus) editing.focus();
    if (href === undefined) {
      if (refocus) select(st.start, st.end);
      return;
    }
    for (const c of st.chars.slice(st.start, st.end)) c.href = href;
    redraw(st.chars, st.end);
  }

  linkInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeLink(undefined, true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const href = normalizeHref(linkInput.value);
      if (href === false) return linkInput.classList.add('bad');
      closeLink(href, true);
    }
  });
  // 点到别处：放弃这次改链接，编辑格照常走 focusout 提交
  linkInput.addEventListener('blur', () => {
    if (!linkState) return;
    closeLink(undefined, false);
    if (editing && doc.activeElement !== editing) commit(editing);
  });

  // ── 块把手（Notion 那样）──
  //
  // 鼠标在某一块上或它左边的页边里，块左边就浮出 + 和 ⠿：
  // + 在下面加一条，⠿ 拖动换位置、单击出菜单。
  // 用 mousemove 而不是 mouseover —— 把手在块外面，鼠标往把手走的路上
  // 已经离开了块，靠 mouseover 会一路闪。
  const GUTTER = 46; // 块左边多宽的页边也算"在这块上"

  doc.addEventListener('mousemove', (e) => {
    if (dragging || menuOpen()) return;
    if (rail.contains(e.target)) return;
    // 几十个块量一遍位置很便宜（没改 DOM，不触发重排），不用节流
    const row = rowAt(e.clientX, e.clientY);
    if (row) showRail(row);
    else hideRail();
  });

  doc.addEventListener('mouseleave', () => !dragging && !menuOpen() && hideRail());

  /** 鼠标下最里面的那一块；左边留 GUTTER 宽的页边也算 */
  function rowAt(x, y) {
    let best = null;
    for (const row of doc.querySelectorAll('.sheet [data-row]')) {
      const r = row.getBoundingClientRect();
      if (y < r.top || y > r.bottom || x > r.right) continue;
      const pad = isInline(row) ? 0 : GUTTER;
      if (x < r.left - pad) continue;
      // 嵌套的块（章节 ⊃ 条目 ⊃ 要点）取最里面的
      if (!best || best.contains(row)) best = row;
    }
    return best;
  }

  /**
   * 横排的小块（数据那一行）：把手放上面，放左边会压住前一格。
   * 皮肤用 inline 还是横向 flex 排都认得。
   */
  function isInline(row) {
    if (win.getComputedStyle(row).display.startsWith('inline')) return true;
    const ps = win.getComputedStyle(row.parentElement);
    return /flex/.test(ps.display) && !ps.flexDirection.startsWith('column');
  }

  /** 块的第一行文字的上沿和行高，把手跟它对齐 */
  function firstLine(row) {
    const head = row.querySelector(':scope > .sec-title, :scope > .eh') ?? row;
    const range = doc.createRange();
    range.selectNodeContents(head);
    const rect = [...range.getClientRects()].find((q) => q.height > 0) ?? head.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  }

  function showRail(row) {
    if (row === hotRow && rail.classList.contains('on')) return;
    hotRow = row;
    const t = rowType(row.dataset.row);
    const inList = t !== 'profile';
    // 页头不能拖也不能删，菜单里只有“加字段”；都填齐了就不出把手
    if (!inList && !missingFields(ctx.data(), row.dataset.row).length) return hideRail();
    const name = label(t);
    const add = rail.querySelector('[data-act="add"]');
    add.style.display = inList ? '' : 'none';
    add.title = `在下面加一条${name}`;
    rail.querySelector('[data-act="grip"]').title = inList ? `拖动换位置 · 单击出菜单` : `单击出菜单`;

    const r = row.getBoundingClientRect();
    // 联系方式是 dt/dd 两格，把手要在标签那格左边
    const label0 = row.previousElementSibling?.tagName === 'DT' ? row.previousElementSibling : null;
    const left = label0 ? Math.min(r.left, label0.getBoundingClientRect().left) : r.left;
    rail.classList.toggle('above', isInline(row));
    rail.classList.add('on');
    const w = rail.offsetWidth;
    if (isInline(row)) {
      rail.style.left = `${left + win.scrollX}px`;
      rail.style.top = `${r.top + win.scrollY - rail.offsetHeight - 1}px`;
    } else {
      const line = firstLine(row);
      rail.style.left = `${Math.max(1, left + win.scrollX - w - 3)}px`;
      rail.style.top = `${line.top + win.scrollY + (line.height - rail.offsetHeight) / 2}px`;
    }
  }

  function hideRail() {
    rail.classList.remove('on');
    hotRow = null;
  }

  // 点把手不能让正在编辑的格子丢焦点之前就被别的 mousedown 处理掉
  rail.addEventListener('mousedown', (e) => e.preventDefault());

  rail.querySelector('[data-act="add"]').addEventListener('click', () => {
    if (!hotRow) return;
    const path = hotRow.dataset.row;
    if (editing) commit(editing);
    hideRail();
    ctx.onStructure('add', path, { focusNew: true });
  });

  // ⠿：按下后挪过 4px 算拖动，没挪就是单击出菜单
  let dragging = null;
  const grip = rail.querySelector('[data-act="grip"]');

  grip.addEventListener('pointerdown', (e) => {
    if (!hotRow || e.button !== 0) return;
    e.preventDefault();
    if (menuOpen()) {
      closeMore();
      return;
    }
    if (editing) commit(editing);
    const row = hotRow;
    const path = row.dataset.row;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const inList = rowType(path) !== 'profile';
    const sibs = inList ? siblings(doc, path) : [];
    let moved = false;
    doc.body.setPointerCapture?.(e.pointerId);

    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      if (!moved) {
        moved = true;
        if (sibs.length < 2) return;
        dragging = { path, row, sibs, to: sibs.indexOf(row) };
        row.classList.add('sk-dragging');
        rail.classList.remove('on');
        doc.documentElement.classList.add('sk-grabbing');
      }
      if (!dragging) return;
      const horizontal = isInline(row);
      let to = sibs.length;
      for (let i = 0; i < sibs.length; i++) {
        const q = sibs[i].getBoundingClientRect();
        if (horizontal ? ev.clientX < q.left + q.width / 2 : ev.clientY < q.top + q.height / 2) {
          to = i;
          break;
        }
      }
      dragging.to = to;
      const ref = sibs[Math.min(to, sibs.length - 1)].getBoundingClientRect();
      const atEnd = to >= sibs.length;
      drop.style.left = `${ref.left + win.scrollX}px`;
      drop.style.width = `${ref.width}px`;
      drop.style.top = `${(atEnd ? ref.bottom : ref.top) + win.scrollY - 1}px`;
      drop.classList.add('on');
    };

    const onUp = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.documentElement.classList.remove('sk-grabbing');
      drop.classList.remove('on');
      if (!moved) return openMore(row);
      const d = dragging;
      dragging = null;
      hideRail();
      if (!d) return;
      d.row.classList.remove('sk-dragging');
      const from = d.sibs.indexOf(d.row);
      let to = d.to;
      // 往后拖时，自己占的那格要减掉
      if (to > from) to -= 1;
      if (to !== from && to >= 0) ctx.onStructure('move', d.path, { to });
    };

    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  });

  // ── ⠿ 单击出的菜单：补字段 / 复制 / 删除 ──
  const menuOpen = () => more.classList.contains('on');

  function openMore(row) {
    const path = row.dataset.row;
    const t = rowType(path);
    const fields = missingFields(ctx.data(), path);
    const html = [`<div class="hd">${label(t)}</div>`];
    for (const f of fields) html.push(`<button data-key="${f.key}">${ICON.plus}<span>加${f.name}</span></button>`);
    if (t !== 'profile') {
      if (fields.length) html.push('<hr>');
      html.push(`<button data-act="dup">${ICON.dup}<span>复制一份</span></button>`);
      html.push(`<button data-act="del" class="danger">${ICON.del}<span>删掉</span></button>`);
    }
    more.innerHTML = html.join('');
    more.dataset.for = path;
    const g = grip.getBoundingClientRect();
    more.style.left = `${g.left + win.scrollX}px`;
    more.style.top = `${g.bottom + win.scrollY + 4}px`;
    more.classList.add('on');
  }

  function closeMore() {
    if (!menuOpen()) return;
    more.classList.remove('on');
    hideRail();
  }

  more.addEventListener('mousedown', (e) => e.preventDefault());
  more.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const path = more.dataset.for;
    closeMore();
    if (b.dataset.key) ctx.onStructure('field', path, { key: b.dataset.key });
    else ctx.onStructure(b.dataset.act, path);
  });

  // ── 链接：悬停出一张小卡片，能直接打开；⌘ 点击也能开 ──
  let tipFor = null;
  let tipTimer = 0;

  doc.addEventListener('mouseover', (e) => {
    if (dragging) return;
    const a = e.target.closest?.('.sheet a[href]');
    if (a) {
      clearTimeout(tipTimer);
      if (a !== tipFor) showTip(a);
    } else if (tipFor && !linkTip.contains(e.target)) {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(hideTip, 220);
    } else if (linkTip.contains(e.target)) {
      clearTimeout(tipTimer);
    }
  });

  function showTip(a) {
    const href = a.getAttribute('href');
    if (!isSafeUrl(href)) return;
    tipFor = a;
    const shown = href.replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '');
    linkTip.querySelector('.u').textContent = shown.length > 42 ? `${shown.slice(0, 40)}…` : shown;
    linkTip.querySelector('.u').title = href;
    const r = a.getBoundingClientRect();
    linkTip.style.left = `${r.left + win.scrollX}px`;
    linkTip.style.top = `${r.bottom + win.scrollY + 4}px`;
    linkTip.classList.add('on');
  }

  function hideTip() {
    tipFor = null;
    linkTip.classList.remove('on');
  }

  const openHref = (href) => isSafeUrl(href) && win.open(href, '_blank', 'noopener');

  linkTip.addEventListener('mousedown', (e) => e.preventDefault());
  linkTip.querySelector('[data-act="open"]').addEventListener('click', () => {
    if (tipFor) openHref(tipFor.getAttribute('href'));
  });

  // ── 公开接口 ──
  return {
    /** 上层要保存时，先把正在编辑的那格落进数据 */
    flush: () => editing && commit(editing),

    /**
     * 跨重渲染恢复焦点。由 editor.js 在 rerender 后调用。
     * @param {string} path  data-bind 路径
     * @param {'start'|'end'} [caret] 光标位置，默认末尾
     */
    focusPath(path, caret = 'end') {
      const el = doc.querySelector(`[data-bind="${CSS.escape(path)}"]`);
      if (!el) return false;
      beginEdit(el, caret);
      return true;
    },

    /**
     * .sheet 被原地换掉之后调用（见 editor.js 的 swapSheet）。
     * 监听器挂在 document 上不用重挂，只清掉指向旧节点的状态。
     */
    reset() {
      editing = null;
      hotRow = null;
      dragging = null;
      linkState = null;
      rail.classList.remove('on');
      drop.classList.remove('on');
      linkBox.classList.remove('on');
      more.classList.remove('on');
      linkTip.classList.remove('on');
      tipFor = null;
      ctx.onSelect(null);
    },

    /**
     * 在纸上标出装不下的地方：被裁的那几格染红，纸边画一条线。
     * 单页模式才有意义，多页模式纸张随内容长高，不存在"被裁"。
     */
    markFit(fit) {
      for (const el of doc.querySelectorAll('.sk-cut')) el.classList.remove('sk-cut');
      fitLine.className = '';
      const sheet = doc.querySelector('.sheet');
      if (!sheet || !fit || fit.multipage || !(fit.clipped || fit.tight)) return;

      const box = sheet.getBoundingClientRect();
      const padBottom = parseFloat(win.getComputedStyle(sheet).paddingBottom) || 0;
      const y = fit.clipped ? box.bottom : box.bottom - padBottom;
      fitLine.style.left = `${box.left + win.scrollX}px`;
      fitLine.style.width = `${box.width}px`;
      fitLine.style.top = `${y + win.scrollY - 1}px`;
      fitLine.className = fit.clipped ? 'clipped' : 'tight';
      fitLine.firstChild.textContent = fit.clipped
        ? `超出 ${fit.clipMm}mm，纸边以下会被裁掉`
        : `压进下边距 ${fit.intoPadMm}mm`;

      if (!fit.clipped) return;
      for (const el of sheet.querySelectorAll('[data-bind]')) {
        if (el.getBoundingClientRect().bottom > box.bottom + 0.5) el.classList.add('sk-cut');
      }
    },
  };
}

/**
 * 链接框里敲的地址 → 能存的地址。空 = 去掉链接（null），认不出 = false。
 * 少写协议的常见写法帮着补上：邮箱补 mailto:，域名补 https://。
 */
function normalizeHref(input) {
  const v = input.trim();
  if (!v) return null;
  if (isSafeUrl(v)) return v;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) return `mailto:${v}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return `https://${v}`;
  return false;
}

const ICON = {
  plus: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  grip: '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.25"/><circle cx="7" cy="3" r="1.25"/><circle cx="3" cy="7" r="1.25"/><circle cx="7" cy="7" r="1.25"/><circle cx="3" cy="11" r="1.25"/><circle cx="7" cy="11" r="1.25"/></svg>',
  dup: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/><path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6"/></svg>',
  del: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.5 4h9M5.5 4V2.8h3V4M3.8 4l.6 7.2h5.2l.6-7.2"/></svg>',
  out: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M4 2H2v6h6V6M6 1.5h2.5V4M8.5 1.5 4.8 5.2"/></svg>',
};

function buildRail(doc) {
  const el = doc.createElement('div');
  el.id = 'sk-rail';
  el.innerHTML = `<button data-act="add">${ICON.plus}</button><button data-act="grip">${ICON.grip}</button>`;
  return el;
}

/** 两串片段的文字和格式是否一致（标记写法可以不同） */
function sameRuns(a, b) {
  const key = (rs) => JSON.stringify(rs.map((r) => [r.text, !!r.bold, !!r.code, r.href ?? null]));
  return key(a) === key(b);
}

/** 同一个数组里的其它行，按 DOM 顺序 */
function siblings(doc, path) {
  const prefix = path.slice(0, path.lastIndexOf('.') + 1);
  return [...doc.querySelectorAll('[data-row]')].filter((el) => {
    const p = el.dataset.row;
    return p.startsWith(prefix) && !p.slice(prefix.length).includes('.');
  });
}
