import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAssistantText } from './messageText.js';

test('assistant text removes emphasis markers without changing values or line breaks', () => {
  assert.equal(formatAssistantText('**Flight**: IGO68N\n***Type***: 787-9\n*Altitude*: 4525 ft'),
    'Flight: IGO68N\nType: 787-9\nAltitude: 4525 ft');
});

test('asterisk lists retain plain list markers, indentation and CRLF line endings', () => {
  assert.equal(formatAssistantText('* Flight: IGO68N\r\n  * Source: OpenSky\r\n- Status: live'),
    '- Flight: IGO68N\r\n  - Source: OpenSky\r\n- Status: live');
});

test('streaming and escaped formatting markers never leak into the presentation', () => {
  for (const input of ['*', '**', '***', '\\*', '\\**']) assert.equal(formatAssistantText(input), '');
  assert.equal(formatAssistantText('**Flight'), 'Flight');
  assert.equal(formatAssistantText('**Flight*'), 'Flight');
  assert.equal(formatAssistantText('\\*\\*Flight\\*\\*'), 'Flight');
});

test('formatting does not interpret HTML or alter otherwise plain text', () => {
  for (const text of ['', 'IGO68N: 4525 ft', '<img src=x onerror=alert(1)>', 'Source: https://example.test/?a=1&b=2']) {
    assert.equal(formatAssistantText(text), text);
  }
  assert.equal(formatAssistantText(null), '');
  assert.equal(formatAssistantText(undefined), '');
});

test('localizes raw YOLO aerial class names in Simplified Chinese replies', () => {
  assert.equal(formatAssistantText('ground_track_field 28%, bridge 62%, soccer ball field 85%', 'zh-CN'), '田径场 28%, 桥梁 62%, 足球场 85%');
  assert.equal(formatAssistantText('ground_track_field 28%', 'en'), 'ground_track_field 28%');
});
