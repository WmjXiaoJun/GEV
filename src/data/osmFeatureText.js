const MAX_TEXT_LENGTH = 120;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const HAN_CHARACTERS = /\p{Script=Han}/u;

const CATEGORY = Object.freeze({
  zh: Object.freeze({
    address: '门牌', building: '建筑', residence: '住宅', apartment: '公寓楼', commercial: '商业建筑',
    industrial: '工业建筑', school: '学校', kindergarten: '幼儿园', college: '学院', university: '大学',
    hospital: '医院', clinic: '诊所', police: '警察局', library: '图书馆', busStation: '公交站',
    platform: '站台', station: '站点', road: '道路', arterial: '主干道', localRoad: '支路', footway: '步道',
    city: '城市', town: '城镇', community: '社区', water: '水系', green: '绿地', facility: '公共设施',
  }),
  en: Object.freeze({
    address: 'Address', building: 'Building', residence: 'Residential building', apartment: 'Apartment building',
    commercial: 'Commercial building', industrial: 'Industrial building', school: 'School', kindergarten: 'Kindergarten',
    college: 'College', university: 'University', hospital: 'Hospital', clinic: 'Clinic', police: 'Police station',
    library: 'Library', busStation: 'Bus stop', platform: 'Platform', station: 'Station', road: 'Road', arterial: 'Arterial road',
    localRoad: 'Local road', footway: 'Footway', city: 'City', town: 'Town', community: 'Community',
    water: 'Waterway', green: 'Green space', facility: 'Public facility',
  }),
});

function clean(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return '';
  const text = String(value).replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, limit);
}

function sourceTags(properties) {
  const flat = properties && typeof properties === 'object' ? properties : {};
  const nested = flat.tags && typeof flat.tags === 'object' ? flat.tags : {};
  return { ...flat, ...nested };
}

function isChinese(value) {
  return HAN_CHARACTERS.test(String(value || ''));
}

function isChineseLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('zh');
}

function rawFeatureName(tags) {
  return [tags.name, tags['name:en'], tags.official_name, tags.alt_name]
    .map((value) => clean(value))
    .find(Boolean) || '';
}

function chineseFeatureName(tags) {
  const candidates = [
    tags['name:zh'],
    tags['name:zh-Hans'],
    tags['name:zh-Hans-CN'],
    tags['name:zh-Hant'],
    tags['name:zh-Hant-TW'],
    tags.name,
  ];
  return candidates.map((value) => clean(value)).find((value) => value && isChinese(value)) || '';
}

function categoryKey(tags, theme) {
  const amenity = clean(tags.amenity).toLowerCase();
  const building = clean(tags.building).toLowerCase();
  const highway = clean(tags.highway).toLowerCase();
  const place = clean(tags.place).toLowerCase();
  const leisure = clean(tags.leisure).toLowerCase();
  const natural = clean(tags.natural).toLowerCase();
  const waterway = clean(tags.waterway).toLowerCase();

  if (amenity === 'hospital') return 'hospital';
  if (amenity === 'clinic' || amenity === 'doctors') return 'clinic';
  if (amenity === 'kindergarten') return 'kindergarten';
  if (amenity === 'college') return 'college';
  if (amenity === 'university') return 'university';
  if (amenity === 'school') return 'school';
  if (amenity === 'police') return 'police';
  if (amenity === 'library') return 'library';
  if (amenity === 'bus_station') return 'busStation';
  if (clean(tags.public_transport).toLowerCase() === 'platform') return 'platform';
  if (['ferry_terminal', 'taxi', 'bicycle_rental'].includes(amenity)
    || ['station', 'halt', 'tram_stop', 'subway_entrance'].includes(clean(tags.railway).toLowerCase())) return 'station';
  if (amenity) return 'facility';

  if (highway === 'bus_stop') return 'busStation';
  if (['motorway', 'trunk', 'primary', 'secondary'].includes(highway)) return 'arterial';
  if (['footway', 'path', 'steps', 'pedestrian', 'cycleway', 'bridleway'].includes(highway)) return 'footway';
  if (['tertiary', 'residential', 'unclassified', 'service', 'living_street', 'track'].includes(highway)) return 'localRoad';
  if (highway) return 'road';

  if (['city'].includes(place)) return 'city';
  if (['town', 'village', 'hamlet'].includes(place)) return 'town';
  if (['suburb', 'neighbourhood', 'quarter', 'locality'].includes(place)) return 'community';

  if (waterway || ['water', 'bay', 'coastline', 'wetland'].includes(natural) || clean(tags.water)) return 'water';
  if (['park', 'garden', 'nature_reserve', 'playground', 'golf_course'].includes(leisure)
    || ['wood', 'grassland', 'scrub', 'heath'].includes(natural)
    || ['recreation_ground', 'forest', 'grass', 'meadow', 'village_green'].includes(clean(tags.landuse).toLowerCase())) return 'green';

  if (building) {
    if (building === 'kindergarten') return 'kindergarten';
    if (building === 'college') return 'college';
    if (building === 'university') return 'university';
    if (building === 'school') return 'school';
    if (building === 'hospital') return 'hospital';
    if (building === 'clinic') return 'clinic';
    if (['house', 'detached', 'semidetached_house', 'terrace', 'residential'].includes(building)) return 'residence';
    if (['apartments', 'apartment'].includes(building)) return 'apartment';
    if (['commercial', 'retail', 'office'].includes(building)) return 'commercial';
    if (['industrial', 'warehouse', 'manufacture'].includes(building)) return 'industrial';
    return 'building';
  }

  return theme === 'addresses' ? 'address'
    : theme === 'water' ? 'water'
      : theme === 'green' ? 'green'
    : theme === 'roads' ? 'road'
      : theme === 'settlements' ? 'community'
        : theme === 'buildings' ? 'building' : 'facility';
}

function addressTitle(tags, chinese) {
  const house = clean(tags['addr:housenumber'], 60);
  if (!house) return '';
  if (chinese) return `门牌 ${/号$/.test(house) ? house : `${house}号`}`;
  return `Address ${house}`;
}

/**
 * Resolve display text from OpenStreetMap tags without translating external names.
 * Output strings are plain text for assignment through textContent.
 */
export function resolveOsmFeatureText(properties, { locale = 'zh-CN', theme = '' } = {}) {
  const tags = sourceTags(properties);
  const chinese = isChineseLocale(locale);
  const rawName = rawFeatureName(tags);
  const chineseName = chinese ? chineseFeatureName(tags) : '';
  const key = categoryKey(tags, theme);
  const category = CATEGORY[chinese ? 'zh' : 'en'][key];
  const address = theme === 'addresses' ? addressTitle(tags, chinese) : '';
  // A live external name is supporting context unless it is already Chinese.
  // This avoids presenting an invented translation while keeping the map label
  // useful to Chinese and English users through the controlled category text.
  const title = chinese ? (chineseName || address || category) : (address || rawName || category);
  const details = [];

  if (chineseName && category && category !== chineseName) details.push(category);
  if (!chinese && rawName && title === rawName && category !== rawName) details.push(category);
  if (rawName && rawName !== title && !details.includes(rawName)) details.push(rawName);
  const street = clean(tags['addr:street'] || tags['addr:place']);
  if (address && street && !details.includes(street)) details.push(street);

  return Object.freeze({
    title: clean(title),
    details: Object.freeze(details.slice(0, 2)),
    rawName: clean(rawName),
    hasChineseName: Boolean(chineseName),
    category,
  });
}

export default resolveOsmFeatureText;
