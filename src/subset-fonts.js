/**
 * 霞鹜文楷本地化。
 *
 * 上游 webfont 已经按 unicode-range 切成了 ~100 个分片，
 * 所以不需要 fontTools：数出简历实际用到的码位，只挑命中的分片copy 过来，
 * 再写一份只含这些 @font-face 的 CSS。26MB → 通常 300~500KB。
 *
 * 完整包只临时装到 tmp，不进项目依赖。
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, copyFileSync,
  mkdirSync, mkdtempSync, rmSync, statSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG = 'lxgw-wenkai-lite-webfont@1.7.0';
const FAMILY = 'LXGW WenKai Lite';
const WEIGHTS = [
  { css: 'lxgwwenkailite-regular.css', weight: 400 },
  { css: 'lxgwwenkailite-bold.css', weight: 700 },
];

/** U+4e00-9fff, U+3001 → [[0x4e00,0x9fff],[0x3001,0x3001]] */
function parseRanges(spec) {
  return spec.split(',').map((tok) => {
    const s = tok.trim().replace(/^U\+/i, '');
    const [a, b] = s.split('-');
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
}

/** 简历数据 + 模板里出现的所有码位。模板要算进来，"求职岗位""简介" 这些字在数据里没有。 */
function collectCodepoints({ ROOT, dataFile }) {
  const cps = new Set();
  const files = [dataFile];
  const skins = join(ROOT, 'skins');
  if (existsSync(skins)) {
    for (const d of readdirSafe(skins)) {
      const t = join(skins, d, 'template.hbs');
      if (existsSync(t)) files.push(t);
    }
  }
  for (const f of files) {
    for (const ch of readFileSync(f, 'utf8')) cps.add(ch.codePointAt(0));
  }
  // 常用标点和数字兜底，避免以后改文案时又缺片
  for (let c = 0x20; c <= 0x7e; c++) cps.add(c);
  for (const ch of '，。、；：？！“”‘’（）《》〈〉—…·　×÷％℃①②③④⑤') {
    cps.add(ch.codePointAt(0));
  }
  return cps;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 装完整包到临时目录，返回包路径和清理函数 */
function fetchPackage() {
  const dir = mkdtempSync(join(tmpdir(), 'resume-fonts-'));
  console.log(`拉取 ${PKG}（26MB，只用一次，装在 ${dir}）…`);
  execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
  execFileSync('npm', ['i', PKG, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: dir,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
  });
  return {
    pkg: join(dir, 'node_modules', 'lxgw-wenkai-lite-webfont'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export async function subset({ ROOT, dataFile }) {
  const cps = [...collectCodepoints({ ROOT, dataFile })];
  console.log(`简历用到 ${cps.length} 个唯一码位`);

  const { pkg, cleanup } = fetchPackage();
  try {
    if (!existsSync(pkg)) throw new Error('字体包没装上，检查网络');

    const outDir = join(ROOT, 'fonts', 'lxgw');
    mkdirSync(outDir, { recursive: true });

    const rules = [];
    let kept = 0;
    let bytes = 0;

    for (const { css, weight } of WEIGHTS) {
      const text = readFileSync(join(pkg, css), 'utf8');
      for (const block of text.split('@font-face').slice(1)) {
        const file = block.match(/url\('\.\/files\/([^']+)'\)/)?.[1];
        const range = block.match(/unicode-range:\s*([^}\n]+)/)?.[1]?.trim();
        if (!file || !range) continue;

        const ranges = parseRanges(range);
        const hit = cps.some((c) => ranges.some(([a, z]) => c >= a && c <= z));
        if (!hit) continue;

        copyFileSync(join(pkg, 'files', file), join(outDir, file));
        bytes += statSync(join(outDir, file)).size;
        kept++;
        rules.push(
          `@font-face{\n` +
            `  font-family:"${FAMILY}";\n` +
            `  font-style:normal;\n` +
            `  font-weight:${weight};\n` +
            `  font-display:block;\n` +
            `  src:url("./lxgw/${file}") format("woff2");\n` +
            `  unicode-range:${range}\n` +
            `}`,
        );
      }
    }

    if (!kept) throw new Error('一个分片都没命中，字体包结构可能变了');

    writeFileSync(
      join(ROOT, 'fonts', 'lxgw.css'),
      `/* 霞鹜文楷本地子集 —— 由 \`npm run fonts\` 生成，不要手改。\n` +
        ` * 命中 ${kept} 个分片，${(bytes / 1024).toFixed(0)}KB。\n` +
        ` * 简历加了新字（尤其生僻字）之后重跑一次。\n */\n\n` +
        rules.join('\n') +
        '\n',
      'utf8',
    );

    console.log(`✓ fonts/lxgw/ 命中 ${kept} 个分片，${(bytes / 1024).toFixed(0)}KB`);
    console.log(`✓ fonts/lxgw.css 已改为本地引用，现在离线也能导出`);
  } finally {
    cleanup();
  }
}
