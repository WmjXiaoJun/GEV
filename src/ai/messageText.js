const VISION_CLASS_TRANSLATIONS = Object.freeze([
  ['ground_track_field', '田径场'], ['ground track field', '田径场'],
  ['soccer_ball_field', '足球场'], ['soccer ball field', '足球场'],
  ['baseball_diamond', '棒球场'], ['baseball diamond', '棒球场'],
  ['tennis_court', '网球场'], ['tennis court', '网球场'],
  ['basketball_court', '篮球场'], ['basketball court', '篮球场'],
  ['small_vehicle', '小型车辆'], ['small vehicle', '小型车辆'],
  ['large_vehicle', '大型车辆'], ['large vehicle', '大型车辆'],
  ['storage_tank', '储罐'], ['storage tank', '储罐'],
  ['roundabout', '环形交叉口'], ['harbor', '港口'], ['bridge', '桥梁'],
  ['swimming_pool', '游泳池'], ['swimming pool', '游泳池'],
  ['helicopter', '直升机'], ['airplane', '飞机'], ['plane', '飞机'], ['ship', '船舶'],
]);

/** Keep generated replies readable as text, including incomplete streaming markers. */
export function formatAssistantText(text, locale = 'en') {
  let output = String(text ?? '')
    .replace(/^([\t ]*)\*([\t ]+)/gm, '$1-$2')
    .replace(/\\?\*/g, '');
  if (locale === 'zh-CN') {
    for (const [source, target] of VISION_CLASS_TRANSLATIONS) {
      const pattern = source.replaceAll('_', '[ _]');
      output = output.replace(new RegExp(`(?<![A-Za-z_])${pattern}(?![A-Za-z_])`, 'gi'), target);
    }
  }
  return output;
}

export { VISION_CLASS_TRANSLATIONS };
