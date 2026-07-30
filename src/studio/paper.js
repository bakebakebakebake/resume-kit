/**
 * 让 iframe 里那张纸变得可以直接改。
 *
 * iframe 是 srcdoc 装的、同源,所以能直接操作里面的 document,
 * 不用 postMessage 来回传。往里注入的所有 UI(操作轨、插入指示线)
 * 都只活在这个 iframe 的 DOM 里,导出走的是服务端重新渲染,
 * 这些编辑期的装饰不可能漏进产物。
 */

import { getAt, isMarkupField, isOptional, rowType, label } from './model.js';

/** 注入到 iframe 里的编辑期样式 */
const EDIT_CSS = `
[data-bind]{
  cursor:text;
  border-radius:2px;
  transition:background .1s,box-shadow .1s;
}
[data-bind]:hover{
  background:rgba(79,179,168,.13);
  box-shadow:0 0 0 1.5px rgba(79,179,168,.34);
}
[data-bind].sk-editing{
  background:#fff;
  box-shadow:0 0 0 1.5px #4FB3A8,0 1px 8px rgba(0,0,0,.14);
  outline:0;
  cursor:auto;
}
/* 编辑时显示原始标记,等宽字体让星号和反引号看得清 */
[data-bind].sk-editing.sk-raw{
  font-family:"SF Mono",ui-monospace,Menlo,monospace;
  font-size:.92em;
  color:#14181C;
}
[data-row].sk-hot{
  box-shadow:-3px 0 0 rgba(79,179,168,.5);
}
[data-row].sk-dragging{opacity:.4}

#sk-rail{
  position:absolute;z-index:40;display:none;
  gap:1px;padding:2px;
  background:#25292E;border:1px solid #3D444C;border-radius:6px;
  box-shadow:0 3px 12px rgba(0,0,0,.34);
  font-family:-apple-system,BlinkMacSystemFont,sans-serif;
}
#sk-rail.on{display:flex}
#sk-rail button{
  width:20px;height:19px;padding:0;border:0;border-radius:4px;
  background:none;color:#A8ADB3;cursor:pointer;
  font-size:11px;line-height:1;
  display:flex;align-items:center;justify-content:center;
}
#sk-rail button:hover{background:#383E46;color:#E8E6E3}
#sk-rail button[data-act="del"]:hover{background:#D9614C;color:#fff}
#sk-rail button[data-act="drag"]{cursor:grab}
#sk-rail .lbl{
  font-size:9.5px;color:#6E757C;padding:0 4px;
  display:flex;align-items:center;white-space:nowrap;
}

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
 * @param {() => object} ctx.data          取当前数据
 * @param {(path, value) => void} ctx.onEdit    某个字段改了
 * @param {(act, rowPath, extra) => void} ctx.onStructure  加/删/移
 * @param {(rect|null) => void} ctx.onSelect    选中范围变了（格式条跟着走）
 */
export function mount(frame, ctx) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc?.body) return;

  const style = doc.createElement('style');
  style.textContent = EDIT_CSS;
  doc.head.appendChild(style);

  const rail = buildRail(doc);
  const drop = doc.createElement('div');
  drop.id = 'sk-drop';
  doc.body.append(rail, drop);

  let hotRow = null; // 鼠标下面那一行
  let editing = null; // 正在编辑的元素

  // ── 点字进编辑 ──
  doc.addEventListener('mousedown', (e) => {
    const el = e.target.closest?.('[data-bind]');
    if (editing && editing !== el) commit(editing);
    if (!el || el === editing) return;
    e.preventDefault();
    beginEdit(el);
  });

  function beginEdit(el) {
    const path = el.dataset.bind;
    const raw = isMarkupField(path);
    el.dataset.before = raw ? String(getAt(ctx.data(), path) ?? '') : el.textContent;

    if (raw) {
      // 显示原始标记而不是渲染后的样子
      el.textContent = el.dataset.before;
      el.classList.add('sk-raw');
    }
    el.classList.add('sk-editing');
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.focus();

    // 光标落到末尾，而不是选中全部：改一个字比重打一遍常见
    const r = doc.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = win.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    editing = el;
    hideRail();
  }

  function commit(el) {
    if (!el) return;
    const path = el.dataset.bind;
    const text = el.textContent.replace(/ /g, ' ').trim();
    const before = el.dataset.before ?? '';

    el.contentEditable = 'false';
    el.classList.remove('sk-editing', 'sk-raw');
    delete el.dataset.before;
    editing = null;
    ctx.onSelect(null);

    if (text === before) {
      // 没改动也要把渲染还原（进编辑时可能换成了原始标记）
      repaint(el, path, before);
      return;
    }
    ctx.onEdit(path, text);
    repaint(el, path, text);
  }

  function cancel(el) {
    if (!el) return;
    const path = el.dataset.bind;
    const before = el.dataset.before ?? '';
    el.contentEditable = 'false';
    el.classList.remove('sk-editing', 'sk-raw');
    delete el.dataset.before;
    editing = null;
    ctx.onSelect(null);
    repaint(el, path, before);
  }

  /** 把值重新渲染回元素，标记字段要走一遍 inline() */
  function repaint(el, path, value) {
    if (isMarkupField(path)) el.innerHTML = ctx.renderInline(value);
    else el.textContent = value;
    // 可选字段清空了就整段消失，这个 DOM 里做不到，交给上层重渲染
    if (!value && isOptional(path)) ctx.onStructure('rerender');
  }

  doc.addEventListener('keydown', (e) => {
    if (!editing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel(editing);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit(editing);
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'e')) {
      e.preventDefault();
      wrapSelection(e.key === 'b' ? '**' : '`');
    } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      commit(editing);
      ctx.onSave();
    }
  });

  doc.addEventListener('focusout', (e) => {
    if (editing && e.target === editing) commit(editing);
  });

  // 选中文字就浮出格式条（只在支持标记的字段上）
  doc.addEventListener('selectionchange', () => {
    if (!editing || !editing.classList.contains('sk-raw')) return ctx.onSelect(null);
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return ctx.onSelect(null);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    ctx.onSelect(r.width ? r : null);
  });

  /** 给选中的文字套上标记。已经套了就脱掉,当开关用。 */
  function wrapSelection(mark) {
    const sel = win.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed || !editing) return;
    const range = sel.getRangeAt(0);
    const text = range.toString();
    if (!text) return;

    const full = editing.textContent;
    const start = caretOffset(editing, range.startContainer, range.startOffset);
    const end = start + text.length;
    const before = full.slice(0, start);
    const after = full.slice(end);

    let next;
    if (before.endsWith(mark) && after.startsWith(mark)) {
      next = before.slice(0, -mark.length) + text + after.slice(mark.length);
    } else {
      next = `${before}${mark}${text}${mark}${after}`;
    }
    editing.textContent = next;

    // 光标放回被包裹文字的末尾
    const target = before.endsWith(mark) ? start - mark.length + text.length : start + mark.length + text.length;
    placeCaret(editing, target);
    ctx.onSelect(null);
  }

  /** 元素内的字符偏移量：contenteditable 只有一层文本，累加前面兄弟节点的长度 */
  function caretOffset(el, node, offset) {
    let n = 0;
    const walk = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walk.nextNode())) {
      if (t === node) return n + offset;
      n += t.textContent.length;
    }
    return n;
  }

  function placeCaret(el, offset) {
    const walk = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
    let n = 0;
    let t;
    while ((t = walk.nextNode())) {
      if (n + t.textContent.length >= offset) {
        const r = doc.createRange();
        r.setStart(t, Math.max(0, offset - n));
        r.collapse(true);
        const sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      n += t.textContent.length;
    }
  }

  // ── 悬停出操作轨 ──
  doc.addEventListener('mouseover', (e) => {
    if (editing || dragging) return;
    const row = e.target.closest?.('[data-row]');
    if (!row || row === hotRow) return;
    showRail(row);
  });

  doc.addEventListener('mouseleave', () => !dragging && hideRail());

  function showRail(row) {
    hotRow?.classList.remove('sk-hot');
    hotRow = row;
    row.classList.add('sk-hot');

    const t = rowType(row.dataset.row);
    rail.querySelector('.lbl').textContent = label(t);
    // 联系方式和数据条太窄，塞不下拖动手柄，只留加和删
    rail.querySelector('[data-act="drag"]').style.display = '';

    const r = row.getBoundingClientRect();
    rail.style.left = `${Math.max(2, r.left + win.scrollX - 2)}px`;
    rail.style.top = `${r.top + win.scrollY - 22}px`;
    rail.classList.add('on');
  }

  function hideRail() {
    rail.classList.remove('on');
    hotRow?.classList.remove('sk-hot');
    hotRow = null;
  }

  rail.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act || !hotRow || act === 'drag') return;
    const path = hotRow.dataset.row;
    hideRail();
    ctx.onStructure(act, path);
  });

  // ── 拖动排序 ──
  let dragging = null;

  rail.querySelector('[data-act="drag"]').addEventListener('pointerdown', (e) => {
    if (!hotRow) return;
    e.preventDefault();
    const path = hotRow.dataset.row;
    const sibs = siblings(doc, path);
    if (sibs.length < 2) return;

    dragging = { path, row: hotRow, sibs, to: sibs.findIndex((s) => s.dataset.row === path) };
    hotRow.classList.add('sk-dragging');
    rail.classList.remove('on');
    doc.body.setPointerCapture?.(e.pointerId);

    const onMove = (ev) => {
      const y = ev.clientY;
      let to = sibs.length;
      for (let i = 0; i < sibs.length; i++) {
        const r = sibs[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
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
      drop.classList.remove('on');
      dragging.row.classList.remove('sk-dragging');
      const from = dragging.sibs.findIndex((s) => s.dataset.row === dragging.path);
      let to = dragging.to;
      // 往后拖时，自己占的那格要减掉
      if (to > from) to -= 1;
      const d = dragging;
      dragging = null;
      hideRail();
      if (to !== from && to >= 0) ctx.onStructure('move', d.path, { to });
    };

    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  });

  return {
    /** 上层要保存时，先把正在编辑的那格落进数据 */
    flush: () => editing && commit(editing),
  };
}

function buildRail(doc) {
  const el = doc.createElement('div');
  el.id = 'sk-rail';
  el.innerHTML =
    '<button data-act="drag" title="拖动排序">⠿</button>' +
    '<button data-act="add" title="在下面加一条">+</button>' +
    '<button data-act="del" title="删掉这条">×</button>' +
    '<span class="lbl"></span>';
  return el;
}

/** 同一个数组里的其它行，按 DOM 顺序 */
function siblings(doc, path) {
  const prefix = path.slice(0, path.lastIndexOf('.') + 1);
  return [...doc.querySelectorAll('[data-row]')].filter((el) => {
    const p = el.dataset.row;
    return p.startsWith(prefix) && !p.slice(prefix.length).includes('.');
  });
}
