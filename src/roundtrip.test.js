/**
 * 往返测试：YAML → 数据 → YAML → 数据，两次的数据必须一模一样。
 *
 * 工作台存盘会整文件重写 resume.yaml。如果序列化漏了字段或者引号
 * 加错了，用户的内容就静默变形了 —— 这是整个工作台最危险的一步，
 * 所以拿真实数据卡住它。
 *
 *   node src/cli.js test
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { load, lint, reindex } from './data.js';
import { emitYaml } from './emit-yaml.js';
import { render } from './render.js';
import { inline, tokens, fromTokens, lintInline } from './markup.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 比较时忽略路径标记：索引重排是预期行为，不是内容变化 */
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k === '_p') continue;
      out[k] = strip(v[k]);
    }
    return out;
  }
  return v;
}

export function runTests(dataFile) {
  const tmp = mkdtempSync(join(tmpdir(), 'resume-kit-test-'));

  console.log('\n行内标记');
  ok('粗体', inline('a **b** c') === 'a <span class="lead">b</span> c');
  ok('代码', inline('用 `Redis` 缓存') === '用 <span class="t">Redis</span> 缓存');
  ok(
    '粗体套代码',
    inline('**基于 `pi-agent-core` 实现**') ===
      '<span class="lead">基于 <span class="t">pi-agent-core</span> 实现</span>',
  );
  ok('转义星号', inline('a \\* b') === 'a * b', inline('a \\* b'));
  ok('HTML 转义', inline('a < b & c') === 'a &lt; b &amp; c', inline('a < b & c'));
  ok('空值', inline(null) === '' && inline(undefined) === '');

  console.log('\n标记 → 片段（DOCX 用）');
  const t1 = tokens('普通 **粗** 再 `码` 尾');
  ok(
    '三段拆开',
    JSON.stringify(t1) ===
      JSON.stringify([
        { text: '普通 ', bold: false, code: false, href: null },
        { text: '粗', bold: true, code: false, href: null },
        { text: ' 再 ', bold: false, code: false, href: null },
        { text: '码', bold: false, code: true, href: null },
        { text: ' 尾', bold: false, code: false, href: null },
      ]),
    JSON.stringify(t1),
  );
  const t2 = tokens('**外 `内` 外**');
  ok(
    '粗体里的代码同时带两个标记',
    t2.some((x) => x.bold && x.code && x.text === '内'),
    JSON.stringify(t2),
  );
  ok(
    '片段拼回原文（去掉标记）',
    tokens('a **b** `c` d')
      .map((x) => x.text)
      .join('') === 'a b c d',
  );

  console.log('\n链接');
  ok(
    '基本链接',
    inline('见 [主页](https://a.com)') === '见 <a class="lk" href="https://a.com">主页</a>',
    inline('见 [主页](https://a.com)'),
  );
  ok(
    '链接地址里的 & 被转义',
    inline('[x](https://a.com/?a=1&b=2)').includes('a=1&amp;b=2'),
    inline('[x](https://a.com/?a=1&b=2)'),
  );
  ok(
    'javascript: 不产出链接',
    !inline('[x](javascript:alert(1))').includes('<a'),
    inline('[x](javascript:alert(1))'),
  );
  ok('转义方括号', inline('\\[不是链接\\](x)') === '[不是链接](x)', inline('\\[不是链接\\](x)'));
  ok('mailto 放行', inline('[信](mailto:a@b.com)').includes('href="mailto:a@b.com"'));

  // 曾经的 bug：tokens() 顺次切分时先切粗体，会把链接的方括号和圆括号
  // 劈到两个片段里，Word 里这个链接就整个丢了。
  const t3 = tokens('[**粗** 尾](https://a.com)');
  ok(
    '链接里的粗体不会把链接切断',
    t3.length === 2 && t3.every((x) => x.href === 'https://a.com') && t3[0].bold && !t3[1].bold,
    JSON.stringify(t3),
  );
  ok(
    '两种写法的嵌套都认',
    tokens('**[x](https://a.com)**')[0]?.href === 'https://a.com' &&
      tokens('[`x`](https://a.com)')[0]?.code === true,
  );
  ok(
    '不安全地址在片段里也退回文字',
    tokens('[x](javascript:1)').every((x) => x.href === null),
    JSON.stringify(tokens('[x](javascript:1)')),
  );
  ok(
    'lint 抓出没配成链接的方括号',
    lintInline('见 [主页(https://a.com)').length === 1,
    JSON.stringify(lintInline('见 [主页(https://a.com)')),
  );
  ok('lint 不误报正常链接', lintInline('见 [主页](https://a.com) 和 **粗**').length === 0);

  // 工作台所见即所得：DOM 读成片段，再写回标记。写回去的东西
  // 再解析一遍必须得到同样的文字和格式，否则改一个字会把别处的格式弄丢。
  console.log('\n片段 → 标记（所见即所得写回）');
  const same = (s) => JSON.stringify(tokens(fromTokens(tokens(s)))) === JSON.stringify(tokens(s));
  for (const s of [
    '普通 **粗 `码`** 尾',
    '[**粗** 尾](https://a.com)',
    'x **[l](mailto:a@b.com)** y',
    'a \\* b \\` c \\[d\\]',
    '`a\\`b`',
  ]) {
    ok(`往返不变：${s}`, same(s), fromTokens(tokens(s)));
  }
  const lit = [{ text: '2*3 = `6` [注] **x**', bold: false, code: false, href: null }];
  ok('用户敲的标记字符按字面量写回', same(fromTokens(lit)) && tokens(fromTokens(lit))[0].text === lit[0].text, fromTokens(lit));
  ok('路径里的反斜杠不被改写', fromTokens([{ text: 'C:\\Users\\me' }]) === 'C:\\Users\\me');
  ok(
    '末尾反斜杠挨着粗体不会吞掉标记',
    JSON.stringify(tokens(fromTokens([{ text: 'a\\' }, { text: 'b', bold: true }])).map((x) => [x.text, x.bold])) ===
      '[["a\\\\",false],["b",true]]',
    fromTokens([{ text: 'a\\' }, { text: 'b', bold: true }]),
  );
  ok(
    '链接地址里的空格和括号被编码',
    tokens(fromTokens([{ text: 'x', href: 'https://a.com/a b(c)' }]))[0].href === 'https://a.com/a%20b%28c%29',
    fromTokens([{ text: 'x', href: 'https://a.com/a b(c)' }]),
  );
  ok('不安全的地址写回时丢掉', fromTokens([{ text: 'x', href: 'javascript:1' }]) === 'x');

  console.log('\n页数模式');
  {
    // 曾经的 bug：工作台把开关写在 meta.pageLimit 上，而 normalize / emitYaml
    // 都不认识这个键 —— 存盘即丢失，也从来没传到导出那一侧。
    const f = join(tmp, 'pages.yaml');
    const src = 'meta:\n  skin: datasheet\n  output: x\n  pages: auto\nprofile:\n  name: 张三\nsections:\n  - title: A\n    entries:\n      - org: O\n';
    writeFileSync(f, src, 'utf8');

    const d = load(f);
    ok('auto 解析成 auto', d.meta.pages === 'auto', JSON.stringify(d.meta.pages));
    ok('auto 推出 multipage', d.meta.multipage === true);
    ok('auto 不算错误', lint(d).errors.length === 0, JSON.stringify(lint(d).errors));

    const f2 = join(tmp, 'pages2.yaml');
    writeFileSync(f2, emitYaml(d), 'utf8');
    const d2 = load(f2);
    ok('auto 存盘后还在', d2.meta.pages === 'auto', JSON.stringify(d2.meta.pages));
    ok('auto 二次序列化稳定', emitYaml(d2) === emitYaml(d));

    const f3 = join(tmp, 'pages3.yaml');
    writeFileSync(f3, src.replace('pages: auto', 'pages: 1'), 'utf8');
    const d3 = load(f3);
    ok('默认单页不进多页模式', d3.meta.pages === 1 && d3.meta.multipage === false);

    // 工作台切换走的是这条路：只改 meta.pages，派生位靠 reindex 重算
    d3.meta.pages = 'auto';
    reindex(d3);
    ok('reindex 重算派生位', d3.meta.multipage === true);
    d3.meta.pages = 1;
    reindex(d3);
    ok('切回单页也重算', d3.meta.multipage === false);

    const f4 = join(tmp, 'pages4.yaml');
    writeFileSync(f4, src.replace('pages: auto', 'pages: 呵呵'), 'utf8');
    ok('非法页数报错', lint(load(f4)).errors.some((e) => e.includes('meta.pages')));

    // multipage 必须真的传到模板，否则 CSS 里那套 data-pages 规则永远不生效。
    // 只看 <html> 开标签：皮肤 CSS 里也有 data-pages 选择器，
    // 直接在整份 HTML 里搜字符串会永远命中。
    const htmlTag = (d) => render(d, ROOT, {}).match(/<html[^>]*>/)[0];
    ok(
      'multipage 落到 <html>',
      htmlTag(load(f)).includes('data-pages="auto"') && !htmlTag(d3).includes('data-pages'),
      `${htmlTag(load(f))} / ${htmlTag(d3)}`,
    );
  }

  console.log('\n语言');
  {
    // 曾经的 bug：英文简历的页头前缀、默认简介标签、DOCX 标题都写死成中文
    const f = join(tmp, 'lang.yaml');
    const src = 'meta:\n  skin: datasheet\n  output: x\n  lang: en\nprofile:\n  name: Alex\n  seeking: Backend\nsections:\n  - title: A\n    entries:\n      - org: O\n        brief: hi\n';
    writeFileSync(f, src, 'utf8');
    const d = load(f);
    const html = render(d, ROOT, {});
    ok('英文页头前缀', html.includes('Seeking · <b') && !html.includes('求职岗位'));
    ok('英文默认简介标签', d.sections[0].entries[0].briefLabel === 'Summary');
    ok('lang 落到 <html>', /<html lang="en"/.test(html));
    ok('默认标签不写回 YAML', !emitYaml(d).includes('briefLabel'));

    const f2 = join(tmp, 'lang2.yaml');
    writeFileSync(f2, src.replace('  lang: en\n', ''), 'utf8');
    const z = load(f2);
    ok('不写 lang 仍是中文', render(z, ROOT, {}).includes('求职岗位 · <b') && z.sections[0].entries[0].briefLabel === '简介');

    // 工作台新建的条目 briefLabel 是 null，reindex 按语言补
    d.sections[0].entries.push({ org: 'N', briefLabel: null, facts: [], awards: [], points: [] });
    reindex(d);
    ok('reindex 按语言补标签', d.sections[0].entries[1].briefLabel === 'Summary');
  }

  console.log('\n纸张');
  {
    const head = 'meta:\n  skin: datasheet\n  output: x\n';
    const tail = 'profile:\n  name: 张三\nsections:\n  - title: A\n    entries:\n      - org: O\n';
    const write = (name, metaExtra) => {
      const f = join(tmp, name);
      writeFileSync(f, `${head}${metaExtra}${tail}`, 'utf8');
      return load(f);
    };

    ok('不写就是 A4', write('p-def.yaml', '').meta.paper.w === 210);

    const lt = write('p-letter.yaml', '  paper: Letter\n');
    ok('Letter 解析成 215.9×279.4', lt.meta.paper.w === 215.9 && lt.meta.paper.h === 279.4);
    ok('关键字纸张用 CSS 关键字', lt.meta.paper.cssSize === 'letter', lt.meta.paper.cssSize);

    const cus = write('p-custom.yaml', '  paper: 120x200\n');
    ok('自定义尺寸认得', cus.meta.paper.w === 120 && cus.meta.paper.h === 200);
    ok('自定义尺寸落到 mm', cus.meta.paper.cssSize === '120mm 200mm', cus.meta.paper.cssSize);

    const ls = write('p-ls.yaml', '  paper: A4\n  orientation: landscape\n');
    ok('横向把宽高换过来', ls.meta.paper.w === 297 && ls.meta.paper.h === 210);

    const bad = write('p-bad.yaml', '  paper: 手帕\n');
    ok('认不出的纸报错', lint(bad).errors.some((e) => e.includes('meta.paper')));
    ok('认不出也兜回 A4 能出图', bad.meta.paper.w === 210);

    // 曾经的 bug：emitYaml 不写 meta.paper，工作台存一次盘
    // 用户选的纸就被静默换回 A4。
    for (const [name, extra, check] of [
      ['letter', '  paper: Letter\n', (d) => d.meta.paper.name === 'Letter'],
      ['custom', '  paper: 120x200\n', (d) => d.meta.paper.w === 120 && d.meta.paper.h === 200],
      ['landscape', '  paper: A4\n  orientation: landscape\n', (d) => d.meta.paper.w === 297],
    ]) {
      const d = write(`p-rt-${name}.yaml`, extra);
      const f = join(tmp, `p-rt-${name}-2.yaml`);
      writeFileSync(f, emitYaml(d), 'utf8');
      const d2 = load(f);
      ok(`${name} 存盘后还在`, check(d2), emitYaml(d).split('\n').slice(-99).join('\n').match(/^ {2}(paper|orientation):.*$/m)?.[0] ?? '没写出来');
      ok(`${name} 二次序列化稳定`, emitYaml(d2) === emitYaml(d));
    }

    // 纸张必须真的传到 CSS 和探针，否则换纸只是改了个数字
    const css = (d) => render(d, ROOT, {});
    ok('纸张尺寸落到 @page', css(lt).includes('@page{size:letter;margin:0}'));
    ok('纸高落到 data-page-mm', css(lt).match(/<html[^>]*>/)[0].includes('data-page-mm="279.4"'));
    ok(
      '窄屏断点跟着纸走',
      css(lt).includes('max-width:842px') && css(write('p-a4.yaml', '')).includes('max-width:820px'),
    );
    // @import 被基础层挤到后面就整条失效，中日韩字体静默回落到系统字体
    ok('@import 仍在样式表最前', /<style>\s*@import/.test(css(lt)));
  }

  console.log('\n文字章节');
  {
    const f = join(tmp, 'text.yaml');
    const body = '热爱后端，熟悉 **高并发** 场景，常用 `Go` / `Java`，见 [主页](https://a.com)。';
    const src = `meta:\n  skin: datasheet\n  output: x\nprofile:\n  name: 张三\nsections:\n  - title: A\n    entries:\n      - org: O\n  - title: 自我评价\n    variant: text\n    body: ${JSON.stringify(body)}\n`;
    writeFileSync(f, src, 'utf8');
    const d = load(f);
    const s = d.sections[1];
    ok('text 解析成 isText', s.isText === true && !s.isList && !s.isProject);
    ok('body 原样读进来', s.body === body, JSON.stringify(s.body));
    ok('text 不算错误也不报警', lint(d).errors.length === 0 && lint(d).warnings.length === 0, JSON.stringify(lint(d)));

    const y = emitYaml(d);
    ok('写出 variant: text', y.includes('    variant: text\n'));
    const block = y.slice(y.indexOf('- title: 自我评价'));
    ok('text 章节不写 entries / items', !/entries:|items:/.test(block), block);

    const f2 = join(tmp, 'text2.yaml');
    writeFileSync(f2, y, 'utf8');
    const d2 = load(f2);
    ok('text 存盘后数据不变', JSON.stringify(strip(d)) === JSON.stringify(strip(d2)), firstDiff(strip(d), strip(d2)));
    ok('text 二次序列化稳定', emitYaml(d2) === y);

    // 以 ** 开头的 body 必须加引号，不然 YAML 当成别名直接报错
    d2.sections[1].body = '**开头加粗** 收尾';
    const f3 = join(tmp, 'text3.yaml');
    writeFileSync(f3, emitYaml(d2), 'utf8');
    ok('星号开头的 body 保住了', load(f3).sections[1].body === '**开头加粗** 收尾');

    const html = render(d, ROOT, {});
    const p = html.match(/<p class="sec-text"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';
    ok('HTML 带 data-bind', p.includes('data-bind="sections.1.body"'), p);
    ok(
      'HTML 里标记落成格式',
      p.includes('<span class="lead">高并发</span>') &&
        p.includes('<span class="t">Go</span>') &&
        p.includes('<a class="lk" href="https://a.com">主页</a>'),
      p,
    );
    ok('text 章节不渲染条目容器', !/data-list="sections\.1\./.test(html));

    const e = join(tmp, 'text-empty.yaml');
    writeFileSync(e, src.replace(/ {4}body: .*\n/, ''), 'utf8');
    const de = load(e);
    ok('没写 body 是空串', de.sections[1].body === '');
    ok('空 body 报警', lint(de).warnings.some((w) => w.includes('body 为空')), JSON.stringify(lint(de).warnings));
    de.sections[1].body = '未闭合 **粗';
    ok('body 过行内标记校验', lint(de).warnings.some((w) => w.includes('.body')));

    // 工作台切形态只改 variant，派生位靠 reindex 重算
    d.sections[0].variant = 'text';
    reindex(d);
    ok('reindex 重算 isText 并补 body', d.sections[0].isText === true && d.sections[0].body === '');
  }

  console.log('\nYAML 往返');
  const a = load(dataFile);
  const yaml1 = emitYaml(a);
  const f1 = join(tmp, 'r1.yaml');
  writeFileSync(f1, yaml1, 'utf8');

  let b;
  try {
    b = load(f1);
  } catch (e) {
    ok('重新解析', false, e.message);
    return report();
  }
  ok('重新解析', true);
  ok(
    '数据不变',
    JSON.stringify(strip(a)) === JSON.stringify(strip(b)),
    firstDiff(strip(a), strip(b)),
  );

  const yaml2 = emitYaml(b);
  ok('二次序列化字节一致', yaml1 === yaml2);

  console.log('\n引号边界');
  const nasty = {
    meta: { skin: 'datasheet', output: 'x', pages: 1, theme: {} },
    profile: {
      name: '甲',
      seeking: '',
      contact: [{ label: 'a: b', value: '# 井号', href: null }],
    },
    sections: [
      {
        title: '边界',
        variant: 'entry',
        items: [],
        entries: [
          {
            org: '**星号开头**',
            badge: 'yes',
            meta: '3.6',
            when: null,
            brief: '尾部空格 ',
            briefLabel: '简介',
            facts: [{ k: 'null', v: '~' }],
            awards: [{ name: '含"引号"的名字', tier: null, when: null }],
            points: [{ text: '- 减号开头' }, { text: '反斜杠 \\ 和 "引号"' }],
          },
        ],
      },
    ],
  };
  const f2 = join(tmp, 'r2.yaml');
  writeFileSync(f2, emitYaml(nasty), 'utf8');
  let c;
  try {
    c = load(f2);
    ok('刁钻标量能解析', true);
    const e = c.sections[0].entries[0];
    ok('星号开头保住了', e.org === '**星号开头**', e.org);
    ok('yes 没变成布尔', e.badge === 'yes', JSON.stringify(e.badge));
    ok('3.6 没变成数字', e.meta === '3.6', JSON.stringify(e.meta));
    ok('尾部空格保住了', e.brief === '尾部空格 ', JSON.stringify(e.brief));
    ok('减号开头保住了', e.points[0].text === '- 减号开头', e.points[0].text);
    ok('反斜杠和引号保住了', e.points[1].text === '反斜杠 \\ 和 "引号"', e.points[1].text);
    ok('井号保住了', c.profile.contact[0].value === '# 井号', c.profile.contact[0].value);
    ok('键里的冒号保住了', c.profile.contact[0].label === 'a: b', c.profile.contact[0].label);
    ok('null 字符串没变成空', e.facts[0].k === 'null', JSON.stringify(e.facts[0].k));
  } catch (e) {
    ok('刁钻标量能解析', false, e.message);
  }

  return report();
}

/** 找出第一处不一样的路径，不然对着两坨 JSON 干瞪眼 */
function firstDiff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return '';
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return `${path}: 结构不同`;
}

function report() {
  const tag = fail ? '\x1b[31m失败\x1b[0m' : '\x1b[32m全过\x1b[0m';
  console.log(`\n${tag}  ${pass} 过 / ${fail} 挂\n`);
  return fail === 0;
}
