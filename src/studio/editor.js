/**
 * 工作台主控。
 *
 * 一条数据流:数据 → 服务端渲染 → iframe → 编辑事件 → 改数据 → 再渲染。
 * DOM 永远是数据的下游,不反向推导 —— 唯一的例外是改一个字时直接
 * 补那一个元素的 innerHTML(见 paper.js 的 repaint),
 * 那是为了不让每敲一下都过一次网络。
 */

import { inline } from '/src/markup.js';
import { getAt, setAt, locate, blank, snap, isOptional, label } from './model.js';
import { mount } from './paper.js';
import { buildKnobs, buildSectionList } from './knobs.js';

const $ = (id) => document.getElementById(id);
const frame = $('paper');

/**
 * 跨重渲染焦点恢复。两种形式：
 *   { path: string, caret }
 *     稳定路径，直接用（del 退格时前一行路径不变）
 *   { arrPath: string, index: number, fieldSuffix: string, caret }
 *     按数组位置找（add/move 后新位置的路径在重渲染前未知）
 */
const FOCUS_SUFFIX = {
  point: '.text', item: '.text', entry: '.org',
  award: '.name', fact: '.k', contact: '.label',
};

const S = {
  data: null,
  defaults: {},
  skins: [],
  dataFile: '',
  undo: [],
  redo: [],
  dirty: false,
  paper: null,
  lastEdit: { path: null, at: 0 },
  pendingFocus: null,
};

function applyPaperSize() {
  const p = S.data?.meta?.paper;
  if (!p?.w) return;
  const PX_PER_MM = 96 / 25.4;
  const w = Math.round(p.w * PX_PER_MM);
  const h = Math.round(p.h * PX_PER_MM);
  const st = document.documentElement.style;
  st.setProperty('--paper-w', `${w}px`);
  st.setProperty('--paper-h', `${h}px`);
  st.setProperty('--frame-w', `${w + 106}px`);
}

const isMultipage = () => {
  const p = S.data?.meta?.pages;
  return p === 'auto' || (typeof p === 'number' && p > 1);
};

// ── 启动 ──

boot();

async function boot() {
  try {
    const r = await fetch('/api/boot');
    const b = await r.json();
    if (b.error) throw new Error(b.error);
    S.data = b.data;
    S.defaults = b.defaults;
    S.skins = b.skins;
    S.dataFile = b.dataFile;

    $('file-name').textContent = b.dataFile.replace(/^.*\/(?=[^/]*$)/, '');
    $('file-name').title = b.dataFile;

    fillSkins();
    refreshKnobs();
    refreshSections();
    refreshPageLimitButton();
    reportLint(b.lint);
    await rerender();
  } catch (e) {
    toast(`启动失败：${e.message}`, 'bad', 8000);
  }
}

// ── 渲染 ──

let renderSeq = 0;

