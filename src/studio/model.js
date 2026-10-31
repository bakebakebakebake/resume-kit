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
 * 哪些字段吃行内标记。
 *
 * 这些字段编辑时显示原始标记（`**重点**` 而不是加粗后的样子）:
 * 所见即所得在有标记的地方会打架 —— contenteditable 里改加粗后的 span,
 * 浏览器会塞进各种自己的标签,再反推回标记就没准了。
 * 显示源码反而更好预测,跟 Obsidian 的源码模式一个道理。
 */
const MARKUP_FIELDS = /(\.points\.\d+\.text|\.items\.\d+\.text|\.brief|\.awards\.\d+\.name)$/;
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

/** 深拷贝一份快照，撤销栈用 */
export const snap = (data) => JSON.parse(JSON.stringify(data));
