import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createManualDrawController } from './manualDraw.js';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = new Map();
    this.label = { textContent: '' };
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, [...list, listener]);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  querySelector(selector) {
    return selector === '.map-draw-label' ? this.label : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function harness({ picks = [] } = {}) {
  const canvas = new FakeEventTarget();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  let index = 0;
  const viewer = {
    scene: {
      canvas,
      pickPosition: () => null,
    },
    camera: {
      pickEllipsoid: () => {
        const [lon, lat] = picks[index++] || [];
        return lon == null ? null : Cesium.Cartesian3.fromDegrees(lon, lat);
      },
    },
  };
  const button = new FakeEventTarget();
  const status = { textContent: '' };
  const calls = [];
  const annotations = {
    annotate: async (specs, options) => {
      calls.push({ specs, options });
      return { ok: true, drawn: specs.length };
    },
  };
  const controller = createManualDrawController({ viewer, annotations, button, status });
  return { canvas, button, status, calls, controller };
}

const click = (target, clientX = 1, clientY = 1) => target.dispatch('click', { clientX, clientY });
const doubleClick = (target) => target.dispatch('dblclick', { preventDefault() {} });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const assertCoordinate = (actual, expected) => {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} is not close to ${expected}`);
};

test('point mode creates a pin from a picked world coordinate', async () => {
  const { canvas, button, calls, controller } = harness({ picks: [[-97.7431, 30.2672]] });

  click(button);
  click(canvas, 20, 30);
  await settle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].specs[0].type, 'pin');
  assertCoordinate(calls[0].specs[0].longitude, -97.7431);
  assertCoordinate(calls[0].specs[0].latitude, 30.2672);
  assert.equal(calls[0].specs[0].label, '手动标记');
  assert.equal(calls[0].specs[0].color, 'cyan');
  assert.deepEqual(calls[0].options, { persist: true });
  assert.equal(button.dataset.active, 'false');
  controller.destroy();
});

test('route mode submits canonical latitude/longitude waypoints on double click', async () => {
  const { canvas, button, calls, controller } = harness({
    picks: [[-97.7, 30.2], [-97.6, 30.3]],
  });

  click(button); // pin
  click(button); // route
  click(canvas);
  click(canvas);
  doubleClick(canvas);
  await settle();

  assert.equal(calls.length, 1);
  const routePoints = calls[0].specs[0].points;
  assert.equal(routePoints.length, 2);
  assertCoordinate(routePoints[0].latitude, 30.2);
  assertCoordinate(routePoints[0].longitude, -97.7);
  assertCoordinate(routePoints[1].latitude, 30.3);
  assertCoordinate(routePoints[1].longitude, -97.6);
  controller.destroy();
});

test('area mode submits a ring only after three picked points', async () => {
  const { canvas, button, calls, controller } = harness({
    picks: [[-97.7, 30.2], [-97.6, 30.2], [-97.6, 30.3]],
  });

  click(button); // pin
  click(button); // route
  click(button); // area
  click(canvas);
  click(canvas);
  click(canvas);
  doubleClick(canvas);
  await settle();

  assert.equal(calls.length, 1);
  const ring = calls[0].specs[0].ring;
  assert.equal(ring.length, 3);
  [[-97.7, 30.2], [-97.6, 30.2], [-97.6, 30.3]].forEach(([lon, lat], i) => {
    assertCoordinate(ring[i][0], lon);
    assertCoordinate(ring[i][1], lat);
  });
  controller.destroy();
});

test('unpickable clicks and incomplete paths do not submit annotations', async () => {
  const { canvas, button, calls, controller } = harness({ picks: [] });

  click(button); // pin
  click(canvas);
  await settle();
  assert.equal(calls.length, 0);

  click(button); // route
  click(canvas);
  doubleClick(canvas);
  await settle();
  assert.equal(calls.length, 0);
  controller.destroy();
});

test('destroy removes listeners without replacing the caller-owned button', async () => {
  const { canvas, button, calls, controller } = harness({ picks: [[1, 2]] });
  const originalButton = button;
  assert.equal(button.listenerCount('click'), 1);
  assert.equal(canvas.listenerCount('click'), 1);
  assert.equal(canvas.listenerCount('dblclick'), 1);

  controller.destroy();
  assert.equal(button, originalButton);
  assert.equal(button.listenerCount('click'), 0);
  assert.equal(canvas.listenerCount('click'), 0);
  assert.equal(canvas.listenerCount('dblclick'), 0);

  click(button);
  click(canvas);
  await settle();
  assert.equal(calls.length, 0);
});
