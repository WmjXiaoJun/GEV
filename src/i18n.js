import {
  DEFAULT_LOCALE,
  MESSAGE_CATALOG,
  SUPPORTED_LOCALES,
} from './locale/index.js';

/** Durable preference key. Bump only when the stored value's shape changes. */
export const LOCALE_STORAGE_KEY = 'gev:locale:v1';

/** Browser event emitted after an i18n instance changes locale. */
export const LOCALE_CHANGE_EVENT = 'gev:localechange';

const HAS_OWN = Object.prototype.hasOwnProperty;

/** Common aliases accepted by the language picker and URL/query integrations. */
const LOCALE_ALIASES = Object.freeze({
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  english: 'en',
  英文: 'en',
  zh: 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hans': 'zh-CN',
  chinese: 'zh-CN',
  中文: 'zh-CN',
});

/** Resolve browser storage lazily; privacy-restricted browsers may throw. */
function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof globalThis === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Resolve a browser event target lazily without requiring a DOM in Node tests. */
function resolveEventTarget(target) {
  if (target !== undefined) return target;
  try {
    return typeof window === 'undefined' ? null : window;
  } catch {
    return null;
  }
}

/** Return a canonical locale or null when the input is not recognized. */
function canonicalLocale(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.replaceAll('_', '-').toLowerCase();
  if (HAS_OWN.call(LOCALE_ALIASES, normalized)) return LOCALE_ALIASES[normalized];
  if (normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized.startsWith('en-')) return 'en';
  return null;
}

/**
 * Normalize a locale to one of the two supported identifiers.
 *
 * `fallback` is normalized as well, so callers can safely pass a browser
 * locale or a user-entered alias as the fallback without creating invalid
 * state.
 */
export function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  const canonical = canonicalLocale(value);
  if (canonical && SUPPORTED_LOCALES.includes(canonical)) return canonical;
  const safeFallback = canonicalLocale(fallback);
  return safeFallback && SUPPORTED_LOCALES.includes(safeFallback)
    ? safeFallback
    : DEFAULT_LOCALE;
}

/** Best-effort browser-language detection for hosts that opt into it. */
export function detectLocale(navigatorLike = undefined) {
  let candidate = navigatorLike;
  if (candidate === undefined) {
    try {
      candidate = typeof navigator === 'undefined' ? null : navigator;
    } catch {
      candidate = null;
    }
  }
  const languages = Array.isArray(candidate?.languages) && candidate.languages.length
    ? candidate.languages
    : [candidate?.language];
  return languages.some((language) => String(language || '').toLowerCase().startsWith('zh'))
    ? 'zh-CN'
    : DEFAULT_LOCALE;
}

/** Read the persisted locale without allowing storage failures to escape. */
export function readLocale(storage = undefined, fallback = DEFAULT_LOCALE) {
  try {
    const value = resolveStorage(storage)?.getItem?.(LOCALE_STORAGE_KEY);
    return normalizeLocale(value, fallback);
  } catch {
    return normalizeLocale(null, fallback);
  }
}

