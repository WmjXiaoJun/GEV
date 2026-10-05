import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoiceprintConfig } from './voiceprintConfig.mjs';
import { publicSpeechConfig } from './speechConfig.mjs';
import { validateKeySetupUpdates } from '../keySetupCore.mjs';

test('voiceprint settings have explicit defaults and expose the saved threshold', () => {
  assert.deepEqual(resolveVoiceprintConfig({}), { enabled: false, mode: 'observe', profile: '', threshold: 0.25 });
  const env = { VOICEPRINT_ENABLED: '1', VOICEPRINT_MODE: 'enforce', VOICEPRINT_PROFILE: 'owner', VOICEPRINT_THRESHOLD: '0.18' };
  assert.deepEqual(publicSpeechConfig(env).voiceprint, { enabled: true, mode: 'enforce', profile: 'owner', threshold: 0.18 });
  assert.equal(validateKeySetupUpdates(env).ok, true);
  for (const enabled of ['true', 'yes', 'on']) assert.equal(resolveVoiceprintConfig({ VOICEPRINT_ENABLED: enabled }).enabled, true);
});

test('invalid voiceprint settings cannot silently disable enforcement or change the matching threshold', () => {
  for (const update of [
    { VOICEPRINT_ENABLED: 'maybe' }, { VOICEPRINT_MODE: 'typo' }, { VOICEPRINT_PROFILE: '../owner' },
    { VOICEPRINT_THRESHOLD: 'NaN' }, { VOICEPRINT_THRESHOLD: 'Infinity' },
    { VOICEPRINT_THRESHOLD: '0' }, { VOICEPRINT_THRESHOLD: '1.1' },
  ]) {
    assert.throws(() => resolveVoiceprintConfig(update));
    assert.equal(validateKeySetupUpdates(update).ok, false);
  }
});
