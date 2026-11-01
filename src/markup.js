/**
 * 行内标记 → HTML。
 *
 *   **重点**        → <span class="lead">重点</span>
 *   `技术名`        → <span class="t">技术名</span>
 *   [文字](地址)    → <a class="lk" href="地址">文字</a>
 *   \** \` \[ \]   → 转义，输出字面量
 *
 * 处理顺序是粗体 → 链接 → 代码，三者可以互相嵌套：
 * 粗体产出的 HTML 不含方括号和反引号，链接产出的 HTML 不含反引号，
 * 所以后一步不会啃到前一步的产物。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const PLACEHOLDER = '\u0000';

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ESC[c]);
}

/** 抽出 \x 转义序列，避免它们参与后续匹配 */
function stashEscapes(s, bin) {
  return s.replace(/\\([*`[\]\\])/g, (_, ch) => {
    bin.push(ch);
    return `${PLACEHOLDER}${bin.length - 1}${PLACEHOLDER}`;
  });
}

function restoreEscapes(s, bin) {
  return s.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (_, i) => escapeHtml(bin[Number(i)]),
  );
}

/**
 * 链接：[文字](地址)。
 * 文字里不许再出现方括号，地址里不许出现空白和右括号 —— 简历里的链接
 * 都是干干净净的 URL 或 mailto，放宽了只会让漏写右括号的行整段被吞掉。
 */
const LINK_RE = /\[([^[\]]+?)\]\(\s*([^\s)]+)\s*\)/g;

/**
 * 只放行确定安全的协议。
 *
 * 这些字符串最终会进 href，而 HTML 导出是要发给别人打开的 ——
 * `javascript:` 混进来就是一个能在别人机器上执行的脚本。
 * 认不出来的一律当普通文字，不产出链接。
 */
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|#|\/|\.\.?\/)/i;
export const isSafeUrl = (u) => SAFE_URL.test(String(u ?? '').trim());

/**
 * @param {string} input 原始文本
 * @returns {string} HTML 片段
 */
export function inline(input) {
  if (input == null) return '';
  const bin = [];
  let s = stashEscapes(String(input), bin);
  s = escapeHtml(s);
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<span class="lead">$1</span>');
  s = s.replace(LINK_RE, (m, text, href) =>
    isSafeUrl(href) ? `<a class="lk" href="${href}">${text}</a>` : m,
  );
  s = s.replace(/`([^`]+?)`/g, '<span class="t">$1</span>');
  return restoreEscapes(s, bin);
}

/**
 * 同样的标记，但拆成片段而不是 HTML。
 *
 * DOCX 里没有"嵌套 span"这回事，一段文字得摊平成一串各自带格式的 run，
 * 所以导出 Word 时用这个而不是 inline()。两边共用上面那套转义规则，
 * 语法只有一处定义。
 *
 * 这里必须递归下降，不能像 inline() 那样顺次 replace：
 * inline() 的中间产物是 HTML，`[**粗** 尾](url)` 里的粗体先变成
 * 不含方括号的 <span>，链接正则照样能匹配到整段。但 tokens() 处理的是
 * 原始文本，先切粗体会把链接的方括号和圆括号劈到两个片段里，
 * 链接就再也拼不回来了。
 *
 * @param {string} input
 * @returns {Array<{text: string, bold: boolean, code: boolean, href: string|null}>}
 */
export function tokens(input) {
  if (input == null) return [];
  const bin = [];
  const out = [];
  walk(stashEscapes(String(input), bin), { bold: false, code: false, href: null }, out, bin);
  return out;
}

// 非全局版本：walk 里每次都从当前剩余串的头部找，不需要 lastIndex
const BOLD_ONE = /\*\*([\s\S]+?)\*\*/;
const CODE_ONE = /`([^`]+?)`/;
const LINK_ONE = /\[([^[\]]+?)\]\(\s*([^\s)]+)\s*\)/;

/**
 * 从左往右找最靠前的一处标记，递归进它的内容，然后接着扫剩下的。
 * 位置相同时的优先级和 inline() 的 replace 顺序一致：粗体 → 链接 → 代码。
 */
function walk(s, ctx, out, bin) {
  let rest = s;
  while (rest) {
    const hits = [];
    const b = BOLD_ONE.exec(rest);
    if (b) hits.push({ at: b.index, m: b, rank: 0, kind: 'bold' });
    const l = LINK_ONE.exec(rest);
    if (l) hits.push({ at: l.index, m: l, rank: 1, kind: 'link' });
    const c = CODE_ONE.exec(rest);
    if (c) hits.push({ at: c.index, m: c, rank: 2, kind: 'code' });

    if (!hits.length) {
      emit(rest, ctx, out, bin);
      return;
    }
    hits.sort((x, y) => x.at - y.at || x.rank - y.rank);
    const hit = hits[0];

    if (hit.at > 0) emit(rest.slice(0, hit.at), ctx, out, bin);

    if (hit.kind === 'bold') {
      walk(hit.m[1], { ...ctx, bold: true }, out, bin);
    } else if (hit.kind === 'code') {
      walk(hit.m[1], { ...ctx, code: true }, out, bin);
    } else if (isSafeUrl(hit.m[2])) {
      walk(hit.m[1], { ...ctx, href: hit.m[2].trim() }, out, bin);
    } else {
      // 协议不认识就整段按字面量输出，和 inline() 保持一致
      emit(hit.m[0], ctx, out, bin);
    }

    rest = rest.slice(hit.at + hit.m[0].length);
  }
}

function emit(text, ctx, out, bin) {
  const s = text.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (_, i) => bin[Number(i)],
  );
  if (!s) return;
  // 和前一段格式相同就并进去，免得 DOCX 里出现一串属性完全一样的 run
  const prev = out[out.length - 1];
  if (prev && prev.bold === ctx.bold && prev.code === ctx.code && prev.href === ctx.href) {
    prev.text += s;
    return;
  }
  out.push({ text: s, bold: ctx.bold, code: ctx.code, href: ctx.href });
}

/**
 * tokens() 的逆运算：一串带格式的片段 → 标记文本。
 *
 * 工作台所见即所得编辑时，用户改的是渲染后的 DOM，提交时把 DOM 读成片段，
 * 再经这里写回数据。约束只有一条：inline(fromTokens(runs)) 渲染出的
 * 文字和格式要和 runs 一致。
 *
 * 嵌套顺序固定为 链接 ⊃ 粗体 ⊃ 代码，和 inline() 的处理顺序对得上：
 * 粗体在链接里面先被替换成 <span>，不含方括号，链接正则照样能匹配；
 * 代码在最里层，它的反引号不会被前两步碰到。
 *
 * @param {Array<{text: string, bold?: boolean, code?: boolean, href?: string|null}>} runs
 * @returns {string}
 */
export function fromTokens(runs) {
  const rs = (runs ?? []).filter((r) => r && r.text);
  let out = '';
  for (const g of groupBy(rs, (r) => (r.href && isSafeUrl(r.href) ? r.href.trim() : null))) {
    const body = groupBy(g.items, (r) => !!r.bold)
      .map((b) => {
        const inner = groupBy(b.items, (r) => !!r.code)
          .map((c) => {
            const text = c.items.map((r) => r.text).join('');
            return c.key ? `\`${escapeText(text)}\`` : escapeText(text);
          })
          .join('');
        return b.key ? `**${inner}**` : inner;
      })
      .join('');
    out += g.key ? `[${body}](${encodeHref(g.key)})` : body;
  }
  return out;
}

