import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const controller = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');

test('remote basemap endpoints use reachable alternate hosts before offline fallback', () => {
  assert.match(
    controller,
    /https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer/,
    'Esri imagery should use the responsive ArcGIS tile host',
  );
  assert.match(
    controller,
    /https:\/\/tile\.openstreetmap\.de\//,
    'OSM should use the reachable German community mirror with OSM attribution',
  );
  assert.doesNotMatch(
    controller,
    /https:\/\/services\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer/,
    'the repeatedly timing-out ArcGIS metadata host must not remain active',
  );
});

test('offline fallback activation is guarded by the switch generation and active provider', () => {
  assert.match(
    controller,
    /async _activateOfflineFallback\(\{ stackId = 'osm', reason = 'tile requests failed', gen = this\._switchGen, provider = this\._activeImageryProvider \} = \{\}\)/,
    'offline fallback must capture both the triggering generation and provider identity',
  );
  assert.match(
    controller,
    /if \(gen !== this\._switchGen \|\| provider !== this\._activeImageryProvider\) return;/,
    'a stale error callback must not install offline imagery after a newer switch',
  );
});

test('offline fallback installation is single-flight and reuses the same pending promise', () => {
  assert.match(controller, /this\._offlineFallbackPending = null;/);
  assert.match(
    controller,
    /if \(this\._offlineFallbackPending\) return this\._offlineFallbackPending;/,
    'concurrent OSM tile failures must share one pending offline provider installation',
  );
  assert.match(
    controller,
    /this\._offlineFallbackPending = \(async \(\) => \{/,
    'offline fallback installation must be wrapped in one tracked async transaction',
  );
  assert.match(
    controller,
    /}\)\(\)\.finally\(\(\) => \{\s*this\._offlineFallbackPending = null;\s*}\);/,
    'the single-flight latch must always clear after success or failure',
  );
});

test('OSM tile error fallback installs offline imagery only when the scene still belongs to that provider', () => {
  assert.match(
    controller,
    /void this\._activateOfflineFallback\(\{\s*stackId: resolution\.effectiveStackId,\s*reason: 'tile requests failed',\s*gen,\s*provider: resolution\.provider,\s*}\);/,
    'the OSM error path must pass the original provider identity into offline fallback',
  );
  assert.match(
    controller,
    /if \(this\._activeImageryProvider === resolution\.provider\) return;/,
    'repeated errors from the same already-replaced provider must not reinstall the offline layer',
  );
});

test('globe stacks install bundled imagery as an underlay before waiting on a remote source', () => {
  const activationStart = controller.indexOf('async _activateGlobeStack(stack, gen)');
  const activationEnd = controller.indexOf('\n  /**', activationStart);
  const activation = controller.slice(activationStart, activationEnd);

  assert.match(
    controller,
    /this\._offlineUnderlayLayer = null;/,
    'the controller must track the bundled safety layer independently from remote imagery',
  );
  assert.match(
    activation,
    /await this\._ensureOfflineUnderlay\(gen\)/,
    'every globe stack must make bundled imagery visible while remote imagery is unresolved',
  );
  assert.ok(
    activation.indexOf('await this._ensureOfflineUnderlay(gen)')
      < activation.indexOf('await remoteProviderResult'),
    'the local underlay must settle before the controller waits for a remote provider',
  );
});

test('photoreal mode removes both remote imagery and the bundled underlay', () => {
  const activationStart = controller.indexOf('async _activatePhotoreal(gen)');
  const activationEnd = controller.indexOf('\n  async _activateGlobeStack', activationStart);
  const activation = controller.slice(activationStart, activationEnd);

  assert.match(activation, /this\._removeImageryLayer\(\);/);
  assert.match(activation, /this\._removeTerrainWatcher\(\);/);
  assert.match(activation, /this\._terrainMode = null;/);
});

