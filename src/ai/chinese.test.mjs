import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChineseText } from './chinese.js';

test('Chinese input and output use simplified script including regional variants', () => {
  assert.equal(normalizeChineseText('請問你能幹什麼工作？臺灣的飛機與衛星資訊。'), '请问你能干什么工作？台湾的飞机与卫星资讯。');
  assert.equal(normalizeChineseText('頭髮發現後臺'), '头发发现后台');
});

test('normalization preserves English, technical identifiers, whitespace and non-Chinese locale', () => {
  const text = 'OpenAI gpt-5.6-sol\nhttps://example.com/?q=1  51.2034';
  assert.equal(normalizeChineseText(text), text);
  assert.equal(normalizeChineseText('繁體輸入', 'en'), '繁體輸入');
  assert.equal(normalizeChineseText(null), '');
});
