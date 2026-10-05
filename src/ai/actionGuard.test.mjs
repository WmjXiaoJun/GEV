import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionGuard } from './actionGuard.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(overrides = {}) {
  let map = { style: 'normal', layer: false };
  const actions = [];
  const changes = [];
  const snapshots = [];
  const restored = [];
  const guard = createActionGuard({
    runAction: async (name, args) => {
      actions.push({ name, args });
      if (name === 'set_visual_style') map = { ...map, style: args.style };
      if (name === 'set_layer_visibility') map = { ...map, layer: args.enabled };
      return { ok: true };
    },
    captureState: async (name, args) => {
      snapshots.push({ name, args });
      return name === 'set_visual_style' ? { style: map.style } : { layer: map.layer };
    },
    restoreState: async (snapshot, name, args) => {
      restored.push({ snapshot, name, args });
      map = { ...map, ...snapshot };
      return { ok: true };
    },
    onChange: (state) => changes.push(state),
    ...overrides,
  });
  return { guard, actions, changes, snapshots, restored, map: () => map };
}

test('mutation waits for confirmation and captures only immediately before execution', async () => {
  const f = fixture();
  const args = { style: 'thermal' };
  const waiting = f.guard.runAction('set_visual_style', args);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(f.actions.length, 0);
  assert.equal(f.snapshots.length, 0);
  assert.deepEqual(f.guard.getState().pending, { name: 'set_visual_style', arguments: args, remainingSeconds: 3 });
  args.style = 'noir';
  const exposed = f.guard.getState();
  exposed.pending.arguments.style = 'snow';
  assert.equal(f.guard.getState().pending.arguments.style, 'thermal');
  assert.deepEqual(await f.guard.confirm(), { ok: true });
  assert.deepEqual(await waiting, { ok: true });
  assert.equal(f.map().style, 'thermal');
  assert.equal(f.guard.getState().undoName, 'set_visual_style');
  assert.equal(f.guard.getState().canUndo, true);
});

test('all five mutation tools require confirmation', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['fly_to_location', { latitude: 0, longitude: 0 }],
    ['set_layer_visibility', { layerId: 'flights', enabled: true }],
    ['set_visual_style', { style: 'noir' }],
    ['adjust_camera_zoom', { direction: 'in', amount: 'little' }],
    ['zoom_to_globe', {}],
  ]) {
    const waiting = f.guard.runAction(name, args, { confirmed: true });
    assert.equal(f.guard.getState().pending.name, name);
    f.guard.reject();
    assert.equal((await waiting).cancelled, true);
  }
  assert.equal(f.actions.length, 0);
});

test('read-only tools bypass confirmation but unknown and invalid calls never reach the runner', async () => {
  const f = fixture();
  await f.guard.runAction('get_current_view_state', {});
  await f.guard.runAction('get_entity_context', { scope: 'in_view', limit: 3 });
  assert.equal(f.actions.length, 2);
  assert.equal(f.guard.getState().pending, null);
  for (const [name, args] of [
    ['run_shell', {}], ['set_visual_style', { style: 'invalid' }],
    ['set_layer_visibility', { layerId: 'flights', enabled: 'yes' }],
    ['fly_to_location', { latitude: 100, longitude: 2 }],
    ['get_entity_context', { limit: 100 }], ['zoom_to_globe', null],
  ]) assert.equal((await f.guard.runAction(name, args)).ok, false);
  assert.equal(f.actions.length, 2);
});

test('viewport statistics bypass countdown and undo snapshots', async () => {
  const f = fixture({ setTimer: () => { throw new Error('Read-only statistics must not start a timer'); } });
  assert.equal((await f.guard.runAction('get_view_statistics', { layerId: 'local-datacenters', limit: 1 })).ok, true);
  assert.equal(f.actions.length, 1);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.guard.getState().pending, null);
  assert.equal(f.guard.getState().canUndo, false);
});

test('reject and cancel resolve the original request without any effects', async () => {
  const f = fixture();
  const rejected = f.guard.runAction('zoom_to_globe', {});
  f.guard.reject();
  assert.deepEqual(await rejected, { ok: false, cancelled: true, error: 'User declined action' });
  const cancelled = f.guard.runAction('zoom_to_globe', {});
  f.guard.cancel();
  assert.deepEqual(await cancelled, { ok: false, cancelled: true, error: 'Action cancelled' });
  assert.equal(f.guard.getState().pending, null);
  assert.equal(f.actions.length, 0);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.guard.getState().canUndo, false);
});