test('photoreal startup keeps a textured globe until the first tiles become visible', () => {
  const activationStart = controller.indexOf('async _activatePhotoreal(gen)');
  const activationEnd = controller.indexOf('\n  async _activateGlobeStack', activationStart);
  const activation = controller.slice(activationStart, activationEnd);

  assert.match(
    controller,
    /this\._photorealReady = false;/,
    'controller should remember whether photoreal has ever produced visible tiles this session',
  );
  assert.match(
    controller,
    /this\._removePhotorealReadyListener = null;/,
    'photoreal reveal listeners need explicit teardown tracking',
  );
  assert.match(
    activation,
    /await this\._ensureOfflineUnderlay\(gen\);/,
    'photoreal activation must keep bundled imagery available while tiles are still warming up',
  );
  assert.match(
    activation,
    /this\._watchPhotorealReadiness\(gen\);/,
    'photoreal activation should arm a reveal watcher instead of hiding the globe immediately',
  );
  assert.match(
    activation,
    /if \(this\._photorealReady\) \{[\s\S]*?this\.viewer\.scene\.globe\.show = false;[\s\S]*?} else \{[\s\S]*?this\.viewer\.scene\.globe\.show = true;[\s\S]*?this\._watchPhotorealReadiness\(gen\);/,
    'globe visibility should stay true until the tileset has been marked visibly ready',
  );
  assert.match(
    controller,
    /_watchPhotorealReadiness\(gen\) \{[\s\S]*?void this\._commitPhotorealVisible\(gen\)[\s\S]*?add\(this\.googleTileset\.tileVisible\);[\s\S]*?add\(this\.googleTileset\.initialTilesLoaded\);[\s\S]*?add\(this\.googleTileset\.allTilesLoaded\);/,
    'the reveal watcher should hide the globe only after Cesium reports visible or fully loaded tiles',
  );
  assert.match(
    controller,
    /_commitPhotorealVisible\(gen\) \{[\s\S]*?this\._removeOfflineUnderlay\(\);[\s\S]*?this\.viewer\.scene\.globe\.show = false;[\s\S]*?governorRequestRender\('map-photoreal-visible'\);/,
    'once photoreal is actually visible, the underlay should be removed and the globe hidden in one render step',
  );
});

test('keyless terrain watches the live provider and falls back single-flight on tile errors', () => {
  assert.match(
    controller,
    /this\._removeTerrainErrorListener = null;/,
    'terrain error watchers must be tracked independently from imagery watchers',
  );
  assert.match(
    controller,
    /this\._keylessTerrainFallbackPending = null;/,
    'terrain fallback needs its own single-flight latch',
  );
  assert.match(
    controller,
    /this\._watchKeylessTerrainProvider\(provider, gen\);/,
    'a keyless terrain provider must be watched after it is installed on the viewer',
  );
  assert.match(
    controller,
    /if \(targetMode === this\._terrainMode\) \{[\s\S]*?if \(!enabled\) \{[\s\S]*?this\._watchKeylessTerrainProvider\(this\.viewer\.terrainProvider, gen\);/,
    'repeat keyless globe switches must rebind the terrain watcher to the current switch generation',
  );
});

test('reselecting a keyless stack refreshes the terrain watcher generation', () => {
  const methodStart = controller.indexOf('async _setWorldTerrainEnabled(enabled, gen)');
  const methodEnd = controller.indexOf('\n  _watchKeylessTerrainProvider', methodStart);
  const method = controller.slice(methodStart, methodEnd);

  assert.match(
    method,
    /if \(targetMode === this\._terrainMode\) \{[\s\S]*?this\._watchKeylessTerrainProvider\(this\.viewer\.terrainProvider, gen\);[\s\S]*?return;[\s\S]*?}/,
    'a restored OSM share must replace the stale watcher with the current switch generation',
  );
});

test('keyless terrain fallback is guarded by the active generation and terrain provider identity', () => {
  assert.match(
    controller,
    /async _activateFlatTerrainFallback\(\{ gen = this\._switchGen, provider = this\.viewer\.terrainProvider \} = \{\}\)/,
    'terrain fallback must capture the triggering switch generation and provider identity',
  );
  assert.match(
    controller,
    /if \(this\._terrainMode !== 'keyless'\) return;/,
    'only keyless terrain may auto-fallback to the flat ellipsoid provider',
  );
  assert.match(
    controller,
    /if \(gen !== this\._switchGen \|\| provider !== this\.viewer\.terrainProvider\) return;/,
    'a stale terrain error callback must not replace a newer terrain selection',
  );
});

test('keyless terrain fallback caches the flat provider and requests a redraw', () => {
  assert.match(
    controller,
    /const fallback = new Cesium\.EllipsoidTerrainProvider\(\);/,
    'terrain fallback must create a fresh flat ellipsoid provider when live terrain fails',
  );
  assert.match(
    controller,
    /this\.viewer\.terrainProvider = fallback;/,
    'the fallback terrain provider must be installed on the viewer',
  );
  assert.match(
    controller,
    /this\._reearthTerrainProvider = fallback;/,
    'subsequent keyless globe switches must reuse the proven flat fallback for the rest of the session',
  );
  assert.match(
    controller,
    /governorRequestRender\('map-terrain-fallback'\);/,
    'terrain fallback must force a redraw after the globe regains a surface',
  );
});
