#!/usr/bin/env node
/**
 * resume-kit CLI
 *
 *   build   YAML → dist/*.html
 *   pdf     YAML → dist/*.html → dist/*.pdf（带溢出检查）
 *   dev     本地服务 + 文件监听 + 自动刷新
 *   check   只校验数据，不产出文件
 *   fonts   把霞鹜文楷按简历实际用字裁成小分片
 */

import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, lint } from './data.js';
import { render } from './render.js';
import { toPdf, probeFit } from './pdf.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v ?? (argv[i + 1]?.startsWith('--') === false ? argv[++i] : true);
    } else opts._.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0] ?? 'build';
const dataFile = resolve(ROOT, opts.data ?? 'resume.yaml');
const outDir = resolve(ROOT, opts.out ?? 'dist');

/**
 * 字体子集是生成物（不进仓库），缺了不会报错 —— CSS 里的 @import 取不到文件，
 * 中日韩正文静默回落到系统字体，行高全变，量出来的"刚好一页"就是假的。
 * 所以缺了必须吭一声。
 */
function warnMissingFonts() {
  if (existsSync(join(ROOT, 'fonts', 'lxgw.css'))) return;
  console.warn(
    `${C.yellow('warn')} 缺 fonts/lxgw.css，正文会回落到系统字体，排版和这里量出来的尺寸都不准\n` +
      `       跑一次 ${C.bold('npm run fonts')} 生成字体子集`,
  );
}

/** 载入 + 校验，有 error 直接退出 */
function loadChecked() {
  const data = load(dataFile);
  if (opts.skin) data.meta.skin = opts.skin;
  const { errors, warnings } = lint(data);
  for (const w of warnings) console.warn(`${C.yellow('warn')} ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`${C.red('error')} ${e}`);
    process.exit(1);
  }
  return data;
}

function buildHtml(data, { fit = true, reload = 0 } = {}) {
  const html = render(data, ROOT, { fit, reload });
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, `${data.meta.output}.html`);
  writeFileSync(htmlPath, html, 'utf8');
  cpSync(join(ROOT, 'fonts'), join(outDir, 'fonts'), { recursive: true });
  return htmlPath;
}

/** 把探针结论说人话。返回 true 表示有内容被裁。 */
function reportFit(fit, pages, want) {
  if (!fit) {
    console.warn(`${C.yellow('warn')} 没取到尺寸数据，跳过排版检查`);
  } else if (fit.multipage) {
    console.log(`${C.dim(`分页  约 ${fit.pages} 页，末页还剩 ${fit.freeMm}mm`)}`);
  } else if (fit.clipped) {
    console.error(
      `${C.red('内容被裁')} 超出纸面 ${fit.clipMm}mm，末尾内容不会出现在 PDF 里。\n` +
        `          最靠底的元素：${fit.last}\n` +
        `          删点内容，或把 skins/*/style.css 里的 --fs / --lh 调小，\n` +
        `          也可以在 meta.pages 写 auto 放开一页的限制。`,
    );
  } else if (fit.tight) {
    console.warn(
      `${C.yellow('偏紧')} 内容压进底部留白 ${fit.intoPadMm}mm —— 没丢内容，但页脚很挤`,
    );
  } else {
    console.log(`${C.dim(`留白  还剩 ${fit.freeMm}mm 可用`)}`);
  }
  // want 是 auto 时页数本来就不固定，没有"对不上"这回事
  if (pages != null && want !== 'auto' && pages !== want) {
    console.warn(`${C.yellow('warn')} 导出 ${pages} 页，meta.pages 写的是 ${want}`);
  }
  return !!fit?.clipped;
}

async function main() {
  switch (cmd) {
    case 'check': {
      const data = loadChecked();
      const n = data.sections.length;
      console.log(`${C.green('✓')} ${dataFile} 数据没问题（${n} 个章节）`);
      break;
    }

    case 'build': {
      const data = loadChecked();
      warnMissingFonts();
      const p = buildHtml(data);
      console.log(`${C.green('✓')} ${p}`);
      if (!opts['no-check']) {
        reportFit(await probeFit(p, { paper: data.meta.paper }), null, data.meta.pages);
      }
      break;
    }

    case 'pdf': {
      const data = loadChecked();
      warnMissingFonts();
      const htmlPath = buildHtml(data);
      const pdfPath = join(outDir, `${data.meta.output}.pdf`);
      const pages = await toPdf(htmlPath, pdfPath);
      console.log(`${C.green('✓')} ${pdfPath}${pages ? C.dim(`  (${pages} 页)`) : ''}`);
      const clipped = reportFit(
        await probeFit(htmlPath, { paper: data.meta.paper }),
        pages,
        data.meta.pages,
      );
      // 内容被裁是硬错误：PDF 生成了但内容不完整，退出码要能被 CI / 脚本感知
      if (clipped && !opts['allow-clip']) process.exit(2);
      break;
    }

    case 'dev':
      await import('./dev.js').then((m) =>
        m.serve({ ROOT, dataFile, outDir, port: Number(opts.port ?? 4321), opts }),
      );
      break;

    case 'fonts':
      await import('./subset-fonts.js').then((m) => m.subset({ ROOT, dataFile }));
      break;

    case 'studio':
      await import('./studio.js').then((m) =>
        m.serve({ ROOT, dataFile, outDir, port: Number(opts.port ?? 5173), open: !opts['no-open'] }),
      );
      break;

    case 'test': {
      const good = await import('./roundtrip.test.js').then((m) => m.runTests(dataFile));
      if (!good) process.exit(1);
      break;
    }

    default:
      console.error(
        `不认识的命令 "${cmd}"。可用：studio / build / pdf / dev / check / fonts / test`,
      );
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${C.red('error')} ${e.message}`);
  if (opts.debug) console.error(e.stack);
  process.exit(1);
});