test('abort signals cancel pending requests and pre-aborted requests never become pending', async () => {
  const f = fixture();
  const controller = new AbortController();
  const waiting = f.guard.runAction('zoom_to_globe', {}, { signal: controller.signal });
  controller.abort();
  assert.equal((await waiting).cancelled, true);
  assert.equal(f.guard.getState().pending, null);
  assert.equal((await f.guard.runAction('zoom_to_globe', {}, { signal: controller.signal })).cancelled, true);
  assert.equal(f.actions.length, 0);
});

test('busy operations and duplicate confirmation cannot create concurrent mutations or undo', async () => {
  const release = deferred();
  const f = fixture({ runAction: async () => release.promise });
  const waiting = f.guard.runAction('zoom_to_globe', {});
  assert.equal((await f.guard.runAction('set_visual_style', { style: 'noir' })).ok, false);
  assert.equal((await f.guard.undo()).ok, false);
  const confirming = f.guard.confirm();
  await tick();
  assert.equal(f.guard.getState().executing, true);
  assert.equal((await f.guard.confirm()).ok, false);
  assert.equal((await f.guard.undo()).ok, false);
  release.resolve({ ok: true });
  await confirming;
  await waiting;
  assert.equal(f.guard.getState().executing, false);
});

test('undo restores only the affected state and preserves a bounded multi-level history', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i += 1) {
    const waiting = f.guard.runAction('set_visual_style', { style: i % 2 ? 'noir' : 'thermal' });
    await f.guard.confirm();
    await waiting;
  }
  for (let i = 0; i < 10; i += 1) assert.equal((await f.guard.undo()).ok, true);
  assert.equal(f.restored.length, 10);
  assert.equal(f.map().style, 'noir');
  assert.equal(f.map().layer, false);
  assert.equal(f.guard.getState().canUndo, false);
  assert.equal((await f.guard.undo()).ok, false);
});

test('failed and thrown actions preserve a snapshot to recover partial side effects', async () => {
  for (const throws of [false, true]) {
    const f = fixture({ runAction: async () => {
      if (throws) throw new Error('private credential');
      return { ok: false, error: 'Map unavailable' };
    } });
    const waiting = f.guard.runAction('zoom_to_globe', {});
    assert.equal((await f.guard.confirm()).ok, false);
    assert.equal((await waiting).ok, false);
    assert.equal(f.guard.getState().canUndo, true);
    assert.equal(JSON.stringify(f.changes).includes('private credential'), false);
    assert.equal((await f.guard.undo()).ok, true);
  }
});

test('failed snapshot capture prevents action execution and does not create undo history', async () => {
  for (const captureState of [async () => { throw new Error('private'); }, async () => undefined]) {
    const f = fixture({ captureState });
    const waiting = f.guard.runAction('zoom_to_globe', {});
    assert.equal((await f.guard.confirm()).ok, false);
    assert.equal((await waiting).ok, false);
    assert.equal(f.actions.length, 0);
    assert.equal(f.guard.getState().canUndo, false);
    assert.equal(JSON.stringify(f.changes).includes('private'), false);
  }
});

test('undo failure preserves history for retry and never leaks internal exceptions', async () => {
  let attempt = 0;
  const f = fixture({ restoreState: async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('private credential');
    return attempt === 2 ? { ok: false, error: 'private' } : { ok: true };
  } });
  const waiting = f.guard.runAction('zoom_to_globe', {});
  await f.guard.confirm();
  await waiting;
  assert.equal((await f.guard.undo()).ok, false);
  assert.equal(f.guard.getState().canUndo, true);
  assert.equal((await f.guard.undo()).ok, false);
  assert.equal(f.guard.getState().canUndo, true);
  assert.equal((await f.guard.undo()).ok, true);
  assert.equal(f.guard.getState().canUndo, false);
  assert.equal(JSON.stringify(f.changes).includes('private'), false);
});

