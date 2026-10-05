import EN_MESSAGES from './en.js';
import RUNTIME_EN_MESSAGES from './runtime.en.js';
import RUNTIME_ZH_CN_MESSAGES from './runtime.zh-CN.js';
import ZH_CN_MESSAGES from './zh-CN.js';
import AI_EN_MESSAGES from './ai.en.js';
import AI_ZH_CN_MESSAGES from './ai.zh-CN.js';
import INTELLIGENCE_EN_MESSAGES from './intelligence.en.js';
import INTELLIGENCE_ZH_CN_MESSAGES from './intelligence.zh-CN.js';
import VISION_EN_MESSAGES from './vision.en.js';
import VISION_ZH_CN_MESSAGES from './vision.zh-CN.js';

/** Supported UI locale identifiers, in display order. */
export const SUPPORTED_LOCALES = Object.freeze(['en', 'zh-CN']);

/** The locale used when no valid preference has been saved. */
export const DEFAULT_LOCALE = 'en';

/** Immutable message catalogue consumed by `src/i18n.js`. */
export const MESSAGE_CATALOG = Object.freeze({
  en: Object.freeze({
    ...EN_MESSAGES,
    ...RUNTIME_EN_MESSAGES,
    ...AI_EN_MESSAGES,
    ...INTELLIGENCE_EN_MESSAGES,
    ...VISION_EN_MESSAGES,
  }),
  'zh-CN': Object.freeze({
    ...ZH_CN_MESSAGES,
    ...RUNTIME_ZH_CN_MESSAGES,
    ...AI_ZH_CN_MESSAGES,
    ...INTELLIGENCE_ZH_CN_MESSAGES,
    ...VISION_ZH_CN_MESSAGES,
  }),
});

export { EN_MESSAGES, ZH_CN_MESSAGES };
export default MESSAGE_CATALOG;
