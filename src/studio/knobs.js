/**
 * 右侧面板:版式旋钮、配色、皮肤、章节列表、导出。
 *
 * 旋钮改动是即时的:直接往 iframe 的 documentElement 上设自定义属性,
 * 不走服务端重渲染。拖滑块时每一帧都发一次 HTTP 会卡,
 * 而 CSS 变量本来就是为这种实时调整设计的。
 */

/** 能调的版式项。范围按皮肤实际可用区间给,拖到端点不会把排版拖坏。 */
const TYPE_KNOBS = [
  { key: 'fs', name: '正文字号', min: 7.5, max: 12, step: 0.05, unit: 'pt' },
  { key: 'lh', name: '行高', min: 1.15, max: 1.9, step: 0.005, unit: '' },
  { key: 'pad-x', name: '左右页边距', min: 6, max: 22, step: 0.5, unit: 'mm' },
  { key: 'pad-t', name: '上页边距', min: 5, max: 20, step: 0.5, unit: 'mm' },
  { key: 'pad-b', name: '下页边距', min: 4, max: 20, step: 0.5, unit: 'mm' },
];

const COLOR_KNOBS = [
  { key: 'petrol', name: '主题色' },
  { key: 'brass', name: '强调色' },
  { key: 'ink', name: '正文' },
  { key: 'ink-45', name: '次要文字' },
  { key: 'paper', name: '纸色' },
  { key: 'rule', name: '分隔线' },
];

const num = (v) => parseFloat(String(v ?? '')) || 0;

export function buildKnobs({ mountType, mountColor, defaults, theme, onChange }) {
  mountType.innerHTML = '';
  mountColor.innerHTML = '';

  for (const k of TYPE_KNOBS) {
    const base = num(defaults[k.key]);
    const cur = theme[k.key] != null ? num(theme[k.key]) : base;

    const box = document.createElement('div');
    box.className = 'knob';
    box.innerHTML =
      `<div class="knob-top"><label>${k.name}</label>` +
      `<span class="knob-val">${cur}${k.unit}</span></div>` +
      `<input type="range" min="${k.min}" max="${k.max}" step="${k.step}" value="${cur}">`;

    const val = box.querySelector('.knob-val');
    const input = box.querySelector('input');
    const paint = (v) => {
      val.textContent = `${v}${k.unit}`;
      val.classList.toggle('off', Math.abs(v - base) < 1e-9);
    };
    paint(cur);

    input.addEventListener('input', () => {
      const v = num(input.value);
      paint(v);
      // 跟默认值一样就把这条覆盖删掉,YAML 里少一行噪音
      onChange(k.key, Math.abs(v - base) < 1e-9 ? null : `${v}${k.unit}`);
    });
    // 双击回到皮肤默认
    val.addEventListener('dblclick', () => {
      input.value = base;
      paint(base);
      onChange(k.key, null);
    });

    mountType.appendChild(box);
  }

  for (const k of COLOR_KNOBS) {
    const base = String(defaults[k.key] ?? '#000000');
    const cur = theme[k.key] ?? base;

    const box = document.createElement('div');
    box.className = 'sw';
    box.innerHTML = `<input type="color" value="${hex(cur)}"><span>${k.name}</span>`;
    const input = box.querySelector('input');
    input.addEventListener('input', () => {
      onChange(k.key, input.value.toLowerCase() === hex(base) ? null : input.value.toUpperCase());
    });
    box.querySelector('span').addEventListener('dblclick', () => {
      input.value = hex(base);
      onChange(k.key, null);
    });
    mountColor.appendChild(box);
  }
}

/** input[type=color] 只吃 #rrggbb，三位简写和别的写法先补齐 */
function hex(c) {
  const s = String(c).trim();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return '#000000';
  return m[1].length === 3
    ? `#${m[1]
        .split('')
        .map((x) => x + x)
        .join('')}`.toLowerCase()
    : s.toLowerCase();
}

/** 章节列表：改标题、切形态、删、排序 */
export function buildSectionList(ul, data, { onJump, onVariant, onDelete, onMove }) {
  ul.innerHTML = '';
  data.sections.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="nm" title="点一下跳到这个章节">${escape(s.title)}</span>` +
      `<span class="vr" title="章节形态">${s.variant}</span>` +
      `<button data-act="up" title="上移">↑</button>` +
      `<button data-act="down" title="下移">↓</button>` +
      `<button data-act="del" title="删掉整个章节">×</button>`;

    li.querySelector('.nm').addEventListener('click', () => onJump(i));
    li.querySelector('.vr').addEventListener('click', () => onVariant(i));
    li.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'del') onDelete(i);
      if (act === 'up' && i > 0) onMove(i, i - 1);
      if (act === 'down' && i < data.sections.length - 1) onMove(i, i + 1);
    });
    ul.appendChild(li);
  });
}

const escape = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
