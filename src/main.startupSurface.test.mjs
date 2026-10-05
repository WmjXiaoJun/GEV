import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');

test('voice dock receives the already initialized configured-model assistant', () => {
  const assistantIndex = mainSource.indexOf('window.__godsEyeView.aiAssistant = initAiAssistant(');
  const voiceIndex = mainSource.indexOf('window.__godsEyeView.voiceCommands = initGevVoiceCommands(');
  assert.ok(assistantIndex > 0 && voiceIndex > assistantIndex);
  assert.match(mainSource.slice(voiceIndex, voiceIndex + 330), /assistant: window\.__godsEyeView\.aiAssistant/);
});

test('startup never hides the globe before photoreal has rendered a visible surface', () => {
  const photorealLoadIndex = mainSource.indexOf('const photoreal = await loadPhotorealisticTileset');
  assert.ok(photorealLoadIndex > 0, 'startup should still load photoreal tiles when configured');

  const beforePhotorealLoad = mainSource.slice(0, photorealLoadIndex);
  assert.doesNotMatch(
    beforePhotorealLoad,
    /viewer\.scene\.globe\.show = false;/,
    'the startup path must not hide the fallback globe before photoreal has any chance to render',
  );

  const tilesetBranchStart = mainSource.indexOf('if (tileset) {', photorealLoadIndex);
  const tilesetBranchEnd = mainSource.indexOf('\n    } else {', tilesetBranchStart);
  assert.ok(tilesetBranchStart > 0 && tilesetBranchEnd > tilesetBranchStart);
  const tilesetBranch = mainSource.slice(tilesetBranchStart, tilesetBranchEnd);

  assert.doesNotMatch(
    tilesetBranch,
    /viewer\.scene\.globe\.show = false;/,
    'adding the tileset should defer globe hiding to the photoreal readiness guard',
  );
});
