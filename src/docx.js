/**
 * 数据 → .docx（OOXML）。
 *
 * 说清楚这个导出的定位：它是**语义导出**，不是 PDF 的像素复刻。
 * Word 的段落流装不下皮肤里那套 CSS 网格（masthead 两列对齐、
 * facts 用竖线分隔、awards 左右撑开），硬凑只会做出一个又像又不像的
 * 四不像。所以这里只保证三件事：
 *
 *   1. 层级正确 —— 标题是标题样式，ATS 和大纲视图能认出结构
 *   2. 强调不丢 —— **粗体** 和 `技术名` 分别落成粗体和主题色等宽
 *   3. 配色一致 —— 主题色 / 强调色跟简历一套，观感上认得出是同一份
 *
 * 时间靠右不用表格用制表位：Word 里表格会被某些 ATS 解析器打乱顺序，
 * 制表位是纯段落属性，最保险。
 */

import { zip } from './zip.js';
import { tokens } from './markup.js';

const MM_TO_TWIP = 56.7; // 1mm = 1440/25.4 twip
const mm = (v) => Math.round(parseFloat(v) * MM_TO_TWIP);
/** Word 的字号单位是半磅 */
const halfPt = (v) => Math.round(parseFloat(v) * 2);

const A4 = { w: mm(210), h: mm(297) };

/** 中文字体用系统里一定有的：子集字体嵌不进 docx，写了也白写 */
const FONT_SERIF = { ascii: 'Georgia', ea: '宋体' };
const FONT_BODY = { ascii: 'Georgia', ea: '楷体' };
const FONT_MONO = { ascii: 'Consolas', ea: '楷体' };

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const hex = (c, fallback) => String(c ?? fallback).replace(/^#/, '').toUpperCase();

/**
 * @param {object} data  normalize 后的数据
 * @param {object} defaults 皮肤 :root 的默认值，用来补 theme 没覆盖的项
 * @returns {Buffer} .docx 内容
 */
export function toDocx(data, defaults = {}) {
  const t = { ...defaults, ...(data.meta.theme ?? {}) };
  const K = {
    ink: hex(t.ink, '#14181C'),
    ink70: hex(t['ink-70'], '#454C52'),
    ink45: hex(t['ink-45'], '#7C8388'),
    petrol: hex(t.petrol, '#0E4F52'),
    brass: hex(t.brass, '#9C6F1F'),
    rule: hex(t.rule, '#D2CEC6'),
    // 正文字号：简历里是 8.95pt 这种为了塞满一页的值，
    // Word 里没有"一页装不下就裁掉"的约束，放大到正常阅读区间。
    fs: Math.max(9.5, parseFloat(t.fs ?? '9') + 1),
    lh: parseFloat(t.lh ?? 1.385),
  };
  const padX = t['pad-x'] ?? '12mm';
  const padT = t['pad-t'] ?? '11mm';
  const padB = t['pad-b'] ?? '9mm';
  // 右侧制表位：正文宽度的最右端，时间靠它右对齐
  const tabRight = A4.w - mm(padX) * 2;

  const P = [];
  P.push(...masthead(data.profile, K));
  for (const s of data.sections) P.push(...section(s, K, tabRight));

  const body = `${P.join('')}<w:sectPr><w:pgSz w:w="${A4.w}" w:h="${A4.h}"/><w:pgMar w:top="${mm(padT)}" w:right="${mm(padX)}" w:bottom="${mm(padB)}" w:left="${mm(padX)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;

  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(body) },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: stylesXml(K) },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: coreXml(data) },
    { name: 'docProps/app.xml', data: APP_XML },
  ]);
}

// ── 段落构造 ──

/** 一段文字 → 一串 run，粗体和代码各自带格式 */
function runs(text, K, base = {}) {
  const out = [];
  for (const tk of tokens(text)) {
    const font = tk.code ? FONT_MONO : (base.font ?? FONT_BODY);
    const color = tk.code ? K.petrol : (base.color ?? K.ink70);
    const bold = tk.bold || base.bold;
    const size = base.size ?? K.fs;
    out.push(
      `<w:r><w:rPr>` +
        `<w:rFonts w:ascii="${font.ascii}" w:hAnsi="${font.ascii}" w:eastAsia="${font.ea}"/>` +
        (bold ? '<w:b/>' : '') +
        `<w:color w:val="${bold && !tk.code ? K.ink : color}"/>` +
        `<w:sz w:val="${halfPt(size)}"/><w:szCs w:val="${halfPt(size)}"/>` +
        `</w:rPr><w:t xml:space="preserve">${esc(tk.text)}</w:t></w:r>`,
    );
  }
  return out.join('');
}

/** 纯文本 run，不解析标记 */
function run(text, K, o = {}) {
  const font = o.font ?? FONT_BODY;
  const size = o.size ?? K.fs;
  return (
    `<w:r><w:rPr>` +
    `<w:rFonts w:ascii="${font.ascii}" w:hAnsi="${font.ascii}" w:eastAsia="${font.ea}"/>` +
    (o.bold ? '<w:b/>' : '') +
    (o.caps ? '<w:spacing w:val="30"/>' : '') +
    `<w:color w:val="${o.color ?? K.ink70}"/>` +
    `<w:sz w:val="${halfPt(size)}"/><w:szCs w:val="${halfPt(size)}"/>` +
    `</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
  );
}

