/**
 * HTML → PDF，用系统已装的 headless Chrome，不额外拉 Chromium。
 *
 * 这里有个坑值得写下来：本机 Chrome 150 在 --print-to-pdf 和 --dump-dom 下
 * 都会把活干完然后挂着不退出（试过 vtb / 文件访问 / 合成器几种组合，
 * 只有 --dump-dom + 合成器那一种能自己退，但那种拿不到字体加载后的尺寸）。
 *
 * 所以不赌 Chrome 会退出：起进程 → 等产物齐活 → 主动杀。
 * 产物"齐活"的判据是可验证的，不是等固定秒数：
 *   PDF  → 文件大小连续两次不变，且尾部有 %%EOF
 *   探针 → stdout 里出现 data-fit="
 */

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, statSync, unlinkSync,
  mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const BASE_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  // 字体是相对路径的 file:// 资源，不开这个会被同源策略拦掉
  '--allow-file-access-from-files',
  // 等 web font 真正加载完再画，否则量到的是 fallback 字体的行高
  '--run-all-compositor-stages-before-draw',
  '--virtual-time-budget=8000',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME) {
    if (!existsSync(process.env.CHROME)) {
      throw new Error(`CHROME 指向的路径不存在：${process.env.CHROME}`);
    }
    return process.env.CHROME;
  }
  const hit = CANDIDATES.find(existsSync);
  if (!hit) {
    throw new Error(
      '找不到 Chrome。装一个 Chrome / Chromium / Edge，或用 CHROME=/path/to/chrome 指定。',
    );
  }
  return hit;
}

/** 起 Chrome，返回 { child, stdout(), kill() } */
function launch(args, htmlPath) {
  const profile = mkdtempSync(join(tmpdir(), 'resume-kit-'));
  const child = spawn(
    findChrome(),
    [...BASE_FLAGS, ...args, `--user-data-dir=${profile}`, pathToFileURL(htmlPath).href],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  child.on('error', (e) => (err += e.message));

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {}
      // Chrome 还没放开句柄就删会 ENOTEMPTY，延后且失败不管
      setTimeout(() => {
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {}
      }, 1500).unref?.();
    },
  };
}

/** PDF 写完没：大小稳定 + 尾部 %%EOF */
function pdfSettled(path, lastSize) {
  if (!existsSync(path)) return { done: false, size: -1 };
  const size = statSync(path).size;
  if (size === 0 || size !== lastSize) return { done: false, size };
  const tail = readFileSync(path).subarray(-64).toString('latin1');
  return { done: tail.includes('%%EOF'), size };
}

/**
 * 导出 PDF。
 * @returns {number|null} 页数，数不出来时 null
 */
export async function toPdf(htmlPath, pdfPath, { timeout = 60000 } = {}) {
  if (existsSync(pdfPath)) unlinkSync(pdfPath);

  const proc = launch(['--print-to-pdf-no-header', `--print-to-pdf=${pdfPath}`], htmlPath);
  const t0 = Date.now();
  let lastSize = -1;
  let ok = false;

  try {
    while (Date.now() - t0 < timeout) {
      await sleep(300);
      const s = pdfSettled(pdfPath, lastSize);
      lastSize = s.size;
      if (s.done) {
        ok = true;
        break;
      }
      if (proc.child.exitCode !== null) {
        ok = pdfSettled(pdfPath, s.size).done;
        break;
      }
    }
  } finally {
    proc.kill();
  }

  if (!ok) {
    const hint = proc.stderr().trim().split('\n').slice(-3).join('\n');
    throw new Error(
      `Chrome 没能产出完整 PDF（等了 ${((Date.now() - t0) / 1000).toFixed(0)}s）` +
        (hint ? `\n${hint}` : ''),
    );
  }
  return pageCount(pdfPath);
}

/** PNG 写完没：大小稳定 + 尾部 IEND 块 */
function pngSettled(path, lastSize) {
  if (!existsSync(path)) return { done: false, size: -1 };
  const size = statSync(path).size;
  if (size === 0 || size !== lastSize) return { done: false, size };
  const tail = readFileSync(path).subarray(-8).toString('latin1');
  return { done: tail.includes('IEND'), size };
}

