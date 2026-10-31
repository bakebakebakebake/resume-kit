/**
 * 纸面基础层 —— 所有皮肤共享的页面几何。
 *
 * 皮肤只管长相（配色、字体、间距、层级），纸多大、超出裁不裁、
 * 怎么分页由这里说了算。之前这些规则抄在每张皮肤里，
 * 加第二张皮肤就得连着抄一遍，抄漏一条不报错 ——
 * 只是导出的纸尺寸悄悄不对。
 *
 * 排在皮肤 CSS 之前输出：同优先级下后写的赢，
 * 皮肤想覆盖某条基础规则仍然覆盖得掉。
 */

import { narrowBreakpoint } from './paper.js';

/** 皮肤里写这个占位符来表示「窄屏断点」，断点值由纸宽算出 */
const NARROW_TOKEN = /@media\s+screen\s+and\s+\(\s*max-width\s*:\s*NARROW\s*\)/g;

/**
 * 把皮肤 CSS 里的断点占位符换成真实像素值。
 *
 * 媒体查询的条件里用不了 CSS 变量，所以断点没法像颜色那样
 * 靠自定义属性传下去，只能在这里做文本替换。
 */
export function resolveNarrow(css, paper) {
  return css.replace(NARROW_TOKEN, `@media screen and (max-width:${narrowBreakpoint(paper)}px)`);
}

/**
 * 拼装最终样式表：@import 在最前，然后基础层，然后皮肤。
 *
 * @import 必须排在所有规则之前，否则整条被丢掉。皮肤第一行就是
 * 字体 @import，被基础层挤到后面的话，中日韩正文会静默回落到系统字体 ——
 * 行高和字形全变，不报任何错，只能靠"导出来的东西看着不对"发现。
 *
 * @param {string} skinCss 皮肤原始 CSS
 * @param {object} paper   resolvePaper() 的结果
 */
export function composeCss(skinCss, paper) {
  const hoisted = [];
  const rest = skinCss.replace(/@(?:import|charset)\b[^;]*;/g, (m) => {
    hoisted.push(m.trim());
    return '';
  });
  return [...hoisted, pageCss(paper), resolveNarrow(rest, paper)].join('\n');
}

/**
 * @param {object} paper  resolvePaper() 的结果
 * @returns {string} 基础层 CSS
 */
export function pageCss(paper) {
  const { w, h, cssSize } = paper;
  const narrow = narrowBreakpoint(paper);

  return `
/* ═══ 纸面基础层（由 src/page-css.js 生成，勿在皮肤里覆盖几何）═══ */
@page{size:${cssSize};margin:0}

.sheet{
  width:${w}mm;
  height:${h}mm;
  margin:0 auto;
  position:relative;
  overflow:hidden;
}

/* 不限页数（meta.pages: auto 或 > 1）：
   纸张按内容长高，打印时浏览器自然分页；同时约束分页点，
   免得标题落在页底、和它的内容被劈开。 */
html[data-pages="auto"] .sheet{
  height:auto;
  min-height:${h}mm;
  overflow:visible;
}
html[data-pages="auto"] .sec{break-inside:auto}
html[data-pages="auto"] .sec-title{break-after:avoid}
html[data-pages="auto"] .entry,
html[data-pages="auto"] .pts li,
html[data-pages="auto"] .aw{break-inside:avoid}

/* 窄屏：放开定高，否则手机上内容直接被裁。
   断点比纸宽多留 26px —— 视口正好等于纸宽时不该命中这套规则。 */
@media screen and (max-width:${narrow}px){
  .sheet{width:100%;height:auto;overflow:visible}
}

@media print{
  *{
    -webkit-print-color-adjust:exact !important;
    print-color-adjust:exact !important;
    color-adjust:exact !important;
  }
  html,body{padding:0 !important;margin:0 !important}
  .sheet{
    margin:0 !important;
    box-shadow:none !important;
    width:${w}mm !important;
    height:${h}mm !important;
    overflow:hidden !important;
  }
  /* 不限页数时不能锁死高度，否则第二页开始全是空白 */
  html[data-pages="auto"] .sheet{
    height:auto !important;
    min-height:${h}mm !important;
    overflow:visible !important;
  }
}
`;
}
