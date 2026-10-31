/**
 * 数据 → resume.yaml。
 *
 * 为什么不用 yaml 库的 stringify：
 * 这个文件是给人看的，头部有使用说明、每个章节前有分隔注释。库能保留
 * 已有注释，但工作台会增删章节 —— 注释挂在哪个节点上就成了猜谜。
 * 反正 schema 是我们自己定的，干脆自己写：注释由章节标题现推，
 * 加一节自动多一条分隔线，永远不会跟内容错位。
 *
 * 引号规则从严：拿不准就加引号。多余的引号不影响语义，
 * 少一个引号会让 `**重点**` 被 YAML 当成锚点引用直接报错。
 */

import { labelsFor } from './i18n.js';

const HEADER = `# ─────────────────────────────────────────────────────────────
#  简历数据。改这个文件就是改简历，版式不用动。
#
#  正文里支持三种行内标记：
#    **重点**         → 加粗（在要点里是深色强调，在技能里是轻量强调）
#    \`技术名\`         → 等宽 + 主题色，用来标 Redis / Explain / RocketMQ 这类术语
#    [文字](地址)     → 链接，PDF / HTML / Word 里都可以点
#
#  地址只认 http(s):// 、mailto: 、tel: 开头的，其它写法按普通文字输出。
#  三种标记可以互相嵌套，如 [**项目主页**](https://example.com)。
#  要输出字面量的 * \` [ ] 前面加反斜杠。
#
#  以 ** 开头的字符串必须加引号，否则 YAML 会把 * 当成锚点引用。
#
#  也可以跑 npm run studio 在浏览器里改，存盘会重写这个文件。
# ─────────────────────────────────────────────────────────────`;

const VARIANT_NOTE = {
  project: 'variant: project → 标题用项目样式，条目之间加细分割线',
  list: 'variant: list → 只有条目，没有标题行',
};

/** YAML 里会被误读的裸标量：留给库判断太啰嗦，直接列出来 */
const RESERVED = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/;

