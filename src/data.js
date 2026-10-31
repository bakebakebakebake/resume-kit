/**
 * YAML → 渲染用的数据结构。
 *
 * 这一层做三件事：读文件、把简写补全成模板能直接消费的形状、校验。
 * 模板里不做判断逻辑，需要什么标志位都在这里算好。
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { lintInline } from './markup.js';
import { resolvePaper, PAPER_NAMES } from './paper.js';
import { labelsFor, DEFAULT_LANG } from './i18n.js';

const VARIANTS = new Set(['entry', 'project', 'list']);

/** 读并解析 YAML，出错时带上文件名和行号 */
export function load(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到数据文件 ${file}：${e.message}`);
  }
  let doc;
  try {
    doc = parse(raw);
  } catch (e) {
    const at = e.linePos?.[0] ? `第 ${e.linePos[0].line} 行` : '位置未知';
    throw new Error(`${file} YAML 解析失败（${at}）：${e.message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error(`${file} 是空的或顶层不是映射`);
  }
  return normalize(doc);
}

/**
 * 每个可编辑字段都带一个 `_p`：它在数据里的路径。
 *
 * 工作台是在渲染好的页面上直接改字的，改完必须知道这段文字对应
 * 数据里的哪一格才能存回去。模板把 `_p` 写成 data-bind 属性，
 * 浏览器那边就有了 DOM ↔ 数据的双向地址。
 *
 * 因此 points / items 从裸字符串升成了 `{text, _p}`：
 * 字符串挂不住路径。
 */
/**
 * meta.pages 允许两种写法：正整数（期望几页）或 `auto`（不限页数）。
 *
 * 单页是简历的常态，所以默认 1，且默认那套 `.sheet` 是固定高度 +
 * overflow:hidden —— 超出会被裁掉，这是有意的约束。写 auto 或大于 1 的数
 * 就切到流式排版，纸张按内容长高、PDF 自然分页。
 *
 * @returns {number|'auto'}
 */
