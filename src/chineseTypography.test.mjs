import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const startMarker = '/* BEGIN Chinese readability overrides */';
const endMarker = '/* END Chinese readability overrides */';

function overrideSource() {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker);
  assert.ok(start >= 0, 'missing the Chinese readability override section');
  assert.ok(end > start, 'missing the end of the Chinese readability override section');
  return css.slice(start + startMarker.length, end);
}

function declarationsFor(selector) {
  const source = overrideSource().replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = splitSelectorList(match[1]);
    if (selectors.includes(selector)) return match[2];
  }
  assert.fail(`missing Chinese typography rule for ${selector}`);
}

function splitSelectorList(selectorList) {
  const selectors = [];
  let current = '';
  let depth = 0;
  for (const character of selectorList) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      selectors.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function fontSize(selector, expected) {
  const declarations = declarationsFor(selector);
  assert.match(declarations, new RegExp(`font-size:\\s*${expected.replace('.', '\\.')}\\s*;`));
}

test('Chinese typography overrides cannot change English UI typography', () => {
  const source = overrideSource().replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    for (const selector of splitSelectorList(match[1])) {
      assert.match(
        selector,
        /^(?:html\[lang='zh-CN'\]|:lang\(zh-CN\))(?:\s|$)/,
        `Chinese typography selector is not locale-scoped: ${selector}`,
      );
    }
  }
});

test('Chinese display controls use legible label, value, and button sizes', () => {
  fontSize("html[lang='zh-CN'] #pp-toggles .pp-header-label", '11px');
  fontSize("html[lang='zh-CN'] #pp-toggles .pp-label", '11px');
  fontSize("html[lang='zh-CN'] #pp-toggles .pp-slider-mini-label", '11px');
  fontSize("html[lang='zh-CN'] #pp-toggles :is(.pp-slider-value, .gev-slider-value)", '11px');
  fontSize("html[lang='zh-CN'] #pp-toggles :is(.pp-mode-btn, .pp-select)", '11px');
  fontSize("html[lang='zh-CN'] #param-slider-panel :is(.param-panel-title, .param-label, .param-value)", '11px');
});

test('Chinese panel launchers and top status chrome remain readable', () => {
  fontSize("html[lang='zh-CN'] #left-panel-stack .panel-title", '11px');
  fontSize("html[lang='zh-CN'] #right-context-rail .panel-title", '11px');
  fontSize("html[lang='zh-CN'] #title-bar .subtitle", '12px');
  fontSize("html[lang='zh-CN'] #style-indicator .indicator-label", '11px');
  fontSize("html[lang='zh-CN'] #style-indicator .indicator-value", '17px');
  fontSize("html[lang='zh-CN'] #top-center-actions #language-toggle", '11px');
  fontSize("html[lang='zh-CN'] :is(#global-loading-status, #traffic-sync-chip, #cctv-sync-chip)", '11px');
});

test('Chinese brand titles use CJK-friendly font and compact tracking', () => {
  for (const selector of [
    "html[lang='zh-CN'] #title-bar h1 > span[data-i18n='app.title']",
    "html[lang='zh-CN'] #loading-screen h2 > span[data-i18n='app.title']",
  ]) {
    const declarations = declarationsFor(selector);
    assert.match(declarations, /font-family:\s*var\(--font-zh-ui\)\s*;/);
    assert.match(declarations, /letter-spacing:\s*0\.12em\s*;/);
  }
});

test('Chinese dock, key chip, and HUD copy clear the micro-text floor', () => {
  fontSize("html[lang='zh-CN'] #command-dock :is(.panel-title, .location-toolbar-label)", '11px');
  fontSize("html[lang='zh-CN'] #command-dock :is(.btn-label, .location-pill, .poi-pill)", '10px');
  fontSize("html[lang='zh-CN'] #command-dock :is(.gev-voice-kicker, .gev-mic-label, #gev-voice-status, #gev-voice-detail)", '10px');
  fontSize("html[lang='zh-CN'] #command-dock :is(.gev-voice-tier-btn, .gev-voice-cost-value)", '10px');
  fontSize("html[lang='zh-CN'] #command-dock :is(.gev-voice-help-kicker, .gev-voice-error-header, .gev-voice-error-dismiss, .gev-voice-error-hint)", '10px');
  fontSize("html[lang='zh-CN'] #key-setup-chip", '11px');
  fontSize("html[lang='zh-CN'] #intel-hud .hud-summary-label", '11px');
  fontSize("html[lang='zh-CN'] #intel-hud .hud-summary", '12px');
  fontSize("html[lang='zh-CN'] #intel-hud .hud-mode", '17px');
});

test('Chinese first-run launcher copy avoids unreadable micro-text', () => {
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-header", '10px');
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-footer", '10px');
  fontSize("html[lang='zh-CN'] #first-run-launcher #first-run-description", '12px');
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-choices strong", '12px');
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-choices small", '10.5px');
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-suppress", '10.5px');
  fontSize("html[lang='zh-CN'] #first-run-launcher .first-run-note", '10.5px');
});