test('cancelling during snapshot capture never starts the map action', async () => {
  const capture = deferred();
  const f = fixture({ captureState: async () => capture.promise });
  const waiting = f.guard.runAction('zoom_to_globe', {});
  const confirming = f.guard.confirm();
  f.guard.cancel();
  assert.equal((await waiting).cancelled, true);
  capture.resolve({ camera: {} });
  await confirming;
  assert.equal(f.actions.length, 0);
  assert.equal(f.guard.getState().canUndo, false);
});

test('cancelling an executing action aborts its runner and retains a recovery snapshot', async () => {
  const release = deferred();
  let signal;
  let isCurrent;
  const f = fixture({ runAction: async (_name, _args, options) => {
    ({ signal, isCurrent } = options);
    return release.promise;
  } });
  const waiting = f.guard.runAction('zoom_to_globe', {});
  const confirming = f.guard.confirm();
  await tick();
  assert.equal(isCurrent(), true);
  f.guard.cancel();
  assert.equal((await waiting).cancelled, true);
  assert.equal(signal.aborted, true);
  assert.equal(isCurrent(), false);
  assert.equal((await f.guard.undo()).ok, false);
  release.resolve({ ok: false });
  await confirming;
  assert.equal(f.guard.getState().canUndo, true);
});

test('stale caller check cancels confirmation before changing state', async () => {
  const f = fixture();
  const waiting = f.guard.runAction('zoom_to_globe', {}, { isCurrent: () => false });
  const result = await f.guard.confirm();
  assert.equal(result.cancelled, true);
  assert.equal((await waiting).cancelled, true);
  assert.equal(f.actions.length, 0);
});

test('destroy releases waiting callers and prevents later operations', async () => {
  const f = fixture();
  const waiting = f.guard.runAction('zoom_to_globe', {});
  f.guard.destroy();
  assert.equal((await waiting).cancelled, true);
  assert.equal((await f.guard.runAction('zoom_to_globe', {})).ok, false);
  assert.equal((await f.guard.runAction('get_current_view_state', {})).ok, false);
  assert.equal((await f.guard.confirm()).ok, false);
  assert.equal((await f.guard.undo()).ok, false);
  f.guard.destroy();
  f.guard.cancel();
  f.guard.reject();
  assert.equal(f.actions.length, 0);
});

function autoConfirmClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const scheduled = [];
  const cleared = [];
  return {
    timers, scheduled, cleared,
    now: () => now,
    setTimer(callback, delay) {
      const timer = { id: ++nextId, callback, delay, due: now + delay };
      timers.set(timer.id, timer);
      scheduled.push(timer);
      return timer.id;
    },
    clearTimer(id) { cleared.push(id); timers.delete(id); },
    advance(ms) {
      now += ms;
      const due = [...timers.values()].filter((timer) => timer.due <= now).sort((a, b) => a.due - b.due);
      for (const timer of due) {
        if (!timers.delete(timer.id)) continue;
        timer.callback();
      }
    },
  };
}

function countdownFixture(overrides = {}) {
  const clock = autoConfirmClock();
  return { ...fixture({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, ...overrides }), clock };
}

test('auto-confirm waits exactly three seconds before capturing and executing the pending map action', async () => {
  const f = countdownFixture();
  const waiting = f.guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    assert.equal(f.clock.scheduled.length, 1, 'A pending mutation must schedule automatic confirmation');
    assert.equal(f.guard.getState().pending.remainingSeconds, 3);
    f.clock.advance(2999);
    await tick();
    assert.equal(f.actions.length, 0);
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.guard.getState().pending.name, 'set_visual_style');
    f.clock.advance(1);
    await tick();
    assert.equal(f.actions.length, 1);
    assert.equal(f.snapshots.length, 1);
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(f.map().style, 'thermal');
    assert.equal(f.guard.getState().canUndo, true);
    assert.equal(f.clock.timers.size, 0);
    f.clock.advance(6000);
    await tick();
    assert.equal(f.actions.length, 1);
  } finally { f.guard.destroy(); }
});

