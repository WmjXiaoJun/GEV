import {
  defaultI18n,
  MESSAGE_CATALOG,
  normalizeLocale,
} from './i18n.js';
import {
  createKnownMessageIndex,
  localizeKnownUiValue,
} from './knownUiTranslations.js';

const CLEANUP_BY_TOGGLE = new WeakMap();
const LOCALIZABLE_ATTRIBUTES = Object.freeze([
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'placeholder',
  'title',
]);

function readAttribute(element, name) {
  try {
    return element?.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function textNodeIsIgnored(node) {
  const parent = node?.parentElement;
  if (!parent) return false;
  try {
    return !!parent.closest?.(
      '[data-i18n-ignore],script,style,noscript,textarea,[contenteditable="true"]',
    );
  } catch {
    return false;
  }
}

/**
 * Translate runtime-created UI strings only when they match the curated
 * catalogue. Per-node bindings keep the operation reversible across locale
 * switches while unknown values (callsigns, place names, news) pass through.
 */
export function createKnownDomLocalizer({
  manager = defaultI18n,
  catalog = MESSAGE_CATALOG,
} = {}) {
  const index = createKnownMessageIndex(catalog);
  const textBindings = new WeakMap();
  const attributeBindings = new WeakMap();

  const translateTextNode = (node) => {
    if (node?.nodeType !== 3 || textNodeIsIgnored(node)) return;
    const result = localizeKnownUiValue(node.nodeValue, {
      binding: textBindings.get(node) || null,
      catalog,
      index,
      locale: manager?.getLocale?.(),
    });
    if (result.binding) textBindings.set(node, result.binding);
    else textBindings.delete(node);
    if (result.translated) node.nodeValue = result.value;
  };

  const translateAttributes = (element) => {
    if (element?.nodeType !== 1) return;
    let bindings = attributeBindings.get(element);
    if (!bindings) bindings = new Map();
    for (const name of LOCALIZABLE_ATTRIBUTES) {
      const current = readAttribute(element, name);
      if (current === null) continue;
      const result = localizeKnownUiValue(current, {
        binding: bindings.get(name) || null,
        catalog,
        index,
        locale: manager?.getLocale?.(),
      });
      if (result.binding) bindings.set(name, result.binding);
      else bindings.delete(name);
      if (result.translated) setAttribute(element, name, result.value);
    }
    if (bindings.size) attributeBindings.set(element, bindings);
    else attributeBindings.delete(element);
  };

  const translateTree = (root) => {
    if (!root) return root;
    if (root.nodeType === 3) {
      translateTextNode(root);
      return root;
    }
    if (root.nodeType === 1) translateAttributes(root);
    let children = [];
    try {
      children = Array.from(root.childNodes || []);
    } catch {
      children = [];
    }
    if (!children.length && root.nodeType === 9 && root.documentElement) {
      children = [root.documentElement];
    }
    for (const child of children) translateTree(child);
    return root;
  };

  return Object.freeze({ translateAttributes, translateTextNode, translateTree });
}

function resolveRoot(root) {
  if (root !== undefined && root !== null) return root;
  try {
    return typeof document === 'undefined' ? null : document;
  } catch {
    return null;
  }
}

function resolveToggle(root) {
  try {
    return root?.getElementById?.('language-toggle')
      || root?.querySelector?.('[data-locale-toggle]')
      || null;
  } catch {
    return null;
  }
}

function resolveLabel(toggle) {
  try {
    return toggle?.querySelector?.('.language-toggle-label') || toggle;
  } catch {
    return toggle;
  }
}

function setAttribute(element, name, value) {
  try {
    if (typeof element?.setAttribute === 'function') element.setAttribute(name, value);
    else if (element) element[name] = value;
  } catch {
    // A host shell can expose read-only attributes; the visible label still updates.
  }
}

/**
 * Attach the app's language picker and static-DOM translation pass.
 *
 * The function is deliberately independent from `StyleManager`: it can be
 * called at the very start of bootstrap, before Cesium or any data layer has
 * loaded. Existing modules can subscribe to `gev:localechange` (or to the
 * manager directly) and refresh dynamic strings when they are ready.
 */
export function initLocaleUi({ root = undefined, manager = defaultI18n, observe = true } = {}) {
  const targetRoot = resolveRoot(root);
  if (!targetRoot || !manager) return { manager, destroy: () => {} };

  const toggle = resolveToggle(targetRoot);
  const previousCleanup = toggle ? CLEANUP_BY_TOGGLE.get(toggle) : null;
  previousCleanup?.();

  let destroyed = false;
  let observer = null;
  let removeStorageSubscription = null;
  const knownDom = createKnownDomLocalizer({ manager });

  const render = () => {
    if (destroyed) return;
    const locale = normalizeLocale(manager.getLocale?.() || 'en');
    const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    const nextLanguageKey = nextLocale === 'zh-CN' ? 'language.chinese' : 'language.english';
    const nextSwitchKey = nextLocale === 'zh-CN'
      ? 'language.switchToChinese'
      : 'language.switchToEnglish';
    if (toggle) {
      const label = resolveLabel(toggle);
      if (label) setAttribute(label, 'data-i18n', nextLanguageKey);
      setAttribute(toggle, 'data-i18n-aria-label', nextSwitchKey);
      setAttribute(toggle, 'data-i18n-title', nextSwitchKey);
      setAttribute(toggle, 'data-locale', nextLocale);
    }
    manager.translateDocument?.(targetRoot, locale);
    knownDom.translateTree(targetRoot);
    if (!toggle) return;
    const label = resolveLabel(toggle);
    if (label) label.textContent = manager.t?.(nextLanguageKey, {}, locale)
      || (nextLocale === 'zh-CN' ? '中文' : 'English');
    setAttribute(
      toggle,
      'aria-label',
      manager.t?.(nextSwitchKey, {}, locale)
        || (nextLocale === 'zh-CN' ? 'Switch to Chinese' : 'Switch to English'),
    );
    setAttribute(toggle, 'title', manager.t?.(nextSwitchKey, {}, locale)
      || (nextLocale === 'zh-CN' ? 'Switch to Chinese' : 'Switch to English'));
  };

  const onLocaleChange = () => render();
  removeStorageSubscription = manager.subscribe?.(onLocaleChange) || null;
  manager.init?.(targetRoot);
  render();

  const onToggle = () => {
    const locale = normalizeLocale(manager.getLocale?.() || 'en');
    manager.setLocale?.(locale === 'zh-CN' ? 'en' : 'zh-CN', { root: targetRoot });
  };
  if (toggle) {
    try {
      toggle.addEventListener?.('click', onToggle);
    } catch {
      // A non-DOM host can still use the manager API directly.
    }
  }

  if (observe) {
    let MutationObserverCtor = null;
    try {
      MutationObserverCtor = targetRoot.defaultView?.MutationObserver
        || (typeof MutationObserver === 'undefined' ? null : MutationObserver);
    } catch {
      MutationObserverCtor = null;
    }
    const observationTarget = targetRoot.body || targetRoot.documentElement || targetRoot;
    if (typeof MutationObserverCtor === 'function' && observationTarget) {
      try {
        observer = new MutationObserverCtor((records) => {
          if (destroyed) return;
          for (const record of records || []) {
            if (record.type === 'attributes') {
              manager.translateElement?.(record.target, manager.getLocale?.());
              knownDom.translateAttributes(record.target);
              continue;
            }
            if (record.target?.nodeType === 1) {
              manager.translateElement?.(record.target, manager.getLocale?.());
            }
            for (const node of record.addedNodes || []) {
              if (node?.nodeType === 1) manager.translateDocument?.(node, manager.getLocale?.());
              knownDom.translateTree(node);
            }
          }
        });
        observer.observe(observationTarget, {
          attributeFilter: LOCALIZABLE_ATTRIBUTES,
          attributes: true,
          childList: true,
          subtree: true,
        });
      } catch {
        observer = null;
      }
    }
  }

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      toggle?.removeEventListener?.('click', onToggle);
    } catch {
      // Ignore host teardown errors.
    }
    try {
      observer?.disconnect?.();
    } catch {
      // Ignore host teardown errors.
    }
    try {
      if (typeof removeStorageSubscription === 'function') removeStorageSubscription();
    } catch {
      // Ignore listener teardown errors.
    }
    if (toggle && CLEANUP_BY_TOGGLE.get(toggle) === destroy) CLEANUP_BY_TOGGLE.delete(toggle);
  };

  if (toggle) CLEANUP_BY_TOGGLE.set(toggle, destroy);
  return Object.freeze({ manager, toggle, destroy });
}

export default initLocaleUi;
