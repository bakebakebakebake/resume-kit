/**
 * 读皮肤 :root 里的自定义属性默认值。
 *
 * 工作台的旋钮面板和 DOCX 配色都要用它，所以只留这一份实现 ——
 * 之前两边各抄了一遍，而且抄的是同一个错版本。
 *
 * 坑：注释必须先去掉再按分号切。
 * 皮肤里有不少「属性 分号 行尾注释」的写法，按分号切完，
 * 下一条属性所在的片段就是以注释开头的，`^--` 匹配不上，那条属性被静默丢掉。
 * 表现是面板显示成 #000000、滑块跳到最小值，且完全看不出是哪一步错了。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} ROOT 项目根
 * @param {string} skin 皮肤目录名
 * @returns {Record<string,string>} 例如 { fs: '8.95pt', paper: '#F7F6F3' }
 */
export function rootVars(ROOT, skin) {
  const file = join(ROOT, 'skins', skin, 'style.css');
  if (!existsSync(file)) return {};
  return parseRootVars(readFileSync(file, 'utf8'));
}

/** @param {string} css */
export function parseRootVars(css) {
  // 先去注释，再找 :root。顺序反了就会踩上面那个坑。
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 只认第一段 :root：后面那段是 @media 窄屏的覆盖，给手机看的，
  // 工作台里的纸永远是 A4 宽，不会命中。
  const m = clean.match(/:root\s*\{([^}]*)\}/);
  if (!m) return {};

  const out = {};
  for (const decl of m[1].split(';')) {
    const kv = decl.match(/^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}