/** Persist one locale best-effort; returns whether the write succeeded. */
export function writeLocale(locale, storage = undefined) {
  const normalized = normalizeLocale(locale);
  try {
    const target = resolveStorage(storage);
    if (typeof target?.setItem !== 'function') return false;
    target.setItem(LOCALE_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Interpolate `{name}` placeholders in a translated message.
 *
 * Values are converted to strings and missing values are left untouched. The
 * result is intended for `textContent`/attributes, never `innerHTML`.
 */
export function formatMessage(template, values = {}) {
  const source = String(template ?? '');
  if (!values || typeof values !== 'object') return source;
  return source.replace(/\{([\w.-]+)\}/g, (token, key) => (
    HAS_OWN.call(values, key) && values[key] !== undefined && values[key] !== null
      ? String(values[key])
      : token
  ));
}

/** Look up a direct or dot-separated key in a locale dictionary. */
function lookupMessage(messages, key) {
  if (!messages || typeof messages !== 'object') return undefined;
  const path = String(key ?? '').trim();
  if (!path) return undefined;
  if (HAS_OWN.call(messages, path)) return messages[path];
  return path.split('.').reduce((value, segment) => {
    if (value === undefined || value === null || typeof value !== 'object') return undefined;
    return value[segment];
  }, messages);
}

/** Read a `data-*` value from both real DOM nodes and small test doubles. */
function readDataValue(element, name) {
  if (!element) return null;
  const datasetName = String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  try {
    const datasetValue = element.dataset?.[datasetName];
    if (datasetValue !== undefined && datasetValue !== null) return datasetValue;
  } catch {
    // Ignore hostile/proxy-backed dataset objects and try getAttribute below.
  }
  try {
    return element.getAttribute?.(`data-${name}`) ?? null;
  } catch {
    return null;
  }
}

/** Set an attribute on a real element or a minimal DOM test double. */
function writeAttribute(element, name, value) {
  try {
    const next = String(value);
    const current = readAttributeValue(element, name);
    if (current !== null && current !== undefined && String(current) === next) return;
    if (typeof element?.setAttribute === 'function') element.setAttribute(name, next);
    else if (element) element[name] = next;
  } catch {
    // Translation must never make an otherwise usable UI fail to initialize.
  }
}

function readAttributeValue(element, name) {
  try {
    if (typeof element?.getAttribute === 'function') return element.getAttribute(name);
    return element?.[name] ?? null;
  } catch {
    return null;
  }
}

/** Parse optional `data-i18n-params='{"count":3}'` values. */
function readMessageParams(element) {
  const raw = readDataValue(element, 'i18n-params');
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Create an isolated locale manager.
 *
 * Instances are useful for tests, embedded views, and future multi-window
 * hosts. The module-level singleton exported below covers the normal app.
 */
export function createI18n({
  storage = undefined,
  initialLocale = undefined,
  locale = undefined,
  translations = MESSAGE_CATALOG,
  eventTarget = undefined,
  navigatorLike = undefined,
  eventName = LOCALE_CHANGE_EVENT,
  storageKey = LOCALE_STORAGE_KEY,
} = {}) {
  const catalog = translations && typeof translations === 'object'
    ? translations
    : MESSAGE_CATALOG;
  const storageRef = storage;
  const targetRef = eventTarget;
  const getStorage = () => resolveStorage(storageRef);
  const getEventTarget = () => resolveEventTarget(targetRef);
  const initial = initialLocale ?? locale;
  const detectedLocale = detectLocale(navigatorLike);
  let currentLocale = normalizeLocale(
    initial === undefined ? readLocale(getStorage(), detectedLocale) : initial,
  );
  const subscribers = new Set();
  let boundRoot = null;
  let storageListener = null;

  const messagesFor = (requestedLocale = currentLocale) => {
    const selected = normalizeLocale(requestedLocale, currentLocale);
    return catalog[selected] || catalog[DEFAULT_LOCALE] || {};
  };

  const t = (key, values = {}, requestedLocale = currentLocale) => {
    const selected = normalizeLocale(requestedLocale, currentLocale);
    const translated = lookupMessage(messagesFor(selected), key);
    const fallback = lookupMessage(messagesFor(DEFAULT_LOCALE), key);
    const message = translated === undefined ? fallback : translated;
    return formatMessage(message === undefined ? key : message, values);
  };

  const normalizeComparable = (value) => String(value ?? '')
    .replaceAll('...', '…')
    .replace(/\s+/g, ' ')
    .trim();

  const matchesBoundMessage = (value, key, params) => {
    if (value === undefined || value === null || String(value).trim() === '') return true;
    const current = normalizeComparable(value);
    return Object.values(catalog).some((messages) => {
      const candidate = lookupMessage(messages, key);
      return typeof candidate === 'string'
        && normalizeComparable(formatMessage(candidate, params)) === current;
    });
  };

  const translateElement = (element, requestedLocale = currentLocale) => {
    if (!element) return element;
    const selected = normalizeLocale(requestedLocale, currentLocale);
    const params = readMessageParams(element);
    const textKey = readDataValue(element, 'i18n');
    if (textKey && matchesBoundMessage(element.textContent, textKey, params)) {
      const translatedText = t(textKey, params, selected);
      if (element.textContent !== translatedText) element.textContent = translatedText;
    }

    const attributeKeys = [
      ['placeholder', 'i18n-placeholder'],
      ['title', 'i18n-title'],
      ['aria-label', 'i18n-aria-label'],
      ['aria-description', 'i18n-aria-description'],
      ['aria-valuetext', 'i18n-aria-valuetext'],
      ['alt', 'i18n-alt'],
      ['value', 'i18n-value'],
    ];
    for (const [attribute, dataName] of attributeKeys) {
      const key = readDataValue(element, dataName);
      if (key && matchesBoundMessage(readAttributeValue(element, attribute), key, params)) {
        writeAttribute(element, attribute, t(key, params, selected));
      }
    }

    // Generic form: data-i18n-attrs="title:nav.reset,aria-label:nav.reset".
    const generic = readDataValue(element, 'i18n-attrs') || readDataValue(element, 'i18n-attr');
    if (generic) {
      String(generic)
        .split(/[;,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const separator = entry.indexOf(':');
          if (separator <= 0) return;
          const attribute = entry.slice(0, separator).trim();
          const key = entry.slice(separator + 1).trim();
          if (
            attribute
            && key
            && matchesBoundMessage(readAttributeValue(element, attribute), key, params)
          ) {
            writeAttribute(element, attribute, t(key, params, selected));
          }
        });
    }
    return element;
  };

  const translateDocument = (root = undefined, requestedLocale = currentLocale) => {
    let targetRoot = root;
    if (targetRoot === undefined || targetRoot === null) {
      try {
        targetRoot = typeof document === 'undefined' ? null : document;
      } catch {
        targetRoot = null;
      }
    }
    if (!targetRoot) return targetRoot;
    const selected = normalizeLocale(requestedLocale, currentLocale);
    const html = targetRoot.documentElement;
    if (html) {
      try {
        const current = readAttributeValue(html, 'lang');
        if (current !== selected) {
          if (typeof html.setAttribute === 'function') html.setAttribute('lang', selected);
          else html.lang = selected;
        }
      } catch {
        // Ignore a read-only documentElement in a host shell.
      }
    }

    const seen = new Set();
    const elements = [];
    const add = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      elements.push(element);
    };
    // A root element can itself carry data-i18n.
    if (readDataValue(targetRoot, 'i18n') || readDataValue(targetRoot, 'i18n-placeholder')) add(targetRoot);
    try {
      const matches = targetRoot.querySelectorAll?.(
        '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label],'
        + '[data-i18n-aria-description],[data-i18n-aria-valuetext],'
        + '[data-i18n-alt],[data-i18n-value],[data-i18n-attrs],[data-i18n-attr]',
      );
      if (matches) for (const element of matches) add(element);
    } catch {
      // A non-DOM root is still allowed to update its own lang/text fields.
    }
    for (const element of elements) translateElement(element, selected);
    return targetRoot;
  };

  const dispatch = (detail) => {
    const target = getEventTarget();
    if (!target || typeof target.dispatchEvent !== 'function') return;
    let event = null;
    try {
      const EventCtor = target.CustomEvent
        || (typeof globalThis === 'undefined' ? undefined : globalThis.CustomEvent);
      if (typeof EventCtor === 'function') event = new EventCtor(eventName, { detail });
    } catch {
      event = null;
    }
    if (!event) event = { type: eventName, detail };
    try {
      target.dispatchEvent(event);
    } catch {
      // Some host shells expose a partial EventTarget; subscribers still run.
    }
  };

  const setLocale = (nextLocale, {
    persist = true,
    notify = true,
    dispatch: shouldDispatch = true,
    root = boundRoot,
  } = {}) => {
    const next = normalizeLocale(nextLocale, currentLocale);
    const previous = currentLocale;
    if (persist) {
      // Use the instance's configured key, while the standalone helper keeps
      // the public default key for callers that do not need a custom namespace.
      try {
        const target = getStorage();
        if (typeof target?.setItem === 'function') target.setItem(storageKey, next);
      } catch {
        // A blocked preference should never prevent the visual switch.
      }
    }
    currentLocale = next;
    if (root) translateDocument(root, next);
    if (next === previous) return next;

    const detail = Object.freeze({ locale: next, previousLocale: previous });
    if (notify) {
      for (const listener of [...subscribers]) {
        try {
          listener(detail);
        } catch {
          // One extension/plugin listener must not break the rest of the UI.
        }
      }
    }
    if (shouldDispatch) dispatch(detail);
    return next;
  };

  const subscribe = (listener, { immediate = false } = {}) => {
    if (typeof listener !== 'function') return () => {};
    subscribers.add(listener);
    if (immediate) {
      try {
        listener(Object.freeze({ locale: currentLocale, previousLocale: null }));
      } catch {
        // Ignore listener failures during registration.
      }
    }
    return () => subscribers.delete(listener);
  };

  const bindStorage = () => {
    const target = getEventTarget();
    if (storageListener || typeof target?.addEventListener !== 'function') return;
    storageListener = (event) => {
      if (!event || event.key !== storageKey) return;
      const next = normalizeLocale(event.newValue, currentLocale);
      if (next === currentLocale) return;
      setLocale(next, {
        persist: false,
        root: boundRoot,
      });
    };
    try {
      target.addEventListener('storage', storageListener);
    } catch {
      storageListener = null;
    }
  };

  const init = (rootOrOptions = undefined) => {
    let root = rootOrOptions;
    let options = {};
    if (
      rootOrOptions
      && typeof rootOrOptions === 'object'
      && ('root' in rootOrOptions || 'locale' in rootOrOptions || 'persist' in rootOrOptions)
    ) {
      options = rootOrOptions;
      root = options.root;
    }
    boundRoot = root ?? boundRoot;
    bindStorage();
    if (options.locale !== undefined) {
      setLocale(options.locale, {
        persist: options.persist !== false,
        root: boundRoot,
      });
    } else {
      translateDocument(boundRoot, currentLocale);
    }
    return currentLocale;
  };

  const destroy = () => {
    if (!storageListener) return;
    const target = getEventTarget();
    try {
      target?.removeEventListener?.('storage', storageListener);
    } catch {
      // Ignore host teardown errors.
    }
    storageListener = null;
  };

  return Object.freeze({
    getLocale: () => currentLocale,
    setLocale,
    subscribe,
    t,
    messagesFor,
    translateElement,
    translateDocument,
    init,
    destroy,
    storageKey,
    eventName,
  });
}

/** App-wide manager used by the browser UI. */
export const defaultI18n = createI18n();
export const i18n = defaultI18n;

/** Convenience singleton wrappers for incremental adoption by existing code. */
export const getLocale = (...args) => defaultI18n.getLocale(...args);
export const setLocale = (...args) => defaultI18n.setLocale(...args);
export const subscribeLocale = (...args) => defaultI18n.subscribe(...args);
export const t = (...args) => defaultI18n.t(...args);
export const translateElement = (...args) => defaultI18n.translateElement(...args);
export const translateDocument = (...args) => defaultI18n.translateDocument(...args);
export const initI18n = (...args) => defaultI18n.init(...args);
export const destroyI18n = (...args) => defaultI18n.destroy(...args);

export { DEFAULT_LOCALE, MESSAGE_CATALOG, SUPPORTED_LOCALES };
export default defaultI18n;
