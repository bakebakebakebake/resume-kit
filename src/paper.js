/**
 * 纸张几何 —— 全项目唯一的一份。
 *
 * 210 / 297 之前散在五个地方：皮肤 CSS、排版探针、DOCX 的页面设置、
 * 工作台的纸张视口、PNG 的窗口尺寸。改一处得记得改另外四处，
 * 漏了不报错 —— 只是导出来的东西尺寸悄悄不对。
 *
 * 不同文档类型用不同的纸，所以这里是参数不是常量。
 * 眼下由 meta.paper 提供，之后交给文档类型 manifest。
 */

export const PX_PER_MM = 96 / 25.4;

/**
 * 常用纸张，单位毫米。
 *
 * cssName 是 CSS `@page size` 认得的关键字。有关键字就用关键字、
 * 不换算成等值的毫米：少一层我们自己做的取整，产物尺寸就少一个
 * 对不上的理由。自定义尺寸没有关键字，才落到 `宽mm 高mm`。
 */
const SIZES = {
  a4: { name: 'A4', w: 210, h: 297, cssName: 'A4' },
  a3: { name: 'A3', w: 297, h: 420, cssName: 'A3' },
  a5: { name: 'A5', w: 148, h: 210, cssName: 'A5' },
  letter: { name: 'Letter', w: 215.9, h: 279.4, cssName: 'letter' },
  legal: { name: 'Legal', w: 215.9, h: 355.6, cssName: 'legal' },
};

export const PAPER_NAMES = Object.values(SIZES).map((s) => s.name);

/** "210x297" / "210 × 297 mm" → { w, h }，认不出来返回 null */
function parseCustom(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?$/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * 解析纸张规格。
 *
 * 不抛异常：跟 meta.pages 一样，认不出来先按 A4 兜住、把 valid 置假，
 * 让 lint 去报错并指出是哪一行 —— 载入阶段就炸掉的话，
 * 工作台连打开都打不开，改都没法改。
 *
 * @param {string|object|null} spec  'A4' / '210x297' / { w, h }，或已解析过的对象
 * @param {string} [orientation]     portrait（默认）/ landscape
 * @returns {{name, spec, orientation, w, h, cssSize, valid}}
 */
export function resolvePaper(spec, orientation) {
  // 工作台回传的数据里 meta.paper 已经是解析过的对象，原样放行 ——
  // 再解析一遍会把 'A4' 降级成自定义尺寸，存盘时纸张名就丢了。
  if (spec && typeof spec === 'object' && spec.cssSize) return spec;

  let base = null;
  let valid = true;

  if (spec == null || spec === '') {
    base = SIZES.a4;
  } else if (typeof spec === 'object') {
    const w = Number(spec.w);
    const h = Number(spec.h);
    base = w > 0 && h > 0 ? { name: `${w}×${h}mm`, w, h, cssName: null } : null;
  } else {
    const key = String(spec).trim().toLowerCase();
    if (SIZES[key]) {
      base = SIZES[key];
    } else {
      const custom = parseCustom(spec);
      base = custom ? { name: `${custom.w}×${custom.h}mm`, ...custom, cssName: null } : null;
    }
  }

  if (!base) {
    base = SIZES.a4;
    valid = false;
  }

  const landscape = String(orientation ?? '').trim().toLowerCase() === 'landscape';
  const w = landscape ? base.h : base.w;
  const h = landscape ? base.w : base.h;

  return {
    name: base.name,
    // 回写 YAML 用的原始写法，横向另外记在 orientation 里，不揉进这里
    spec: base.cssName ? base.name : `${base.w}x${base.h}mm`,
    orientation: landscape ? 'landscape' : 'portrait',
    w,
    h,
    cssSize: base.cssName ? `${base.cssName}${landscape ? ' landscape' : ''}` : `${w}mm ${h}mm`,
    valid,
  };
}

/** 毫米 → CSS 像素（96dpi），取整。工作台视口和截图窗口按这个来。 */
export const toPx = (mm) => Math.round(mm * PX_PER_MM);

/**
 * 窄屏断点：比纸再宽一点。
 *
 * 视口正好等于纸宽时不该命中窄屏规则 —— 那是给手机看的版式
 * （定高变自动、字号变大），一旦在等于纸宽的视口里命中，
 * 排版和量出来的高度就全是错的。留 26px 余量。
 */
export const narrowBreakpoint = (paper) => toPx(paper.w) + 26;