/** 相邻且 key 相同的归成一组 */
function groupBy(items, keyOf) {
  const groups = [];
  for (const it of items) {
    const key = keyOf(it);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, items: [it] });
  }
  return groups;
}

/**
 * 字面量转义。星号、反引号、方括号一律转义；反斜杠只在会被误读时转义
 * （后面跟着能转义的字符，或者在末尾挨着下一段的标记），
 * 免得 `C:\Users` 这种路径每次编辑都被改写一遍。
 */
function escapeText(s) {
  return s.replace(/\\(?=[*`[\]\\]|$)|[*`[\]]/g, (c) => `\\${c}`);
}

/** 链接地址里不许有空白和右括号（见 LINK_RE），用百分号编码绕开 */
const encodeHref = (u) =>
  u.replace(/[\s()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * 找出没闭合的标记。写数据时漏一个星号很常见，
 * 渲染出来只是少了加粗，肉眼不容易发现，所以显式报出来。
 *
 * @param {string} input
 * @returns {string[]} 问题描述
 */
export function lintInline(input) {
  if (input == null) return [];
  const bin = [];
  const s = stashEscapes(String(input), bin);
  const issues = [];

  const stars = (s.match(/\*\*/g) || []).length;
  if (stars % 2 !== 0) issues.push('`**` 数量为奇数，有未闭合的加粗');

  const ticks = (s.match(/`/g) || []).length;
  if (ticks % 2 !== 0) issues.push('反引号数量为奇数，有未闭合的代码标记');

  if (/\*(?!\*)/.test(s.replace(/\*\*/g, ''))) {
    issues.push('出现单个 `*`，加粗需要两个星号；字面量请写 `\\*`');
  }

  // 链接漏了右括号只是少个链接，页面上看不出来，得报出来。
  const links = s.match(LINK_RE)?.length ?? 0;
  const brackets = (s.match(/\[/g) || []).length;
  if (brackets > links) {
    issues.push('有 `[` 没配成链接，格式是 `[文字](地址)`；字面量请写 `\\[`');
  }

  for (const m of s.matchAll(LINK_RE)) {
    if (!isSafeUrl(m[2])) {
      issues.push(`链接地址 \`${m[2]}\` 不是 http/https/mailto/tel，会按普通文字输出`);
    }
  }
  return issues;
}
