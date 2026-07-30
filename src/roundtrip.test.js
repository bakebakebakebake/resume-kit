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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from './data.js';
import { emitYaml } from './emit-yaml.js';
import { inline, tokens } from './markup.js';

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
        { text: '普通 ', bold: false, code: false },
        { text: '粗', bold: true, code: false },
        { text: ' 再 ', bold: false, code: false },
        { text: '码', bold: false, code: true },
        { text: ' 尾', bold: false, code: false },
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
