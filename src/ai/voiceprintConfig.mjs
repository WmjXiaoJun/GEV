const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENABLED_VALUES = new Set(['0', '1', 'false', 'true', 'no', 'yes', 'off', 'on']);
const MIN_THRESHOLD = 0.01;
const MAX_THRESHOLD = 1;

const invalid = () => Object.assign(new Error('Invalid voiceprint configuration.'), { code: 'VOICEPRINT_INVALID_CONFIG' });

function parseEnabled(value) {
  const raw = String(value ?? '0').trim().toLowerCase();
  if (!ENABLED_VALUES.has(raw)) throw invalid();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function resolveVoiceprintConfig(env = {}) {
  const enabled = parseEnabled(env.VOICEPRINT_ENABLED);
  const mode = String(env.VOICEPRINT_MODE ?? 'observe').trim().toLowerCase();
  if (!['observe', 'enforce'].includes(mode)) throw invalid();
  const profile = String(env.VOICEPRINT_PROFILE ?? '').trim();
  if (profile && !PROFILE_ID.test(profile)) throw invalid();
  const rawThreshold = env.VOICEPRINT_THRESHOLD ?? '0.25';
  const threshold = Number(rawThreshold);
  if (!Number.isFinite(threshold) || threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) throw invalid();
  return { enabled, mode, profile, threshold };
}

export { PROFILE_ID as VOICEPRINT_PROFILE_ID };
