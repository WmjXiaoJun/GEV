import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisionAnnotations } from './visionMapOverlay.js';

test('builds bounded point annotations from image detections using normalized centers', () => {
  const result = {
    image: { width: 1000, height: 500 },
    detections: [
      { class: 'plane', confidence: 0.91, box: { x: 100, y: 50, width: 100, height: 50 } },
      { class: 'car', confidence: 0.72, box: { x: 900, y: 400, width: 300, height: 200 } },
      { class: 'invalid', confidence: 0.4, box: { x: -2, y: 0, width: 5, height: 5 } },
    ],
  };
  const marks = buildVisionAnnotations(result);
  assert.equal(marks.length, 2);
  assert.deepEqual(marks[0], {
    type: 'pin', screenX: 0.15, screenY: 0.15, color: 'cyan',
    label: '飞机 91%', persist: true,
  });
  assert.deepEqual(marks[1], {
    type: 'pin', screenX: 1, screenY: 1, color: 'amber',
    label: '汽车 72%', persist: true,
  });
});

test('does not turn empty, stale, malformed or overlong results into map marks', () => {
  assert.deepEqual(buildVisionAnnotations(null), []);
  assert.deepEqual(buildVisionAnnotations({ image: { width: 100, height: 100 }, detections: [] }), []);
  assert.deepEqual(buildVisionAnnotations({ image: { width: 0, height: 100 }, detections: [] }), []);
  const detections = Array.from({ length: 301 }, (_, index) => ({
    class: `class-${index}`, confidence: 0.5, box: { x: 1, y: 1, width: 2, height: 2 },
  }));
  assert.equal(buildVisionAnnotations({ image: { width: 100, height: 100 }, detections }).length, 60);
});