test('auto-confirm timer is cleared by manual confirmation and cannot execute the action twice', async () => {
  const f = countdownFixture();
  const waiting = f.guard.runAction('set_visual_style', { style: 'noir' });
  try {
    assert.equal(f.clock.scheduled.length, 1);
    const timer = f.clock.scheduled[0];
    f.clock.advance(500);
    await f.guard.confirm();
    assert.deepEqual(await waiting, { ok: true });
    assert.equal(f.clock.timers.size, 0);
    assert.ok(f.clock.cleared.includes(timer.id));
    timer.callback();
    f.clock.advance(5000);
    await tick();
    assert.equal(f.actions.length, 1);
    assert.equal(f.snapshots.length, 1);
  } finally { f.guard.destroy(); }
});

test('auto-confirm timer is cleared by rejection with no map changes or snapshots', async () => {
  const f = countdownFixture();
  const waiting = f.guard.runAction('zoom_to_globe', {});
  try {
    assert.equal(f.clock.scheduled.length, 1);
    const timer = f.clock.scheduled[0];
    f.guard.reject();
    assert.deepEqual(await waiting, { ok: false, cancelled: true, error: 'User declined action' });
    assert.equal(f.clock.timers.size, 0);
    assert.ok(f.clock.cleared.includes(timer.id));
    timer.callback();
    f.clock.advance(5000);
    await tick();
    assert.equal(f.actions.length, 0);
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.guard.getState().pending, null);
  } finally { f.guard.destroy(); }
});

test('auto-confirm timer is cleared by cancellation and destruction and late callbacks remain inert', async () => {
  for (const method of ['cancel', 'destroy']) {
    const f = countdownFixture();
    const waiting = f.guard.runAction('set_visual_style', { style: 'snow' });
    try {
      assert.equal(f.clock.scheduled.length, 1, `${method} must have a countdown to clean up`);
      const timer = f.clock.scheduled[0];
      f.guard[method]();
      assert.equal((await waiting).cancelled, true);
      assert.equal(f.clock.timers.size, 0);
      assert.ok(f.clock.cleared.includes(timer.id));
      timer.callback();
      f.clock.advance(5000);
      await tick();
      assert.equal(f.actions.length, 0);
      assert.equal(f.snapshots.length, 0);
      assert.equal(f.guard.getState().canUndo, false);
    } finally { f.guard.destroy(); }
  }
});

test('auto-confirm timer is cleared by an AbortSignal and never schedules pre-aborted actions', async () => {
  const f = countdownFixture();
  const controller = new AbortController();
  const waiting = f.guard.runAction('zoom_to_globe', {}, { signal: controller.signal });
  try {
    assert.equal(f.clock.scheduled.length, 1);
    const timer = f.clock.scheduled[0];
    controller.abort();
    assert.equal((await waiting).cancelled, true);
    assert.equal(f.clock.timers.size, 0);
    assert.ok(f.clock.cleared.includes(timer.id));
    assert.equal((await f.guard.runAction('zoom_to_globe', {}, { signal: controller.signal })).cancelled, true);
    assert.equal(f.clock.scheduled.length, 1);
    timer.callback();
    f.clock.advance(5000);
    await tick();
    assert.equal(f.actions.length, 0);
  } finally { f.guard.destroy(); }
});

test('auto-confirm callback from an earlier request cannot confirm a replacement request', async () => {
  const f = countdownFixture();
  const first = f.guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    assert.equal(f.clock.scheduled.length, 1);
    const stale = f.clock.scheduled[0];
    f.clock.advance(500);
    f.guard.reject();
    await first;
    const second = f.guard.runAction('set_visual_style', { style: 'noir' });
    assert.equal(f.clock.scheduled.length, 2);
    stale.callback();
    await tick();
    assert.equal(f.actions.length, 0);
    assert.equal(f.guard.getState().pending.arguments.style, 'noir');
    f.clock.advance(2999);
    await tick();
    assert.equal(f.actions.length, 0);
    f.clock.advance(1);
    await tick();
    assert.equal(f.actions.length, 1);
    assert.equal((await second).ok, true);
    assert.equal(f.map().style, 'noir');
  } finally { f.guard.destroy(); }
});