/** 需要引号吗 */
function needsQuote(s) {
  if (s === '') return true;
  if (RESERVED.test(s)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // 行首特殊字符
  if (/:\s|\s#/.test(s)) return true; // 键值分隔 / 行内注释
  if (/^\s|\s$/.test(s)) return true; // 首尾空白会被吃掉
  if (/[\n\r\t]/.test(s)) return true;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true; // 看着像数字
  return false;
}

/** 标量 → YAML 片段 */
function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (!needsQuote(s)) return s;
  // 双引号里只需要转义反斜杠和双引号，比单引号规则简单
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** { k: v } 这种短映射写成流式，跟手写的观感一致 */
function flowMap(obj) {
  const body = Object.entries(obj)
    .map(([k, v]) => `${k}: ${scalar(v)}`)
    .join(', ');
  return `{ ${body} }`;
}

export function emitYaml(data) {
  const L = [HEADER, ''];
  const meta = data.meta ?? {};

  L.push('meta:');
  L.push(`  skin: ${scalar(meta.skin ?? 'datasheet')}        # skins/ 下的目录名`);
  L.push(`  output: ${scalar(meta.output ?? 'resume')}     # 导出文件名，不含扩展名`);
  // auto 是裸标量，不能被 scalar() 加引号 —— "auto" 会被当成期望页数为字符串
  const pages = meta.pages === 'auto' ? 'auto' : Number(meta.pages ?? 1);
  L.push(`  pages: ${pages}${pages === 'auto' ? '            ' : '               '}# 期望页数；auto = 不限页数，按内容分页`);
  // 只在不是默认 A4 纵向时写：默认值写出来是噪音，但漏写就等于
  // 存一次盘把用户选的纸悄悄换回 A4
  const paper = meta.paper ?? {};
  if (paper.spec && paper.spec !== 'A4') {
    L.push(`  paper: ${scalar(paper.spec)}          # A4 / A3 / A5 / Letter / Legal，或 210x297（毫米）`);
  }
  if (paper.orientation === 'landscape') L.push('  orientation: landscape');
  if (meta.lang && meta.lang !== 'zh-CN') L.push(`  lang: ${scalar(meta.lang)}`);

  const theme = Object.entries(meta.theme ?? {}).filter(([, v]) => v !== '' && v != null);
  if (theme.length) {
    L.push('  # 版式微调：覆盖皮肤 :root 里的同名变量，工作台右侧面板写的就是这里');
    L.push('  theme:');
    // 键名带连字符（--fs 去掉前缀后是 fs，但配色键如 rule-soft 有横线），一律加引号最省心
    for (const [k, v] of theme) L.push(`    ${scalar(k)}: ${scalar(v)}`);
  }

  L.push('');
  L.push('profile:');
  L.push(`  name: ${scalar(data.profile?.name ?? '')}`);
  if (data.profile?.seeking) L.push(`  seeking: ${scalar(data.profile.seeking)}`);
  const contact = data.profile?.contact ?? [];
  if (contact.length) {
    L.push('  contact:');
    for (const c of contact) {
      L.push(`    - label: ${scalar(c.label)}`);
      L.push(`      value: ${scalar(c.value)}`);
      if (c.href) L.push(`      href: ${scalar(c.href)}`);
    }
  }

  L.push('');
  // 跟当前语言的默认标签一样就不写，写出来是噪音；换语言后也能跟着变
  const defaultBrief = labelsFor(meta.lang).brief;
  L.push('sections:');
  (data.sections ?? []).forEach((s, i) => {
    if (i > 0) L.push('');
    L.push(`  # ── ${s.title ?? ''} ${'─'.repeat(Math.max(4, 42 - width(s.title ?? '')))}`);
    const note = VARIANT_NOTE[s.variant];
    if (note) L.push(`  #  ${note}`);

    L.push(`  - title: ${scalar(s.title ?? '')}`);
    if (s.variant && s.variant !== 'entry') L.push(`    variant: ${scalar(s.variant)}`);

    if (s.variant === 'list') {
      L.push('    items:');
      for (const t of s.items ?? []) L.push(`      - ${scalar(textOf(t))}`);
      return;
    }

    L.push('    entries:');
    (s.entries ?? []).forEach((e, j) => {
      if (j > 0) L.push('');
      L.push(`      - org: ${scalar(e.org ?? '')}`);
      for (const k of ['badge', 'meta', 'when']) {
        if (e[k]) L.push(`        ${k}: ${scalar(e[k])}`);
      }
      if (e.briefLabel && e.briefLabel !== defaultBrief) {
        L.push(`        briefLabel: ${scalar(e.briefLabel)}`);
      }
      if (e.facts?.length) {
        L.push('        facts:');
        for (const f of e.facts) L.push(`          - ${flowMap({ k: f.k, v: f.v })}`);
      }
      if (e.brief) L.push(`        brief: ${scalar(e.brief)}`);
      if (e.points?.length) {
        L.push('        points:');
        for (const t of e.points) L.push(`          - ${scalar(textOf(t))}`);
      }
      if (e.awards?.length) {
        L.push('        awards:');
        for (const a of e.awards) {
          L.push(`          - name: ${scalar(a.name ?? '')}`);
          if (a.tier) L.push(`            tier: ${scalar(a.tier)}`);
          if (a.when) L.push(`            when: ${scalar(a.when)}`);
        }
      }
    });
  });

  return `${L.join('\n')}\n`;
}

const textOf = (t) => (typeof t === 'string' ? t : (t?.text ?? ''));

/** 中日韩字符占两格，分隔线才对得齐 */
function width(s) {
  let n = 0;
  for (const ch of s) n += /[⺀-鿿＀-｠]/.test(ch) ? 2 : 1;
  return n;
}
