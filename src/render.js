/**
 * 数据 + 皮肤 → 单文件 HTML。
 *
 * CSS 直接内联，产物除了 fonts/ 之外不依赖任何外部资源，
 * 拷走一个 .html 就能在别的机器上打开。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { inline } from './markup.js';

/** 行内标记 helper。返回 SafeString，模板里用 {{md x}} 而不是三花括号。 */
Handlebars.registerHelper('md', (text) => new Handlebars.SafeString(inline(text)));

export function skinDir(root, name) {
  const dir = join(root, 'skins', name);
  if (!existsSync(dir)) throw new Error(`找不到皮肤 skins/${name}`);
  for (const f of ['template.hbs', 'style.css']) {
    if (!existsSync(join(dir, f))) throw new Error(`皮肤 skins/${name} 缺少 ${f}`);
  }
  return dir;
}

/**
 * @param {object} data      normalize 之后的数据
 * @param {string} root      项目根目录
 * @param {object} [opts]
 * @param {boolean} [opts.fit]   注入尺寸探针（build/pdf 用，用来判断有没有溢出）
 * @param {number}  [opts.reload] 注入自动刷新，值为轮询间隔毫秒（dev 用）
 * @param {string}  [opts.baseHref] 注入 <base>，srcdoc 加载时相对路径才有基准
 * @returns {string} 完整 HTML
 */
export function render(data, root, opts = {}) {
  const dir = skinDir(root, data.meta.skin);
  const tpl = Handlebars.compile(readFileSync(join(dir, 'template.hbs'), 'utf8'), {
    noEscape: false,
    strict: false,
  });

  const scripts = [];
  if (opts.fit) scripts.push(readFileSync(join(root, 'src', 'fit-probe.js'), 'utf8'));
  if (opts.reload) scripts.push(reloadSnippet(opts.reload));

  const html = tpl({
    ...data,
    css: new Handlebars.SafeString(readFileSync(join(dir, 'style.css'), 'utf8')),
    // 主题覆盖必须排在皮肤 CSS 后面：同名自定义属性靠先后顺序决胜，
    // 后写的赢。所以模板里 {{themeStyle}} 紧跟在 </style> 之后。
    themeStyle: new Handlebars.SafeString(themeStyle(data.meta.theme)),
    script: scripts.length
      ? new Handlebars.SafeString(`<script>\n${scripts.join('\n')}\n</script>`)
      : '',
  });

  // srcdoc 装出来的文档没有 URL，CSS 里 ./fonts/... 会解析到工作台外壳那一层
  // 而不是字体目录，中日韩字体直接回落到系统字体、行高全变。补个 <base> 兜住。
  return opts.baseHref
    ? html.replace(/<head>/i, `<head>\n<base href="${opts.baseHref}">`)
    : html;
}

/**
 * meta.theme → 一段 :root 覆盖。
 *
 * 键名不带 `--`（YAML 里写 fs: 9pt 比写 "--fs": 9pt 顺眼），这里补上。
 */
export function themeStyle(theme) {
  const kv = Object.entries(theme ?? {}).filter(([, v]) => v !== '' && v != null);
  if (!kv.length) return '';
  const body = kv.map(([k, v]) => `--${k.replace(/^--/, '')}:${v}`).join(';');
  return `<style id="theme-overrides">:root{${body}}</style>`;
}

/** dev 模式的土办法自动刷新：轮询 /__version，变了就 reload */
function reloadSnippet(interval) {
  return `
(() => {
  let seen = null;
  setInterval(async () => {
    try {
      const v = await (await fetch('/__version', { cache: 'no-store' })).text();
      if (seen !== null && v !== seen) location.reload();
      seen = v;
    } catch {}
  }, ${interval});
})();`;
}
