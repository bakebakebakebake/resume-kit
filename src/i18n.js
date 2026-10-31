/**
 * 简历产物里由程序写死的那几个字 —— 按 meta.lang 选一套。
 *
 * 只管落到简历上的文字（页头前缀、默认标签、文件名后缀），
 * 工作台界面和命令行提示是给用户自己看的，不在这里。
 *
 * 以 lang 的主语言部分匹配：en / en-US / en-GB 都走 en，
 * 认不出的语言回落到中文，跟没写 lang 时的老行为一致。
 */

const LABELS = {
  zh: {
    seeking: '求职岗位',
    brief: '简介',
    untitled: '未命名章节',
    docTitle: (name) => `${name} 简历`,
    standalone: '单文件',
  },
  en: {
    seeking: 'Seeking',
    brief: 'Summary',
    untitled: 'Untitled section',
    docTitle: (name) => `${name} Resume`,
    standalone: 'standalone',
  },
};

export const DEFAULT_LANG = 'zh-CN';

export function labelsFor(lang) {
  const primary = String(lang ?? DEFAULT_LANG).toLowerCase().split('-')[0];
  return LABELS[primary] ?? LABELS.zh;
}
