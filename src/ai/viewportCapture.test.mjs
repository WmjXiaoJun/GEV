import test from 'node:test';
import assert from 'node:assert/strict';
import { captureViewportFrame, viewportFrameKey } from './viewportCapture.js';

function fixture({ hidden = false, black = false, tainted = false } = {}) {
  let listener = null;
  const drawing = [];
  const canvas = { width: 3840, height: 2160 };
  const camera = { positionWC: { x: 1, y: 2, z: 3 }, heading: 0, pitch: -1, roll: 0 };
  const scene = { canvas, mode: 3, postRender: { addEventListener(callback) { listener = callback; return () => { listener = null; }; } }, requestRender() {} };
  const documentRef = { hidden, createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage(...args) { drawing.push(args); if (tainted) throw new Error('private url'); }, getImageData: () => ({ data: new Uint8ClampedArray(64).fill(black ? 0 : 120) }) }),
    toDataURL: () => 'data:image/jpeg;base64,YQ==',
  }) };
  return { viewer: { scene, camera }, documentRef, drawing, render: () => listener?.(), listener: () => listener };
}

test('captures synchronously inside a fresh frame and downscales both dimensions', async () => {
  const f = fixture();
  const pending = captureViewportFrame(f.viewer, { documentRef: f.documentRef, now: () => 123 });
  assert.equal(f.drawing.length, 0);
  f.render();
  const result = await pending;
  assert.equal(result.image, 'data:image/jpeg;base64,YQ==');
  assert.equal(result.width, 1600);
  assert.equal(result.height, 900);
  assert.equal(result.capturedAt, 123);
  assert.equal(result.viewKey, viewportFrameKey(f.viewer));
  assert.equal(f.listener(), null);
});

test('building captures preserve more source detail with a 2048 pixel budget', async () => {
  const f = fixture();
  const pending = captureViewportFrame(f.viewer, { documentRef: f.documentRef, maxDimension: 2048 });
  f.render();
  const result = await pending;
  assert.equal(result.width, 2048);
  assert.equal(result.height, 1152);
});

test('hidden, missing, black and tainted frames fail closed', async () => {
  for (const settings of [{ hidden: true }, { black: true }, { tainted: true }]) {
    const f = fixture(settings);
    const pending = captureViewportFrame(f.viewer, { documentRef: f.documentRef });
    f.render();
    assert.equal(await pending, null);
  }
  assert.equal(await captureViewportFrame(null), null);
});

test('capture deadline and cancellation remove the frame listener', async () => {
  const f = fixture();
  assert.equal(await captureViewportFrame(f.viewer, { documentRef: f.documentRef, timeoutMs: 5 }), null);
  assert.equal(f.listener(), null);
  const controller = new AbortController();
  const pending = captureViewportFrame(f.viewer, { documentRef: f.documentRef, signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(f.listener(), null);
  assert.equal(await captureViewportFrame(f.viewer, { documentRef: f.documentRef, signal: controller.signal }), null);
});

test('loading map tiles are not sent as an empty scene', async () => {
  const f = fixture();
  f.viewer.scene.globe = { tilesLoaded: false };
  const pending = captureViewportFrame(f.viewer, { documentRef: f.documentRef });
  f.render();
  assert.equal(f.drawing.length, 0);
  f.viewer.scene.globe.tilesLoaded = true;
  f.render();
  assert.ok(await pending);
});

test('view key changes for moved cameras or resized canvases and missing views stay unavailable', () => {
  const f = fixture();
  const original = viewportFrameKey(f.viewer);
  assert.notEqual(original, viewportFrameKey({ ...f.viewer, camera: { ...f.viewer.camera, heading: 0.5 } }));
  assert.notEqual(original, viewportFrameKey({ ...f.viewer, scene: { ...f.viewer.scene, canvas: { width: 800, height: 600 } } }));
  assert.equal(viewportFrameKey(null), null);
});
