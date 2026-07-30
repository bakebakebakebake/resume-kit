/**
 * 简历工作台服务。
 *
 * 分工：浏览器负责编辑（在真实排版上直接改字），Node 负责渲染和导出。
 * 数据始终以 resume.yaml 为准 —— 工作台只是它的一个编辑器，
 * 关掉浏览器不丢东西，也能照常用 git 看改了什么。
 *
 * 路由：
 *   GET  /                 工作台外壳
 *   GET  /studio/*         外壳的静态资源
 *   GET  /fonts/*          字体（iframe 里的 CSS 按相对路径要它们）
 *   GET  /api/boot         初始数据 + 皮肤列表 + 旋钮默认值
 *   POST /api/render       数据 → 简历 HTML（结构变动后重渲染）
 *   POST /api/save         数据 → resume.yaml（带备份）
 *   POST /api/export       数据 → pdf / png / docx / html，返回下载地址
 *   GET  /out/*            导出产物下载
 */

import { createServer } from 'node:http';
import {
  createReadStream,
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join, extname, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { load, lint, reindex } from './data.js';
import { render } from './render.js';
import { emitYaml } from './emit-yaml.js';
import { exportAll } from './export.js';
import { rootVars } from './skin-vars.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

export async function serve({ ROOT, dataFile, outDir, port, open = true }) {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { ROOT, dataFile, outDir, port });
    } catch (e) {
      console.error(`${C.red('error')} ${req.method} ${req.url}  ${e.message}`);
      json(res, 500, { error: e.message });
    }
  });

  await new Promise((ok, bad) => {
    server.on('error', (e) =>
      bad(
        e.code === 'EADDRINUSE'
          ? new Error(`端口 ${port} 被占用了。换一个：npm run studio -- --port=5174`)
          : e,
      ),
    );
    server.listen(port, ok);
  });

  if (!existsSync(join(ROOT, 'fonts', 'lxgw.css'))) {
    console.warn(
      `\n  ${C.yellow('注意')} 缺 fonts/lxgw.css，正文会回落到系统字体，` +
        `页面上量出来的尺寸不准。先跑一次 npm run fonts`,
    );
  }

  const url = `http://localhost:${port}`;
  console.log(`\n  ${C.green('简历工作台')}  ${url}\n`);
  console.log(`  ${C.dim('点简历上任何文字直接改，右侧调版式，改完点保存写回 resume.yaml')}`);
  console.log(`  ${C.dim(`数据文件  ${dataFile}`)}\n`);
  if (open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function route(req, res, ctx) {
  const { ROOT, dataFile, outDir, port } = ctx;
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ── 页面与静态资源 ──
  if (p === '/') return sendFile(res, join(ROOT, 'src', 'studio', 'index.html'));
  if (p.startsWith('/studio/')) return sendUnder(res, join(ROOT, 'src', 'studio'), p.slice(8));
  // markup.js 前端也要用（把 DOM 改回标记、把标记渲染成 HTML），
  // 直接把源文件送过去，语法只有一份定义。
  if (p === '/src/markup.js') return sendFile(res, join(ROOT, 'src', 'markup.js'));
  if (p.startsWith('/fonts/')) return sendUnder(res, join(ROOT, 'fonts'), p.slice(7));
  if (p.startsWith('/out/')) return sendUnder(res, outDir, p.slice(5));

  // ── API ──
  if (p === '/api/boot') {
    const data = load(dataFile);
    return json(res, 200, {
      data,
      skins: listSkins(ROOT),
      // 旋钮默认值从皮肤 CSS 的 :root 里现读，面板显示的就是这套皮肤的真实默认
      defaults: rootVars(ROOT, data.meta.skin),
      lint: lint(data),
      dataFile,
    });
  }

  if (p === '/api/render' && req.method === 'POST') {
    const data = reindex(await body(req));
    const html = render(data, ROOT, { fit: true, baseHref: `http://localhost:${port}/` });
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (p === '/api/save' && req.method === 'POST') {
    const data = reindex(await body(req));
    const yaml = emitYaml(data);

    // 存盘前先把旧的挪一份走。这个文件是用户简历的唯一副本，
    // 序列化再怎么测过，也不能让"保存"变成不可逆操作。
    const backup = backupOnce(dataFile, ROOT);
    writeFileSync(dataFile, yaml, 'utf8');

    const check = lint(load(dataFile));
    console.log(`${C.green('✓')} 已保存 ${C.dim(new Date().toLocaleTimeString())}`);
    return json(res, 200, { ok: true, backup, lint: check, bytes: Buffer.byteLength(yaml) });
  }

  if (p === '/api/export' && req.method === 'POST') {
    const { data: raw, formats } = await body(req);
    const data = reindex(raw);
    const files = await exportAll({ ROOT, outDir, data, formats });
    return json(res, 200, { files: files.map((f) => ({ ...f, url: `/out/${f.name}` })) });
  }

  json(res, 404, { error: `没有这个路由：${p}` });
}

// ── 工具 ──

function listSkins(ROOT) {
  const dir = join(ROOT, 'skins');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'template.hbs')))
    .map((d) => d.name);
}

/**
 * 每次保存都留一份历史，文件名带时间戳。
 * 只保留最近 20 份，不然攒几百个文件也没人看。
 */
function backupOnce(dataFile, ROOT) {
  if (!existsSync(dataFile)) return null;
  const dir = join(ROOT, '.studio-backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `resume-${stamp}.yaml`;
  copyFileSync(dataFile, join(dir, name));

  const old = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .slice(0, -20);
  for (const f of old) {
    try {
      unlinkSync(join(dir, f));
    } catch {}
  }
  return name;
}

function body(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 8e6) bad(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(s));
      } catch (e) {
        bad(new Error(`请求体不是合法 JSON：${e.message}`));
      }
    });
    req.on('error', bad);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`404 ${file}`);
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

/** 限定在某个目录下取文件，挡目录穿越 */
function sendUnder(res, base, rel) {
  const file = resolve(base, normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(resolve(base))) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }
  sendFile(res, file);
}