/**
 * 整页截图。
 *
 * 清晰度靠 --force-device-scale-factor 放大，不靠开大窗口 ——
 * 窗口变大会让 CSS 里的 mm 算出不同布局，等于换了张纸。
 *
 * 已知缺陷：窗口宽度正好等于纸宽，会命中皮肤的窄屏断点，
 * 于是截出来的是手机版式（页边距、字号、行高、页头布局全不一样），
 * 跟同一份数据导出的 PDF 不是一个东西。PDF 不受影响是因为
 * @media print 会覆盖回来，PNG 走 @media screen，覆盖不到。
 *
 * 光把窗口放宽治不好：桌面规则下 body 有左右内边距，纸会偏在中间，
 * 两侧带进舞台底色，得把纸那一块裁出来 —— 纯 Node 裁 PNG 要重新编解码。
 * 迁到 Electron 后 capturePage({rect}) 一行就能裁，连同这个缺陷一起修。
 *
 * @param {object} [opts]
 * @param {{w:number,h:number}} [opts.paper] 纸张毫米尺寸，默认 A4
 * @returns {{w: number, h: number}|null} 实际像素尺寸
 */
export async function toPng(htmlPath, pngPath, { scale = 3, timeout = 60000, paper } = {}) {
  if (existsSync(pngPath)) unlinkSync(pngPath);
  const sheet = paper ?? { w: 210, h: 297 };
  const PX = 96 / 25.4;
  const W = Math.round(sheet.w * PX);
  const H = Math.round(sheet.h * PX);

  const proc = launch(
    [
      `--window-size=${W},${H}`,
      `--force-device-scale-factor=${scale}`,
      '--hide-scrollbars',
      `--screenshot=${pngPath}`,
    ],
    htmlPath,
  );

  const t0 = Date.now();
  let lastSize = -1;
  let ok = false;
  try {
    while (Date.now() - t0 < timeout) {
      await sleep(300);
      const s = pngSettled(pngPath, lastSize);
      lastSize = s.size;
      if (s.done) {
        ok = true;
        break;
      }
      if (proc.child.exitCode !== null) {
        await sleep(400);
        ok = pngSettled(pngPath, statSync(pngPath).size).done;
        break;
      }
    }
  } finally {
    proc.kill();
  }

  if (!ok) {
    const hint = proc.stderr().trim().split('\n').slice(-3).join('\n');
    throw new Error(`Chrome 没能产出完整 PNG${hint ? `\n${hint}` : ''}`);
  }
  return pngSize(pngPath);
}

/** PNG 头里第 16 字节起是宽高，各 4 字节大端 */
function pngSize(path) {
  try {
    const b = readFileSync(path);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * 量一次排版尺寸。
 *
 * 必须给 --window-size，而且要比纸宽：视口落在皮肤的窄屏断点以内时
 * .sheet 是 height:auto，永远量不出溢出。Chrome 默认视口 800px
 * 在 A4 下就已经踩中，换更大的纸差得更多。
 *
 * @param {object} [opts]
 * @param {{w:number,h:number}} [opts.paper] 纸张毫米尺寸，默认 A4
 * @returns {object|null} fit-probe.js 的测量结果
 */
export async function probeFit(htmlPath, { timeout = 30000, paper } = {}) {
  const sheet = paper ?? { w: 210, h: 297 };
  const PX = 96 / 25.4;
  // 断点是纸宽 + 26，留足余量走桌面规则；高度给两页，够探针量流式内容
  const winW = Math.round(sheet.w * PX) + 406;
  const winH = Math.round(sheet.h * PX) * 2;
  const proc = launch([`--window-size=${winW},${winH}`, '--dump-dom'], htmlPath);
  const t0 = Date.now();
  const NEEDLE = 'data-fit="';

  try {
    while (Date.now() - t0 < timeout) {
      await sleep(250);
      if (proc.stdout().includes(NEEDLE)) break;
      if (proc.child.exitCode !== null) {
        // Chrome 可能在探针 publish 之前就退了（--dump-dom 打完 DOM 就走）。
        // stdout 是流，退出后还可能有残留没读完，再宽限一下别把数据丢掉。
        await sleep(500);
        break;
      }
    }
  } finally {
    proc.kill();
  }

  const m = proc.stdout().match(/data-fit="([^"]*)"/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
}

/** 数 /Type /Page。页树节点一般不压缩，够用；数不出来返回 null 让上层降级 */
function pageCount(pdfPath) {
  try {
    const buf = readFileSync(pdfPath).toString('latin1');
    const n = (buf.match(/\/Type\s*\/Page[^s]/g) || []).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
