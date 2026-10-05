import test from 'node:test';
import assert from 'node:assert/strict';
import { validToolCall } from './tools.js';

const point = (index) => ({ longitude: -97 + index / 10000, latitude: 30, elevation: index, slopeDeg: index % 40 });
const routeCall = (points) => ({ id: 'route', name: 'annotate_map', arguments: { annotations: [{ type: 'route', points }] } });

test('LLM terrain route accepts the complete bounded explicit coordinate path', () => {
  for (const count of [2, 13, 441, 512]) {
    assert.equal(validToolCall(routeCall(Array.from({ length: count }, (_, index) => point(index)))), true, `${count} explicit points must fit`);
  }
  assert.equal(validToolCall(routeCall(Array.from({ length: 513 }, (_, index) => point(index)))), false);
});

test('LLM named and mixed routes retain the smaller resolver budget', () => {
  const named = Array.from({ length: 13 }, (_, index) => ({ target: `Place ${index}` }));
  assert.equal(validToolCall(routeCall(named.slice(0, 12))), true);
  assert.equal(validToolCall(routeCall(named)), false);
  assert.equal(validToolCall(routeCall([...Array.from({ length: 12 }, (_, index) => point(index)), { target: 'End' }])), false);
  assert.equal(validToolCall(routeCall(Array.from({ length: 13 }, (_, index) => ({ ...point(index), target: `Place ${index}` })))), false);
});

test('LLM explicit route budget does not bypass coordinate or slope validation', () => {
  for (const invalid of [{ longitude: 181 }, { latitude: NaN }, { slopeDeg: 90 }, { elevation: 10001 }]) {
    assert.equal(validToolCall(routeCall([point(0), { ...point(1), ...invalid }])), false);
  }
});