function parsePages(v) {
  if (v == null) return 1;
  if (typeof v === 'string' && v.trim().toLowerCase() === 'auto') return 'auto';
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function normalize(doc) {
  const meta = doc.meta ?? {};
  const profile = doc.profile ?? {};
  const pages = parsePages(meta.pages);
  const lang = meta.lang ?? DEFAULT_LANG;
  const L = labelsFor(lang);

  return {
    meta: {
      skin: meta.skin ?? 'datasheet',
      output: meta.output ?? profile.name ?? 'resume',
      pages,
      // 是否放开一页的硬限制。模板和探针只认这个布尔值，
      // 免得每处都重复判断 'auto' 和数字两种形态。
      multipage: pages === 'auto' || (Number.isFinite(pages) && pages > 1),
      // 纸张几何：渲染、探针、DOCX、工作台视口都从这一份读
      paper: resolvePaper(meta.paper, meta.orientation),
      lang,
      // 版式旋钮：只存跟皮肤默认值不同的那几个，空对象就是纯用皮肤的
      theme: { ...(meta.theme ?? {}) },
    },
    profile: {
      name: profile.name ?? '',
      seeking: profile.seeking ?? '',
      contact: (profile.contact ?? []).map((c, i) => ({
        label: c.label ?? '',
        value: c.value ?? '',
        href: c.href ?? null,
        _p: `profile.contact.${i}`,
      })),
    },
    sections: (doc.sections ?? []).map((s, i) => normalizeSection(s, i, L)),
  };
}

function normalizeSection(s, i, L) {
  const variant = s.variant ?? 'entry';
  const at = `sections.${i}`;
  return {
    title: s.title ?? `${L.untitled} ${i + 1}`,
    variant,
    // Handlebars 的 #if 只看真假，比较字符串要额外 helper，
    // 所以标志位在这里就摊平。
    isProject: variant === 'project',
    isList: variant === 'list',
    _p: at,
    items: (s.items ?? []).map((t, k) => ({
      text: typeof t === 'string' ? t : (t?.text ?? ''),
      _p: `${at}.items.${k}`,
    })),
    entries: (s.entries ?? []).map((e, j) => {
      const eat = `${at}.entries.${j}`;
      return {
        org: e.org ?? '',
        badge: e.badge ?? null,
        meta: e.meta ?? null,
        when: e.when ?? null,
        brief: e.brief ?? null,
        briefLabel: e.briefLabel ?? L.brief,
        _p: eat,
        facts: (e.facts ?? []).map((f, k) => ({
          k: f.k ?? '',
          v: f.v ?? '',
          _p: `${eat}.facts.${k}`,
        })),
        awards: (e.awards ?? []).map((a, k) => ({
          name: a.name ?? '',
          tier: a.tier ?? null,
          when: a.when ?? null,
          _p: `${eat}.awards.${k}`,
        })),
        points: (e.points ?? []).map((t, k) => ({
          text: typeof t === 'string' ? t : (t?.text ?? ''),
          _p: `${eat}.points.${k}`,
        })),
      };
    }),
  };
}

/**
 * 工作台传回来的数据已经是 normalize 后的形状，但索引可能被
 * 增删拖动搞乱了（删掉第 2 条之后，第 3 条的 _p 还写着 .2）。
 * 存盘和重渲染之前都过一遍这个，把路径按当前顺序重排。
 */
export function reindex(data) {
  // 工作台切页数模式时只改 meta.pages，派生标志得跟着重算，
  // 否则重渲染出来的还是上一次的排版模式。
  if (data.meta) {
    const p = parsePages(data.meta.pages);
    data.meta.pages = p;
    data.meta.multipage = p === 'auto' || (Number.isFinite(p) && p > 1);
    // 工作台换纸时传回来的是纸张名，这里解析回完整几何；
    // 已经是解析过的对象则原样放行（resolvePaper 自己认得）
    data.meta.paper = resolvePaper(data.meta.paper, data.meta.paper?.orientation);
  }
  const L = labelsFor(data.meta?.lang);
  data.sections.forEach((s, i) => {
    const at = `sections.${i}`;
    s._p = at;
    s.isProject = s.variant === 'project';
    s.isList = s.variant === 'list';
    s.items?.forEach((t, k) => (t._p = `${at}.items.${k}`));
    s.entries?.forEach((e, j) => {
      const eat = `${at}.entries.${j}`;
      e._p = eat;
      // 工作台新建的条目不带标签，语言只有服务端知道
      e.briefLabel ??= L.brief;
      e.facts?.forEach((f, k) => (f._p = `${eat}.facts.${k}`));
      e.awards?.forEach((a, k) => (a._p = `${eat}.awards.${k}`));
      e.points?.forEach((t, k) => (t._p = `${eat}.points.${k}`));
    });
  });
  data.profile.contact?.forEach((c, i) => (c._p = `profile.contact.${i}`));
  return data;
}

/**
 * 结构与标记校验。返回的每条都带数据路径，方便定位。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function lint(data) {
  const errors = [];
  const warnings = [];

  if (!data.profile.name) errors.push('profile.name 不能为空');
  if (data.meta.pages !== 'auto' && (!Number.isFinite(data.meta.pages) || data.meta.pages < 1)) {
    errors.push('meta.pages 必须是不小于 1 的整数，或 auto（不限页数）');
  }
  if (data.meta.paper && !data.meta.paper.valid) {
    errors.push(
      `meta.paper 不认识，可选：${PAPER_NAMES.join(' / ')}，或自定义如 210x297（毫米）。已按 A4 出图`,
    );
  }
  if (!data.sections.length) warnings.push('sections 是空的，简历只有页头');

  data.sections.forEach((s, si) => {
    const at = `sections[${si}] (${s.title})`;
    if (!VARIANTS.has(s.variant)) {
      errors.push(`${at}.variant = "${s.variant}" 不认识，可选：${[...VARIANTS].join(' / ')}`);
    }
    if (s.isList) {
      if (!s.items.length) warnings.push(`${at} 是 list 但 items 为空`);
      if (s.entries.length) warnings.push(`${at} 是 list，entries 会被忽略`);
    } else {
      if (!s.entries.length) warnings.push(`${at} 没有 entries`);
      if (s.items.length) warnings.push(`${at} 不是 list，items 会被忽略`);
    }

    s.items.forEach((t, i) => pushInline(warnings, `${at}.items[${i}]`, t.text));
    s.entries.forEach((e, ei) => {
      const eat = `${at}.entries[${ei}] (${e.org || '无标题'})`;
      if (!e.org) errors.push(`${eat}.org 不能为空`);
      pushInline(warnings, `${eat}.brief`, e.brief);
      e.points.forEach((p, i) => pushInline(warnings, `${eat}.points[${i}]`, p.text));
      e.awards.forEach((a, i) => pushInline(warnings, `${eat}.awards[${i}].name`, a.name));
    });
  });

  return { errors, warnings };
}

function pushInline(bin, path, text) {
  for (const issue of lintInline(text)) bin.push(`${path}：${issue}`);
}
