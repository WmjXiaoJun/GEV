import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_OUTSIDE_ALPHA,
  SCOPE_MASK_ENABLED_DEFAULT,
  _resetScopeMaskForTest,
  destroyScopeMask,
  getScopeTerminusAlpha,
  getScopeTerminusOverride,
  installScopeMask,
  isScopeMaskEnabled,
  setScopeMaskEnabled,
  setScopeTerminusOverride,
} from './scopeMask.js';

function stubScopeDom({ width = 1000, height = 800 } = {}) {
  const saved = {
    document: globalThis.document,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const ops = { resizes: 0, clears: 0, fills: 0 };
  const canvas = {
    id: '',
    style: {},
    _width: 0,
    _height: 0,
    set width(value) { ops.resizes += 1; this._width = value; },
    get width() { return this._width; },
    set height(value) { ops.resizes += 1; this._height = value; },
    get height() { return this._height; },
    setAttribute() {},
    remove() {},
    getContext() {
      return {
        setTransform() {},
        clearRect() { ops.clears += 1; },
        fillRect() { ops.fills += 1; },
        beginPath() {},
        rect() {},
        arc() {},
        fill() { ops.fills += 1; },
        createRadialGradient() {
          return { addColorStop() {} };
        },
      };
    },
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const container = { clientWidth: width, clientHeight: height, appendChild() {} };
  return {
    canvas,
    container,
    ops,
    restore() {
      globalThis.document = saved.document;
      globalThis.ResizeObserver = saved.ResizeObserver;
    },
  };
}

test('the scope mask is disabled on a fresh install, while explicit enable still paints it', () => {
  _resetScopeMaskForTest();
  assert.equal(SCOPE_MASK_ENABLED_DEFAULT, false);
  assert.equal(isScopeMaskEnabled(), false);

  const dom = stubScopeDom();
  try {
    installScopeMask({ container: dom.container });
    assert.equal(isScopeMaskEnabled(), false);
    assert.equal(dom.ops.resizes, 0, 'fresh scope-off install must not allocate a backing store');
    assert.equal(dom.ops.clears, 0, 'fresh scope-off install must not paint or clear a canvas');
    assert.equal(dom.ops.fills, 0, 'fresh scope-off install must leave the full globe unobscured');

    setScopeMaskEnabled(true);
    assert.ok(dom.ops.resizes > 0, 'the existing scope toggle must still enable the mask');
    assert.ok(dom.ops.fills > 0, 'explicitly enabling scope must still paint the circular mask');
  } finally {
    destroyScopeMask();
    dom.restore();
  }
});

test('destroying an enabled mask resets the next install to the default disabled state', () => {
  _resetScopeMaskForTest();
  const dom = stubScopeDom();
  try {
    installScopeMask({ container: dom.container });
    setScopeMaskEnabled(true);
    assert.equal(isScopeMaskEnabled(), true);
    setScopeTerminusOverride(0.97);
    assert.equal(getScopeTerminusOverride(), 0.97);
    assert.equal(getScopeTerminusAlpha(), 0.97);

    destroyScopeMask();
    const beforeReinstall = { ...dom.ops };

    installScopeMask({ container: dom.container });

    assert.equal(isScopeMaskEnabled(), SCOPE_MASK_ENABLED_DEFAULT,
      'a reinstall must begin with the fresh-session default');
    assert.equal(getScopeTerminusOverride(), null,
      'a reinstall must restore adaptive terminus behavior');
    assert.equal(getScopeTerminusAlpha(), SCOPE_OUTSIDE_ALPHA,
      'a reinstall must restore the adaptive globe-scale alpha baseline');
    assert.deepEqual(dom.ops, beforeReinstall,
      'a default-disabled reinstall must not paint or allocate a backing store');
  } finally {
    destroyScopeMask();
    dom.restore();
    _resetScopeMaskForTest();
  }
});
