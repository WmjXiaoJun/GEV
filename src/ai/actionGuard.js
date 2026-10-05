import { validToolCall } from './tools.js';

const READ_ONLY = new Set(['get_current_view_state', 'get_entity_context', 'get_view_statistics', 'analyze_terrain', 'plan_terrain_route', 'detect_viewport', 'detect_buildings', 'web_search']);
const HISTORY_LIMIT = 10;
const AUTO_CONFIRM_MS = 3000;
const failure = (error) => ({ ok: false, error });
const cancelled = (error = 'Action cancelled') => ({ ok: false, cancelled: true, error });

export function createActionGuard({
  runAction, captureState, restoreState, onChange = () => {},
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, now = Date.now,
} = {}) {
  let pending = null;
  let executing = null;
  let history = [];
  let error = null;
  let destroyed = false;

  const getState = () => ({
    pending: pending ? {
      name: pending.name, arguments: { ...pending.args },
      remainingSeconds: Math.max(1, Math.min(3, Math.ceil((pending.deadline - now()) / 1000))),
    } : null,
    executing: executing !== null,
    canUndo: !destroyed && !pending && !executing && history.length > 0,
    undoName: history.at(-1)?.name ?? null,
    error,
  });
  const emit = () => onChange(getState());
  const current = (job) => !destroyed && !job.controller.signal.aborted
    && job.options.isCurrent?.() !== false;

  const clearCountdown = (job) => {
    if (job.timer != null) clearTimer(job.timer);
    job.timer = null;
  };

  const scheduleCountdown = (job) => {
    job.timer = setTimer(() => {
      job.timer = null;
      if (pending !== job || destroyed || executing) return;
      if (now() >= job.deadline) { void confirm(); return; }
      emit();
      if (pending === job && !destroyed && !executing) scheduleCountdown(job);
    }, Math.min(1000, Math.max(0, job.deadline - now())));
  };

  const stop = (job, reason = 'Action cancelled') => {
    if (!job) return cancelled(reason);
    clearCountdown(job);
    job.controller.abort();
    job.settle(cancelled(reason));
    if (pending === job) pending = null;
    emit();
    return cancelled(reason);
  };

  const request = (name, args, options) => new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const onAbort = () => stop(job);
    const job = {
      name, args: { ...args }, options: { ...options }, controller,
      deadline: now() + AUTO_CONFIRM_MS, timer: null,
      settle(result) {
        if (settled) return;
        settled = true;
        clearCountdown(job);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
    };
    pending = job;
    error = null;
    options.signal?.addEventListener('abort', onAbort, { once: true });
    scheduleCountdown(job);
    emit();
  });

  const guardedRun = async (name, args = {}, options = {}) => {
    if (destroyed) return failure('Action guard is closed');
    if (options.signal?.aborted) return cancelled();
    if (!validToolCall({ id: 'guard', name, arguments: args })) return failure('Unknown or invalid map action');
    if (READ_ONLY.has(name)) return runAction(name, { ...args }, options);
    if (pending || executing) return failure('Another map action is awaiting completion');
    return request(name, args, options);
  };

  const confirm = async () => {
    if (!pending || executing || destroyed) return failure('No map action is awaiting confirmation');
    const job = pending;
    clearCountdown(job);
    pending = null;
    executing = job;
    error = null;
    emit();
    let snapshotCaptured = false;
    try {
      if (!current(job)) return stop(job);
      const snapshot = await captureState(job.name, { ...job.args });
      if (!current(job)) return stop(job);
      if (snapshot == null) throw new Error('Snapshot unavailable');
      snapshotCaptured = true;
      // Keep recovery state even if the runner fails after partially applying an action.
      history = [...history, { snapshot, name: job.name, args: { ...job.args } }].slice(-HISTORY_LIMIT);
      const result = await runAction(job.name, { ...job.args }, {
        ...job.options, signal: job.controller.signal, isCurrent: () => current(job),
      });
      if (!current(job)) return stop(job);
      const output = result ?? failure('Map action returned no result');
      if (output.ok !== true) error = 'Map action failed; undo is available';
      job.settle(output);
      return output;
    } catch {
      if (!current(job)) return stop(job);
      error = snapshotCaptured ? 'Map action failed; undo is available' : 'Map state could not be saved';
      const result = failure(error);
      job.settle(result);
      return result;
    } finally {
      if (executing === job) executing = null;
      emit();
    }
  };

  const undo = async () => {
    if (destroyed || pending || executing) return failure('Map actions are busy');
    const entry = history.at(-1);
    if (!entry) return failure('No map action to undo');
    const job = { controller: new AbortController(), settle() {} };
    executing = job;
    error = null;
    emit();
    try {
      const result = await restoreState(entry.snapshot, entry.name, { ...entry.args });
      if (result?.ok === false) throw new Error('Restore failed');
      history = history.slice(0, -1);
      return { ok: true, name: entry.name };
    } catch {
      error = 'Map action could not be undone';
      return failure(error);
    } finally {
      if (executing === job) executing = null;
      emit();
    }
  };

  return {
    runAction: guardedRun, confirm, undo, getState,
    reject: () => stop(pending, 'User declined action'),
    cancel: () => stop(pending ?? executing),
    destroy() {
      destroyed = true;
      stop(pending ?? executing);
      history = [];
      error = null;
      emit();
    },
  };
}
