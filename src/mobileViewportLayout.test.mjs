import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function allDeclarationsFor(selector, source = css) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = [];
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.trim());
    if (selectors.includes(selector)) matches.push(match[2]);
  }
  return matches;
}

function declarationsFor(selector, source = css) {
  const matches = allDeclarationsFor(selector, source);
  assert.ok(matches.length > 0, `missing responsive rule for ${selector}`);
  return matches.at(-1);
}

function declarationValue(declarations, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = declarations.match(new RegExp(`(?:^|;)\\s*${escaped}:\\s*([^;]+)`));
  assert.ok(match, `missing ${property} declaration`);
  return match[1].trim();
}

function lengthToPixels(value, { viewportHeight, remPixels = 16 } = {}) {
  const expression = value.startsWith('calc(') ? value.slice(5, -1) : value;
  return expression.split('+').reduce((total, rawTerm) => {
    const term = rawTerm.trim();
    const number = Number.parseFloat(term);
    assert.ok(Number.isFinite(number), `unsupported length term: ${term}`);
    if (term.endsWith('rem')) return total + number * remPixels;
    if (term.endsWith('vh')) return total + number * viewportHeight / 100;
    if (term.endsWith('px')) return total + number;
    assert.fail(`unsupported length unit: ${term}`);
  }, 0);
}

function mediaBody(maxWidth, requiredSelector) {
  const marker = `@media (max-width: ${maxWidth}px)`;
  let cursor = 0;
  while (cursor < css.length) {
    const mediaStart = css.indexOf(marker, cursor);
    if (mediaStart < 0) break;
    const open = css.indexOf('{', mediaStart + marker.length);
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
      close += 1;
    }
    const body = css.slice(open + 1, close - 1);
    if (body.includes(requiredSelector)) return body;
    cursor = close;
  }
  assert.fail(`${requiredSelector} must be scoped to max-width: ${maxWidth}px`);
}

test('narrow tactical HUD corners stay in separate half-width lanes', () => {
  const selector = "#intel-hud[data-variant='tactical'] .hud-corner";
  const mobile = mediaBody(720, selector);
  const corner = declarationsFor(selector, mobile);
  const content = declarationsFor("#intel-hud[data-variant='tactical'] .hud-content", mobile);
  const rows = declarationsFor("#intel-hud[data-variant='tactical'] .hud-content > div", mobile);
  const summary = declarationsFor("#intel-hud[data-variant='tactical'] .hud-summary-wrap", mobile);

  assert.match(corner, /box-sizing:\s*border-box;/);
  assert.match(corner, /width:\s*calc\(50vw - 1\.5rem\);/);
  assert.match(corner, /max-width:\s*calc\(50vw - 1\.5rem\);/);
  assert.match(content, /min-width:\s*0;/);
  assert.match(content, /width:\s*100%;/);
  assert.match(content, /max-width:\s*100%;/);
  assert.match(rows, /overflow:\s*hidden;/);
  assert.match(rows, /text-overflow:\s*ellipsis;/);
  assert.match(rows, /white-space:\s*nowrap;/);
  assert.match(summary, /max-width:\s*100%;/);

  const viewportWidth = 390;
  const leftInset = Number.parseFloat(declarationValue(declarationsFor('.hud-top-left', mobile), 'left'));
  const rightInset = Number.parseFloat(declarationValue(declarationsFor('.hud-top-right', mobile), 'right'));
  const lane = declarationValue(corner, 'width').match(/^calc\(([\d.]+)vw - ([\d.]+)rem\)$/);
  assert.ok(lane, 'the HUD lane width must remain a simple viewport/rem calculation');
  const laneWidth = viewportWidth * Number(lane[1]) / 100 - Number(lane[2]) * 16;
  assert.ok(
    leftInset + laneWidth <= viewportWidth - rightInset - laneWidth,
    'the 390px left and right HUD lanes must not intersect',
  );
});

test('narrow attribution keeps every credit visible beside the key setup chip', () => {
  const selector = 'body:not(.ui-clean-view):not(.recording-mode) #cesium-credits .cesium-credit-expand-link';
  const mobile = mediaBody(620, selector);
  const creditLink = declarationsFor(
    selector,
    mobile,
  );

  assert.match(creditLink, /display:\s*block\s*!important;/);
  assert.match(creditLink, /width:\s*max-content;/);
  assert.doesNotMatch(creditLink, /display:\s*none/);
  assert.doesNotMatch(creditLink, /visibility:\s*hidden/);
  assert.doesNotMatch(creditLink, /opacity:\s*0(?:\D|$)/);

  const chipBase = allDeclarationsFor('#key-setup-chip')[0];
  assert.match(chipBase, /display:\s*flex;/, 'the key setup control must remain available');
  for (const chipRule of allDeclarationsFor('#key-setup-chip')) {
    assert.doesNotMatch(chipRule, /display:\s*none/);
    assert.doesNotMatch(chipRule, /visibility:\s*hidden/);
    assert.doesNotMatch(chipRule, /opacity:\s*0(?:\D|$)/);
  }
});

test('390px key setup chip clears both the bottom HUD and command dock', () => {
  const viewportHeight = 844;
  const measuredChipHeight = 32;
  const measuredDockHeight = 62;
  const hudBottomRule = declarationsFor(
    "#intel-hud[data-variant='tactical'] .hud-bottom-left",
  );
  const keyMobile = mediaBody(620, '#key-setup-chip');
  const dockMobile = mediaBody(720, '#command-dock');
  const keyBottom = lengthToPixels(
    declarationValue(declarationsFor('#key-setup-chip', keyMobile), 'bottom'),
    { viewportHeight },
  );
  const hudBottom = lengthToPixels(declarationValue(hudBottomRule, 'bottom'), { viewportHeight });
  const dockBottom = lengthToPixels(
    declarationValue(declarationsFor('#command-dock', dockMobile), 'bottom'),
    { viewportHeight },
  );

  const chipBase = allDeclarationsFor('#key-setup-chip')[0];
  assert.match(chipBase, /gap:\s*0\.4rem;/);
  assert.match(chipBase, /padding:\s*0\.45rem 0\.7rem;/);
  assert.match(chipBase, /font-size:\s*0\.6rem;/);
  assert.ok(
    hudBottom - (keyBottom + measuredChipHeight) >= 4,
    'the key setup chip needs at least 4px below both bottom HUD corners',
  );
  assert.ok(
    keyBottom - (dockBottom + measuredDockHeight) >= 8,
    'the key setup chip needs at least 8px above the command dock',
  );
});