async function rerender() {
  const seq = ++renderSeq;
  setFit('busy', '重排…');
  applyPaperSize();
  const r = await fetch('/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(S.data),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    toast(`渲染失败：${e.error ?? r.status}`, 'bad', 6000);
    return;
  }
  const html = await r.text();
  if (seq !== renderSeq) return;

  await new Promise((ok) => {
    frame.addEventListener('load', ok, { once: true });
    frame.srcdoc = html;
  });
  if (seq !== renderSeq) return;

  alignPaper();

  S.paper = mount(frame, {
    data: () => S.data,
    renderInline: inline,
    onEdit: applyEdit,
    onStructure: applyStructure,
    onSelect: placeFmtBar,
    onSave: save,
  });

  applyTheme();
  applyPageLimit();

  // ── 跨重渲染焦点恢复 ──
  if (S.pendingFocus) {
    const pf = S.pendingFocus;
    S.pendingFocus = null;

    if (pf.path) {
      // 稳定路径（del 退格时前一行下标不变）
      S.paper?.focusPath(pf.path, pf.caret ?? 'end');
    } else if (pf.arrPath != null) {
      // 按数组位置找（add 新行、move 后新位置）
      const doc = frame.contentDocument;
      const prefix = pf.arrPath + '.';
      const sibs = [...doc.querySelectorAll('[data-row]')].filter((el) => {
        const p = el.dataset.row;
        return p.startsWith(prefix) && !p.slice(prefix.length).includes('.');
      });
      const targetRow = sibs[pf.index];
      if (targetRow) {
        const fieldPath = targetRow.dataset.row + (pf.fieldSuffix ?? '');
        S.paper?.focusPath(fieldPath, pf.caret ?? 'end');
        // 确保新行在可视区
        targetRow.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  await measure();
}

function alignPaper() {
  const doc = frame.contentDocument;
  const sheet = doc?.querySelector('.sheet');
  if (!sheet) return;
  const minH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--paper-h'), 10) || 1123;
  frame.style.height = `${Math.max(minH, doc.documentElement.scrollHeight)}px`;
  const r = sheet.getBoundingClientRect();
  frame.style.left = `${-Math.round(r.left)}px`;
  frame.style.top = `${-Math.round(r.top)}px`;
}

async function measure() {
  const win = frame.contentWindow;
  if (!win) return;
  try {
    if (win.__fitReady) await win.__fitReady;
    const fit = win.__measureFit ? win.__measureFit() : win.__resumeFit;
    showFit(fit);
  } catch {
    setFit('idle', '量不出来');
  }
}

function showFit(fit) {
  if (!fit) return setFit('idle', '量不出来');
  const caveat = fit.fontsReady ? '' : '（字体未就位，数字仅供参考）';
  if (fit.multipage) {
    return setFit('ok', `约 ${fit.pages} 页，末页还剩 ${fit.freeMm}mm${caveat}`);
  }
  if (fit.clipped) return setFit('clipped', `超出一页 ${fit.clipMm}mm，末尾会被裁掉${caveat}`);
  if (fit.tight) return setFit('tight', `压进下边距 ${fit.intoPadMm}mm，没丢内容${caveat}`);
  if (fit.freeMm <= 0.5) return setFit('ok', `正好一页，没有余量${caveat}`);
  setFit('ok', `还剩 ${fit.freeMm}mm${caveat}`);
}

function setFit(state, text) {
  const el = $('fit');
  el.dataset.state = state;
  el.textContent = text;
}

// ── 编辑 ──

function applyEdit(path, value) {
  const now = Date.now();
  const same = S.lastEdit.path === path && now - S.lastEdit.at < 1500;
  if (!same) pushUndo();
  S.lastEdit = { path, at: now };

  setAt(S.data, path, value === '' && isOptional(path) ? null : value);
  markDirty();

  if (/^sections\.\d+\.title$/.test(path)) refreshSections();
}

async function applyStructure(act, rowPath, extra = {}) {
  if (act === 'rerender') return rerender();

  pushUndo();
  const loc = locate(S.data, rowPath);
  if (!Array.isArray(loc.arr)) return;

  const q = quantifier(loc.type);

  if (act === 'add') {
    const fresh = blank(loc.type);
    if (!fresh) return;
    loc.arr.splice(loc.index + 1, 0, fresh);
    if (extra.focusNew) {
      // 新行在 loc.index+1，等重渲染后按 DOM 位置找到它再聚焦
      S.pendingFocus = {
        arrPath: loc.arrPath,
        index: loc.index + 1,
        fieldSuffix: FOCUS_SUFFIX[loc.type] ?? '',
        caret: 'end',
      };
    }
    toast(`加了${q}${label(loc.type)}`);
  }

  if (act === 'del') {
    if (loc.arr.length === 1 && loc.type !== 'section') {
      const gone = loc.arr[0];
      const nm = gone.text ?? gone.org ?? gone.name ?? gone.title ?? '';
      if (!confirm(`这是最后${q}${label(loc.type)}（${String(nm).slice(0, 20)}），删掉整段会一起消失。继续？`)) {
        S.undo.pop();
        return;
      }
    }
    loc.arr.splice(loc.index, 1);
    // 退格删空行：前一行路径下标不变，直接用稳定路径
    if (extra.focusPath) {
      S.pendingFocus = { path: extra.focusPath, caret: extra.focusCaret ?? 'end' };
    }
    toast(`删了${q}${label(loc.type)}`);
  }

  if (act === 'move') {
    const [row] = loc.arr.splice(loc.index, 1);
    loc.arr.splice(extra.to, 0, row);
    // ⌥↑↓ 移行：目标位置是 extra.to，fieldSuffix 从旧路径截取
    if (extra.focusPath != null) {
      S.pendingFocus = {
        arrPath: loc.arrPath,
        index: extra.to,
        fieldSuffix: extra.focusPath.slice(rowPath.length), // e.g. '.text', '.org', ''
        caret: 'end',
      };
    }
  }

  markDirty();
  refreshSections();
  await rerender();
}

// ── 撤销 ──

function pushUndo() {
  S.undo.push(snap(S.data));
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
  S.lastEdit = { path: null, at: 0 };
  refreshUndoButtons();
}

async function undo() {
  if (!S.undo.length) return;
  S.redo.push(snap(S.data));
  S.data = S.undo.pop();
  refreshUndoButtons();
  refreshKnobs();
  refreshSections();
  markDirty();
  await rerender();
}

async function redo() {
  if (!S.redo.length) return;
  S.undo.push(snap(S.data));
  S.data = S.redo.pop();
  refreshUndoButtons();
  refreshKnobs();
  refreshSections();
  markDirty();
  await rerender();
}

function refreshUndoButtons() {
  $('btn-undo').disabled = !S.undo.length;
  $('btn-redo').disabled = !S.redo.length;
}

// ── 保存 ──

function markDirty() {
  S.dirty = true;
  const b = $('btn-save');
  b.classList.add('dirty');
  b.textContent = '保存 •';
}

async function save() {
  S.paper?.flush();
  const b = $('btn-save');
  b.disabled = true;
  b.textContent = '保存中…';
  try {
    const r = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(S.data),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);

    S.dirty = false;
    b.classList.remove('dirty');
    b.textContent = '保存';
    toast(`已写入 resume.yaml${j.backup ? `，旧版留在 .studio-backups/${j.backup}` : ''}`, 'ok');
    reportLint(j.lint);
  } catch (e) {
    toast(`保存失败：${e.message}`, 'bad', 8000);
    b.textContent = '保存 •';
  } finally {
    b.disabled = false;
  }
}

function reportLint(l) {
  if (!l) return;
  if (l.errors?.length) toast(`数据有问题：${l.errors[0]}`, 'bad', 9000);
  else if (l.warnings?.length) console.warn('[studio] 提醒：\n' + l.warnings.join('\n'));
}

// ── 面板 ──

function refreshKnobs() {
  buildKnobs({
    mountType: $('knobs-type'),
    mountColor: $('knobs-color'),
    defaults: S.defaults,
    theme: S.data.meta.theme ?? {},
    onChange: (key, value) => {
      S.data.meta.theme ??= {};
      if (value == null) delete S.data.meta.theme[key];
      else S.data.meta.theme[key] = value;
      markDirty();
      applyTheme();
      scheduleMeasure();
    },
  });
}

function applyTheme() {
  const root = frame.contentDocument?.documentElement;
  if (!root) return;
  for (const k of Object.keys(S.defaults)) root.style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(S.data.meta.theme ?? {})) {
    root.style.setProperty(`--${k}`, v);
  }
}

function applyPageLimit() {
  const root = frame.contentDocument?.documentElement;
  if (!root) return;
  if (isMultipage()) root.dataset.pages = 'auto';
  else delete root.dataset.pages;
}

function refreshPageLimitButton() {
  const btn = $('btn-page-limit');
  if (!isMultipage()) {
    btn.textContent = '📄 限制一页';
    btn.title = '当前：超出会被裁掉。点击切换到多页模式（meta.pages: auto）';
  } else {
    btn.textContent = '📄 不限页数';
    btn.title = '当前：内容可以超过一页，按内容分页。点击切换回单页限制';
  }
}

let measureTimer = null;
function scheduleMeasure() {
  clearTimeout(measureTimer);
  setFit('busy', '重排…');
  measureTimer = setTimeout(measure, 220);
}

function fillSkins() {
  const sel = $('skin');
  sel.innerHTML = S.skins.map((s) => `<option value="${s}">${s}</option>`).join('');
  sel.value = S.data.meta.skin;
  $('skin-hint').textContent =
    S.skins.length > 1 ? '换皮肤会重排整页' : '目录 skins/ 下只有这一套。复制一份改改就是新皮肤。';

  sel.addEventListener('change', async () => {
    pushUndo();
    S.data.meta.skin = sel.value;
    const r = await fetch('/api/boot');
    const b = await r.json();
    S.defaults = b.defaults;
    markDirty();
    refreshKnobs();
    await rerender();
  });
}

function refreshSections() {
  buildSectionList($('sec-list'), S.data, {
    onJump: (i) => {
      const el = frame.contentDocument?.querySelector(`[data-row="sections.${i}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('sk-hot');
      setTimeout(() => el?.classList.remove('sk-hot'), 900);
    },
    onVariant: async (i) => {
      const order = ['entry', 'project', 'list'];
      const s = S.data.sections[i];
      pushUndo();
      s.variant = order[(order.indexOf(s.variant) + 1) % order.length];
      if (s.variant === 'list' && !s.items?.length) s.items = [blank('item')];
      if (s.variant !== 'list' && !s.entries?.length) s.entries = [blank('entry')];
      markDirty();
      refreshSections();
      await rerender();
    },
    onDelete: async (i) => {
      const s = S.data.sections[i];
      if (!confirm(`删掉整个章节「${s.title}」？`)) return;
      pushUndo();
      S.data.sections.splice(i, 1);
      markDirty();
      refreshSections();
      await rerender();
    },
    onMove: async (from, to) => {
      pushUndo();
      const [s] = S.data.sections.splice(from, 1);
      S.data.sections.splice(to, 0, s);
      markDirty();
      refreshSections();
      await rerender();
    },
  });
}

// ── 导出 ──

$('btn-export').addEventListener('click', async () => {
  S.paper?.flush();
  const formats = [...$('fmts').querySelectorAll('input:checked')].map((i) => i.value);
  const box = $('results');
  if (!formats.length) return toast('先勾一个格式', 'bad');

  const btn = $('btn-export');
  btn.disabled = true;
  btn.textContent = '导出中…';
  box.innerHTML = '<div class="err" style="color:var(--fg-3)">Chrome 起来要几秒…</div>';

  try {
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: S.data, formats }),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);

    box.innerHTML = j.files
      .map(
        (f) =>
          `<a href="${f.url}" download>${f.name}` +
          `<em>${kb(f.bytes)}${f.note ? ` · ${f.note}` : ''}</em></a>`,
      )
      .join('');
    toast(`导出了 ${j.files.length} 个文件，点上面的链接下载`, 'ok');
  } catch (e) {
    box.innerHTML = `<div class="err">${e.message}</div>`;
    toast(`导出失败：${e.message}`, 'bad', 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出';
  }
});

const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);

function quantifier(type) {
  if (type === 'section') return '一个';
  if (type === 'entry') return '一段';
  return '一条';
}

// ── 顶栏和快捷键 ──

$('btn-save').addEventListener('click', save);
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

$('btn-page-limit').addEventListener('click', async () => {
  pushUndo();
  S.data.meta.pages = isMultipage() ? 1 : 'auto';
  markDirty();
  refreshPageLimitButton();
  await rerender();
});

$('btn-add-section').addEventListener('click', async () => {
  pushUndo();
  S.data.sections.push(blank('section'));
  markDirty();
  refreshSections();
  await rerender();
  const els = frame.contentDocument?.querySelectorAll('[data-row^="sections."]');
  els?.[els.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 's') {
    e.preventDefault();
    save();
  } else if (e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
    e.preventDefault();
    redo();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!S.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// ── 格式条 ──

const fmtBar = $('fmt-bar');

function placeFmtBar(rect) {
  if (!rect) return (fmtBar.hidden = true);
  const f = frame.getBoundingClientRect();
  fmtBar.hidden = false;
  const w = fmtBar.offsetWidth || 64;
  fmtBar.style.left = `${Math.max(6, f.left + rect.left + rect.width / 2 - w / 2)}px`;
  fmtBar.style.top = `${f.top + rect.top - fmtBar.offsetHeight - 6}px`;
}

fmtBar.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const mark = e.target.closest('button')?.dataset.wrap;
  if (!mark) return;
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  const el = doc?.querySelector('.sk-editing');
  if (!el) return;
  el.dispatchEvent(
    new win.KeyboardEvent('keydown', {
      key: mark === '**' ? 'b' : 'e',
      metaKey: true,
      bubbles: true,
    }),
  );
});

// ── 提示条 ──

let toastTimer = null;
function toast(msg, kind = '', ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
