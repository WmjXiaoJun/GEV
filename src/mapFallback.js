import { t } from './i18n.js';

export const OFFLINE_FALLBACK_STACK_ID = 'offline-fallback';
export const NATURAL_EARTH_II_PATH = 'Assets/Textures/NaturalEarthII';

function localizeFallbackReason(reason) {
  const detail = String(reason || '').trim();
  if (!detail) return '';
  return detail === 'tile requests failed'
    ? t('map.tileRequestsFailed')
    : detail;
}

export function formatMapFallbackStatus({ stackLabel = 'Map source', reason = '' } = {}) {
  const label = String(stackLabel || 'Map source').trim() || 'Map source';
  const detail = localizeFallbackReason(reason);
  return detail
    ? t('map.offlineFallbackWithReason', { label, detail })
    : t('map.offlineFallback', { label });
}

export function resolveNaturalEarthIiUrl(Cesium) {
  if (!Cesium?.buildModuleUrl) throw new Error('Cesium.buildModuleUrl is required');
  return Cesium.buildModuleUrl(NATURAL_EARTH_II_PATH);
}

export async function createOfflineImageryProvider(Cesium, { credit = 'Cesium Natural Earth II' } = {}) {
  if (!Cesium?.TileMapServiceImageryProvider?.fromUrl) {
    throw new Error('Cesium.TileMapServiceImageryProvider.fromUrl is required');
  }
  const url = resolveNaturalEarthIiUrl(Cesium);
  const provider = await Cesium.TileMapServiceImageryProvider.fromUrl(url, { credit });
  return {
    provider,
    effectiveStackId: OFFLINE_FALLBACK_STACK_ID,
    fallbackMessage: null,
    sourceUrl: url,
  };
}

export default createOfflineImageryProvider;
