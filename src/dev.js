/**
 * dev 服务：静态托管 dist/ + 监听重建 + 浏览器自动刷新。
 *
 * 刷新用的是最土的办法：页面轮询 /__version，构建计数变了就 reload。
 * 不需要 websocket，也不需要额外依赖。
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { load, lint } from './data.js';
import { render } from './render.js';
import { writeFileSync, mkdirSync, cpSync } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

export async function serve({ ROOT, dataFile, outDir, port }) {
  let version = 0;
  let entry = 'index.html';

  const rebuild = () => {
    try {
      const data = load(dataFile);
      const { errors, warnings } = lint(data);
      for (const w of warnings) console.warn(`\x1b[33mwarn\x1b[0m ${w}`);
      for (const e of errors) console.error(`\x1b[31merror\x1b[0m ${e}`);

      const html = render(data, ROOT, { fit: true, reload: 700 });
      mkdirSync(outDir, { recursive: true });
      entry = `${data.meta.output}.html`;
      writeFileSync(join(outDir, entry), html, 'utf8');
      cpSync(join(ROOT, 'fonts'), join(outDir, 'fonts'), { recursive: true });
      version++;
      console.log(`\x1b[32m✓\x1b[0m 重建 #${version}  ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      // 构建挂了不退出：改错一行 YAML 不该把服务打死，
      // 浏览器继续显示上一次成功的版本。
      console.error(`\x1b[31m构建失败\x1b[0m ${e.message}`);
    }
  };

  rebuild();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/__version') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(String(version));
      return;
    }

    const rel = url.pathname === '/' ? entry : decodeURIComponent(url.pathname).slice(1);
    // 防目录穿越
    const file = join(outDir, normalize(rel).replace(/^(\.\.[/\\])+/, ''));

    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });

  // 编辑器保存一次常常连发好几个事件，攒一下再重建
  let timer = null;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 120);
  };
  watch(dataFile, bump);
  watch(join(ROOT, 'skins'), { recursive: true }, bump);
  watch(join(ROOT, 'src'), { recursive: true }, bump);

  server.listen(port, () => {
    console.log(`\n  http://localhost:${port}\n`);
    console.log(`  改 resume.yaml 或 skins/ 会自动重建刷新`);
    console.log(`  导出 PDF：另开一个终端跑 npm run pdf\n`);
  });
}
