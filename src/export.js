/**
 * 一份数据 → 四种格式。
 *
 * PDF / PNG 走同一个 headless Chrome 管线，看到的和导出的是同一套 CSS，
 * 所见即所得这句话在这两个格式上是字面意思。
 * HTML 是把字体内联进去的单文件，发给谁都能打开。
 * DOCX 是另一条路（见 docx.js 开头那段），语义对，版式不保证一致。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, cpSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { render } from './render.js';
import { toPdf, toPng } from './pdf.js';
import { toDocx } from './docx.js';
import { rootVars } from './skin-vars.js';

const KNOWN = ['pdf', 'png', 'docx', 'html'];

/**
 * @param {object} o
 * @param {string} o.ROOT
 * @param {string} o.outDir
 * @param {object} o.data     reindex 后的数据
 * @param {string[]} o.formats
 * @returns {Promise<Array<{name, format, bytes, note}>>}
 */
export async function exportAll({ ROOT, outDir, data, formats }) {
  const want = (formats?.length ? formats : ['pdf']).filter((f) => KNOWN.includes(f));
  if (!want.length) throw new Error(`没有可导出的格式，支持：${KNOWN.join(' / ')}`);

  mkdirSync(outDir, { recursive: true });
  const base = data.meta.output || data.profile.name || 'resume';
  const out = [];

  // PDF 和 PNG 都要一个磁盘上的 HTML 给 Chrome 打开。
  // 字体按相对路径引用，所以必须连 fonts/ 一起放到 outDir。
  let stagedHtml = null;
  const stage = () => {
    if (stagedHtml) return stagedHtml;
    const html = render(data, ROOT, { fit: true });
    stagedHtml = join(outDir, `${base}.html`);
    writeFileSync(stagedHtml, html, 'utf8');
    if (existsSync(join(ROOT, 'fonts'))) {
      cpSync(join(ROOT, 'fonts'), join(outDir, 'fonts'), { recursive: true });
    }
    return stagedHtml;
  };

  for (const f of want) {
    if (f === 'pdf') {
      const p = join(outDir, `${base}.pdf`);
      const pages = await toPdf(stage(), p);
      out.push({
        name: `${base}.pdf`,
        format: 'pdf',
        bytes: statSync(p).size,
        note: pages ? `${pages} 页` : '',
      });
    }

    if (f === 'png') {
      const p = join(outDir, `${base}.png`);
      const size = await toPng(stage(), p);
      out.push({
        name: `${base}.png`,
        format: 'png',
        bytes: statSync(p).size,
        note: size ? `${size.w}×${size.h}` : '',
      });
    }

    if (f === 'html') {
      const p = join(outDir, `${base}-单文件.html`);
      const html = renderInlined(data, ROOT);
      writeFileSync(p, html, 'utf8');
      out.push({
        name: `${base}-单文件.html`,
        format: 'html',
        bytes: statSync(p).size,
        note: '字体已内联，可单独发送',
      });
    }

    if (f === 'docx') {
      const p = join(outDir, `${base}.docx`);
      writeFileSync(p, toDocx(data, rootVars(ROOT, data.meta.skin)));
      out.push({
        name: `${base}.docx`,
        format: 'docx',
        bytes: statSync(p).size,
        note: '语义版式，与 PDF 不完全一致',
      });
    }
  }

  return out;
}

/**
 * 单文件 HTML：把字体也塞进去。
 *
 * 体积会涨到 3MB 上下（base64 比二进制大三分之一），换来的是
 * 一个文件拷到任何地方都长一个样 —— 相对路径的字体一旦丢了，
 * 中日韩正文会回落到系统字体，行高全变、一页变两页。
 *
 * 基准目录是 ROOT 而不是皮肤目录：皮肤 CSS 里写的是 `./fonts/xxx.woff2`，
 * 那个 `./` 相对的是产物 HTML 所在的位置（所以 stage() 才要把 fonts/
 * 拷到 outDir 去），不是 style.css 自己所在的位置。
 * 按皮肤目录去找会找不到文件，@import 被当成"取不到"直接丢掉，
 * 字体一个都内联不进来，而且不报错 —— 只是导出的文件小得可疑。
 */
function renderInlined(data, ROOT) {
  const html = render(data, ROOT, { fit: false });
  return html.replace(/<style>([\s\S]*?)<\/style>/, (m, css) => {
    const { css: out, missed } = inlineAssets(css, ROOT);
    if (missed.length) {
      console.warn(`  ! 有 ${missed.length} 个资源没内联进去：${missed.slice(0, 3).join('、')}`);
    }
    return `<style>${out}</style>`;
  });
}

const MIME_BY_EXT = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/**
 * 递归把 @import 展开、把 url() 换成 data URL。
 *
 * @returns {{css: string, missed: string[]}} missed 是没找到的引用；
 *   一个都内联不上也能产出文件，但得让人知道，不然只能靠"体积不对"发现。
 */
function inlineAssets(css, baseDir) {
  const missed = [];

  const walk = (text, dir, depth) => {
    if (depth > 4) return text;

    // @import 先展开：展开出来的内容里还有 url() 要处理，
    // 而且里面的相对路径是相对被 import 的那个文件，所以 dir 要跟着换。
    text = text.replace(/@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*;?/g, (m, ref) => {
      if (/^https?:/.test(ref)) {
        missed.push(ref); // 外部样式表内联不了，单文件不该依赖网络
        return '';
      }
      const f = join(dir, ref);
      if (!existsSync(f)) {
        missed.push(ref);
        return '';
      }
      return walk(readFileSync(f, 'utf8'), dirname(f), depth + 1);
    });

    return text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, ref) => {
      if (/^(data:|https?:)/.test(ref)) return m;
      const f = join(dir, ref.replace(/[?#].*$/, ''));
      if (!existsSync(f)) {
        missed.push(ref);
        return m;
      }
      const mime = MIME_BY_EXT[extname(f).toLowerCase()] ?? 'application/octet-stream';
      return `url(data:${mime};base64,${readFileSync(f).toString('base64')})`;
    });
  };

  return { css: walk(css, baseDir, 0), missed };
}

