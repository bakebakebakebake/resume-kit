/**
 * 数据模型的读写工具。
 *
 * 工作台在浏览器里持有一份完整数据,DOM 上的每个可编辑元素都带
 * data-bind="路径"。所有改动都走这里的 getAt / setAt,
 * DOM 只是数据的一个视图 —— 不从 DOM 反推数据,免得两边慢慢走偏。
 */

/** "sections.0.entries.1.org" → 取值 */
export function getAt(root, path) {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setAt(root, path, value) {
  const segs = path.split('.');
  const last = segs.pop();
  let cur = root;
  for (const seg of segs) {
    if (cur[seg] == null) cur[seg] = /^\d+$/.test(seg) ? [] : {};
    cur = cur[seg];
  }
  cur[last] = value;
}

/** 行路径 → { arr, index, type }，用来做增删和排序 */
export function locate(root, rowPath) {
  const segs = rowPath.split('.');
  const index = Number(segs.pop());
  const arrPath = segs.join('.');
  return {
    arr: getAt(root, arrPath),
    arrPath,
    index,
    type: rowType(rowPath),
  };
}

/**
 * 从路径形状认出这是哪种行。
 * 倒数第二段就是容器名，唯一的例外是 sections 本身（只有两段）。
 */
export function rowType(path) {
  if (path === 'profile') return 'profile';
  const segs = path.split('.');
  const container = segs[segs.length - 2];
  return (
    {
      sections: 'section',
      entries: 'entry',
      points: 'point',
      items: 'item',
      awards: 'award',
      facts: 'fact',
      contact: 'contact',
    }[container] ?? 'unknown'
  );
}

const LABEL = {
  section: '章节',
  entry: '条目',
  point: '要点',
  item: '技能',
  award: '奖项',
  fact: '数据',
  contact: '联系方式',
  profile: '页头',
};
export const label = (t) => LABEL[t] ?? '这行';

/** 新建一行的空白内容。带 _p 占位，reindex 会把它算对。 */
export function blank(type) {
  switch (type) {
    case 'section':
      return {
        title: '新章节',
        variant: 'entry',
        isProject: false,
        isList: false,
        items: [],
        entries: [blank('entry')],
        _p: '',
      };
    case 'entry':
      return {
        org: '新条目',
        badge: null,
        meta: null,
        when: null,
        brief: null,
        briefLabel: null, // 服务端 reindex 按 meta.lang 补默认值
        facts: [],
        awards: [],
        points: [{ text: '写点什么', _p: '' }],
        _p: '',
      };
    case 'point':
    case 'item':
      return { text: '新的一条', _p: '' };
    case 'award':
      return { name: '奖项名称', tier: null, when: null, _p: '' };
    case 'fact':
      return { k: '项目', v: '数值', _p: '' };
    case 'contact':
      return { label: '标签', value: '内容', href: null, _p: '' };
    default:
      return null;
  }
}

/**
 * 哪些字段吃行内标记（加粗 / 技术名 / 链接）。
 * 编辑时照样显示渲染后的样子，提交时从 DOM 读出格式再写回标记，
 * 见 paper.js 的 readRuns + markup.js 的 fromTokens。
 */
const MARKUP_FIELDS = /(\.points\.\d+\.text|\.items\.\d+\.text|\.brief|\.body|\.awards\.\d+\.name)$/;
export const isMarkupField = (path) => MARKUP_FIELDS.test(path);

/** 空了就该消失的字段。必填的留着空字符串，让校验去报。 */
const OPTIONAL = /(\.badge|\.meta|\.when|\.tier|\.brief|profile\.seeking)$/;
export const isOptional = (path) => OPTIONAL.test(path);

/**
 * 按 Enter 能续条的行类型：要点 / 技能。
 * 这两种行的字段就是行本身（li 同时带 data-row 和 data-bind），
 * 新建的空白内容直接是 { text: '' }，焦点可以立即落进去。
 */
export const isContinuable = (type) => type === 'point' || type === 'item';

/**
 * 行路径 → 新行创建后焦点要落的 data-bind 路径。
 * point/item 的字段就是行本身（路径相同）；
 * entry 落在 org；award 落在 name；fact 落在 k；contact 落在 label。
 */
export function focusFieldOfType(rowPath, type) {
  switch (type) {
    case 'point':
    case 'item':
      return rowPath + '.text';
    case 'entry':
      return rowPath + '.org';
    case 'award':
      return rowPath + '.name';
    case 'fact':
      return rowPath + '.k';
    case 'contact':
      return rowPath + '.label';
    default:
      return null;
  }
}

/**
 * data-bind 字段路径 → 所属 data-row 行路径。
 * 行路径是字段路径去掉最后一段（字段名），但 point/item 的路径本身
 * 就是 …points.N.text / …items.N.text，行路径是去掉 .text 那一段。
 */
export function rowPathOfField(fieldPath) {
  // point/item: sections.S.entries.E.points.N.text → sections.S.entries.E.points.N
  if (/\.(points|items)\.\d+\.text$/.test(fieldPath)) {
    return fieldPath.slice(0, fieldPath.lastIndexOf('.'));
  }
  // 其它字段：去掉最后的 .fieldName
  return fieldPath.slice(0, fieldPath.lastIndexOf('.'));
}

/**
 * 一行里可以补回来的字段。
 *
 * 可选字段空了模板就不渲染，纸上没地方点，也就加不回来。
 * 工具条上的「+ 字段」列出当前缺的这些，点一下填个占位进去，
 * 重渲染后焦点落在占位上、整段选中，直接打字就替换掉。
 * kind=list 的是子列表：补的是一整行，焦点落在新行的第一格。
 */
const EXTRA = {
  entry: [
    { key: 'meta', name: '职位 / 副标题', ph: ['职位', 'Role'] },
    { key: 'when', name: '时间', ph: ['2024.01 — 至今', 'Jan 2024 — Present'] },
    { key: 'badge', name: '标签', ph: ['标签', 'Tag'] },
    { key: 'brief', name: '简介', ph: ['一句话说清楚做了什么', 'One line on what this was'] },
    { key: 'facts', name: '数据', kind: 'list', row: 'fact', focus: '.k' },
    { key: 'points', name: '要点', kind: 'list', row: 'point', focus: '.text' },
    { key: 'awards', name: '奖项', kind: 'list', row: 'award', focus: '.name' },
  ],
  award: [
    { key: 'tier', name: '等级', ph: ['一等奖', 'First Prize'] },
    { key: 'when', name: '时间', ph: ['2024.01', 'Jan 2024'] },
  ],
  profile: [
    { key: 'seeking', name: '求职意向', ph: ['目标岗位', 'Target role'] },
    { key: 'contact', name: '联系方式', kind: 'list', row: 'contact', focus: '.label' },
  ],
};

/** 这一行现在缺哪些字段 */
export function missingFields(data, rowPath) {
  const row = getAt(data, rowPath);
  if (!row) return [];
  return (EXTRA[rowType(rowPath)] ?? []).filter((f) =>
    f.kind === 'list' ? !row[f.key]?.length : row[f.key] == null || row[f.key] === '',
  );
}

/**
 * 补上一个字段，返回重渲染后该聚焦的 data-bind 路径。
 * 占位文字按简历语言挑，免得英文简历里冒出中文。
 */
export function fillField(data, rowPath, key) {
  const f = (EXTRA[rowType(rowPath)] ?? []).find((x) => x.key === key);
  const row = getAt(data, rowPath);
  if (!f || !row) return null;
  if (f.kind === 'list') {
    row[key] = [blank(f.row)];
    return `${rowPath}.${key}.0${f.focus}`;
  }
  const zh = String(data.meta?.lang ?? 'zh').toLowerCase().startsWith('zh');
  row[key] = f.ph[zh ? 0 : 1];
  return `${rowPath}.${key}`;
}

/** 深拷贝一份快照，撤销栈用 */
export const snap = (data) => JSON.parse(JSON.stringify(data));