test('auto-confirm never schedules read-only, invalid, or busy map requests', async () => {
  const f = countdownFixture();
  try {
    await f.guard.runAction('get_current_view_state', {});
    await f.guard.runAction('get_entity_context', { scope: 'in_view' });
    assert.equal((await f.guard.runAction('run_shell', {})).ok, false);
    assert.equal((await f.guard.runAction('set_visual_style', { style: 'invalid' })).ok, false);
    assert.equal(f.clock.scheduled.length, 0);
    const waiting = f.guard.runAction('zoom_to_globe', {});
    assert.equal(f.clock.scheduled.length, 1);
    assert.equal((await f.guard.runAction('set_visual_style', { style: 'noir' })).ok, false);
    assert.equal(f.clock.scheduled.length, 1);
    f.guard.cancel();
    await waiting;
    assert.equal(f.clock.timers.size, 0);
  } finally { f.guard.destroy(); }
});

test('auto-confirm cancellation during snapshot capture clears the countdown and never starts the runner', async () => {
  const capture = deferred();
  const f = countdownFixture({ captureState: () => capture.promise });
  const waiting = f.guard.runAction('zoom_to_globe', {});
  try {
    assert.equal(f.clock.scheduled.length, 1);
    f.clock.advance(3000);
    await tick();
    assert.equal(f.guard.getState().executing, true);
    assert.equal(f.clock.timers.size, 0);
    f.guard.cancel();
    assert.equal((await waiting).cancelled, true);
    capture.resolve({ camera: {} });
    await tick();
    assert.equal(f.actions.length, 0);
    assert.equal(f.guard.getState().executing, false);
    assert.equal(f.guard.getState().canUndo, false);
  } finally { capture.resolve({ camera: {} }); f.guard.destroy(); }
});

test('auto-confirm publishes remaining seconds three, two, one before the execution state', async () => {
  const f = countdownFixture();
  const waiting = f.guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    assert.equal(f.guard.getState().pending.remainingSeconds, 3);
    assert.equal(f.changes.at(-1).pending.remainingSeconds, 3);
    f.clock.advance(1000);
    await tick();
    assert.equal(f.guard.getState().pending.remainingSeconds, 2);
    f.clock.advance(1000);
    await tick();
    assert.equal(f.guard.getState().pending.remainingSeconds, 1);
    assert.deepEqual(f.changes.filter((state) => state.pending).map((state) => state.pending.remainingSeconds), [3, 2, 1]);
    assert.equal(f.actions.length, 0);
    f.clock.advance(1000);
    await tick();
    assert.equal((await waiting).ok, true);
    assert.equal(f.guard.getState().pending, null);
    assert.ok(f.changes.some((state) => state.executing && !state.pending));
    assert.equal(f.clock.timers.size, 0);
  } finally { f.guard.destroy(); }
});

test('auto-confirm uses the deadline when a delayed timer resumes after three seconds', async () => {
  const f = countdownFixture();
  const waiting = f.guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    assert.equal(f.clock.scheduled.length, 1);
    f.clock.advance(9000);
    await tick();
    assert.equal(f.actions.length, 1);
    assert.equal((await waiting).ok, true);
    assert.equal(f.clock.timers.size, 0);
  } finally { f.guard.destroy(); }
});

test('auto-confirm cannot reschedule after an onChange listener cancels the countdown', async () => {
  let guard;
  const f = countdownFixture({ onChange: (state) => {
    if (state.pending?.remainingSeconds === 2) guard.cancel();
  } });
  guard = f.guard;
  const waiting = guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    f.clock.advance(1000);
    assert.equal((await waiting).cancelled, true);
    assert.equal(f.clock.timers.size, 0);
    f.clock.advance(5000);
    await tick();
    assert.equal(f.actions.length, 0);
    assert.equal(f.snapshots.length, 0);
  } finally { guard.destroy(); }
});

test('auto-confirm cannot reschedule after an onChange listener manually confirms', async () => {
  let guard;
  const f = countdownFixture({ onChange: (state) => {
    if (state.pending?.remainingSeconds === 2) void guard.confirm();
  } });
  guard = f.guard;
  const waiting = guard.runAction('set_visual_style', { style: 'thermal' });
  try {
    f.clock.advance(1000);
    await tick();
    assert.equal((await waiting).ok, true);
    assert.equal(f.clock.timers.size, 0);
    f.clock.advance(5000);
    await tick();
    assert.equal(f.actions.length, 1);
    assert.equal(f.snapshots.length, 1);
  } finally { guard.destroy(); }
});