function para(inner, o = {}) {
  const pr =
    `<w:pPr>` +
    (o.style ? `<w:pStyle w:val="${o.style}"/>` : '') +
    (o.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${o.numId}"/></w:numPr>` : '') +
    (o.align ? `<w:jc w:val="${o.align}"/>` : '') +
    (o.tabRight ? `<w:tabs><w:tab w:val="right" w:pos="${o.tabRight}"/></w:tabs>` : '') +
    `<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 40}" w:line="${Math.round((o.lh ?? 1.3) * 240)}" w:lineRule="auto"/>` +
    (o.indent ? `<w:ind w:left="${o.indent}" w:hanging="${o.hanging ?? 0}"/>` : '') +
    (o.border
      ? `<w:pBdr><w:bottom w:val="single" w:sz="${o.borderSz ?? 6}" w:space="2" w:color="${o.border}"/></w:pBdr>`
      : '') +
    `</w:pPr>`;
  return `<w:p>${pr}${inner}</w:p>`;
}

function masthead(profile, K) {
  const out = [
    para(run(profile.name, K, { font: FONT_SERIF, size: K.fs * 2.6, bold: true, color: K.ink }), {
      after: 60,
      lh: 1.1,
    }),
  ];
  if (profile.seeking) {
    out.push(
      para(
        run('求职岗位 · ', K, { size: K.fs * 0.95, color: K.ink45 }) +
          run(profile.seeking, K, { size: K.fs * 0.95, bold: true, color: K.ink70 }),
        { after: 80 },
      ),
    );
  }
  if (profile.contact?.length) {
    const bits = profile.contact.map(
      (c, i) =>
        (i ? run('   ·   ', K, { color: K.rule, size: K.fs * 0.9 }) : '') +
        run(`${c.label} `, K, { color: K.ink45, size: K.fs * 0.9 }) +
        run(c.value, K, { color: K.ink70, size: K.fs * 0.9 }),
    );
    out.push(para(bits.join(''), { after: 120, border: K.rule, borderSz: 8 }));
  }
  return out;
}

function section(s, K, tabRight) {
  const out = [
    para(
      run(s.title, K, { font: FONT_SERIF, size: K.fs * 1.15, bold: true, color: K.petrol, caps: true }),
      { before: 200, after: 90, border: K.petrol, borderSz: 4 },
    ),
  ];

  if (s.isList) {
    for (const it of s.items ?? []) {
      out.push(para(runs(it.text, K), { numId: 1, indent: 300, hanging: 300, lh: K.lh, after: 50 }));
    }
    return out;
  }

  for (const e of s.entries ?? []) {
    // 标题行：机构 + 徽章 + 副标题，然后制表位把时间推到右边
    let head = run(e.org, K, {
      font: s.isProject ? FONT_BODY : FONT_SERIF,
      size: K.fs * 1.08,
      bold: true,
      color: K.ink,
    });
    if (e.badge) head += run(`  ${e.badge}`, K, { size: K.fs * 0.85, color: K.brass });
    if (e.meta) head += run(`  ${e.meta}`, K, { size: K.fs * 0.95, color: K.ink70 });
    if (e.when) {
      head += `<w:r><w:tab/></w:r>` + run(e.when, K, { size: K.fs * 0.9, color: K.ink45 });
    }
    out.push(para(head, { before: 110, after: 40, tabRight, lh: 1.2 }));

    if (e.facts?.length) {
      const bits = e.facts.map(
        (f, i) =>
          (i ? run('  |  ', K, { color: K.rule, size: K.fs * 0.88 }) : '') +
          run(`${f.k} `, K, { color: K.ink45, size: K.fs * 0.88 }) +
          run(f.v, K, { color: K.brass, bold: true, size: K.fs * 0.88 }),
      );
      out.push(para(bits.join(''), { after: 50 }));
    }

    if (e.brief) {
      out.push(
        para(
          run(`${e.briefLabel ?? '简介'} `, K, { size: K.fs * 0.85, color: K.ink45 }) +
            runs(e.brief, K, { size: K.fs * 0.96 }),
          { after: 60, lh: K.lh },
        ),
      );
    }

    for (const p of e.points ?? []) {
      out.push(para(runs(p.text, K), { numId: 1, indent: 300, hanging: 300, lh: K.lh, after: 50 }));
    }

    for (const a of e.awards ?? []) {
      let line = runs(a.name, K, { size: K.fs * 0.96 });
      if (a.tier) line += run(`  ${a.tier}`, K, { size: K.fs * 0.9, bold: true, color: K.brass });
      if (a.when) {
        line += `<w:r><w:tab/></w:r>` + run(a.when, K, { size: K.fs * 0.88, color: K.ink45 });
      }
      out.push(para(line, { after: 40, tabRight, indent: 160 }));
    }
  }
  return out;
}

// ── OOXML 骨架 ──

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const CONTENT_TYPES = `${XML}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `${XML}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const documentXml = (body) => `${XML}
<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;

const stylesXml = (K) => `${XML}
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${FONT_BODY.ascii}" w:hAnsi="${FONT_BODY.ascii}" w:eastAsia="${FONT_BODY.ea}"/>
<w:color w:val="${K.ink70}"/><w:sz w:val="${halfPt(K.fs)}"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="${Math.round(K.lh * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

/** 一个圆点列表定义就够，所有要点共用 numId=1 */
const NUMBERING = `${XML}
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="·"/>
<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="300" w:hanging="300"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:hint="default"/></w:rPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const coreXml = (data) => `${XML}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(data.profile.name)} 简历</dc:title>
<dc:creator>${esc(data.profile.name)}</dc:creator>
<cp:lastModifiedBy>resume-kit</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

const APP_XML = `${XML}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>resume-kit</Application>
</Properties>`;
