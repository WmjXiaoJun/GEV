import { Converter } from 'opencc-js/t2cn';

const toSimplified = Converter({ from: 'tw', to: 'cn' });

/** Normalize complete display text, not individual streamed tokens. */
export function normalizeChineseText(text, locale = 'zh-CN') {
  if (typeof text !== 'string') return '';
  return locale === 'zh-CN' ? toSimplified(text) : text;
}
