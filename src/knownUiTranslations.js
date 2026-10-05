import { DEFAULT_LOCALE, formatMessage, normalizeLocale } from './i18n.js';

const PLACEHOLDER_PATTERN = /\{([\w.-]+)\}/g;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitWhitespace(value) {
  const match = String(value ?? '').match(/^(\s*)([\s\S]*?)(\s*)$/);
  return {
    leading: match?.[1] || '',
    core: match?.[2] || '',
    trailing: match?.[3] || '',
  };
}

function compileTemplate(key, template) {
  const names = [];
  let cursor = 0;
  let pattern = '^';
  let match = null;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  while ((match = PLACEHOLDER_PATTERN.exec(template))) {
    pattern += escapeRegex(template.slice(cursor, match.index));
    pattern += '([\\s\\S]+?)';
    names.push(match[1]);
    cursor = match.index + match[0].length;
  }
  pattern += `${escapeRegex(template.slice(cursor))}$`;
  return {
    key,
    names,
    regex: new RegExp(pattern),
    specificity: template.replace(PLACEHOLDER_PATTERN, '').length,
  };
}

/**
 * Build a reverse index for every supported locale.
 *
 * Indexing all locales lets a newly created Chinese runtime message switch
 * back to English even when the DOM node did not exist during the first pass.
 */
export function createKnownMessageIndex(catalog = {}) {
  const exact = new Map();
  const templates = [];
  for (const messages of Object.values(catalog || {})) {
    if (!messages || typeof messages !== 'object') continue;
    for (const [key, rawTemplate] of Object.entries(messages)) {
      if (typeof rawTemplate !== 'string') continue;
      const template = rawTemplate.trim();
      if (!template) continue;
      if (template.match(PLACEHOLDER_PATTERN)) {
        templates.push(compileTemplate(key, template));
      } else if (!exact.has(template)) {
        exact.set(template, Object.freeze({ key, values: Object.freeze({}) }));
      }
    }
  }
  templates.sort((left, right) => right.specificity - left.specificity);
  return Object.freeze({ exact, templates: Object.freeze(templates) });
}

function resolveBinding(core, index) {
  const exact = index?.exact?.get?.(core);
  if (exact) return exact;
  for (const template of index?.templates || []) {
    const match = template.regex.exec(core);
    if (!match) continue;
    const values = {};
    template.names.forEach((name, indexPosition) => {
      values[name] = match[indexPosition + 1];
    });
    return Object.freeze({ key: template.key, values: Object.freeze(values) });
  }
  return null;
}

function bindingStillMatches(core, binding, catalog) {
  if (!binding?.key) return false;
  return Object.values(catalog || {}).some((messages) => {
    const template = messages?.[binding.key];
    return typeof template === 'string'
      && formatMessage(template, binding.values || {}) === core;
  });
}

/**
 * Translate only strings already present in the curated UI catalogue.
 * Unknown values are returned byte-for-byte so callsigns, locations, station
 * names, and external news copy cannot be mistaken for application chrome.
 */
export function localizeKnownUiValue(value, {
  allowSegments = true,
  binding = null,
  catalog = {},
  index = createKnownMessageIndex(catalog),
  locale = DEFAULT_LOCALE,
} = {}) {
  const original = String(value ?? '');
  const { leading, core, trailing } = splitWhitespace(original);
  const resolved = resolveBinding(core, index)
    || (bindingStillMatches(core, binding, catalog) ? binding : null);
  if (!resolved) {
    if (allowSegments && core.includes('·')) {
      const parts = core.split(/(\s*·\s*)/);
      let translated = false;
      const localizedParts = parts.map((part, partIndex) => {
        if (partIndex % 2 === 1 || !part) return part;
        const result = localizeKnownUiValue(part, {
          allowSegments: false,
          catalog,
          index,
          locale,
        });
        translated ||= result.translated;
        return result.value;
      });
      if (translated) {
        return Object.freeze({
          value: `${leading}${localizedParts.join('')}${trailing}`,
          binding: null,
          translated: true,
        });
      }
    }
    return Object.freeze({ value: original, binding: null, translated: false });
  }

  const selected = normalizeLocale(locale);
  const targetMessages = catalog?.[selected] || catalog?.[DEFAULT_LOCALE] || {};
  const fallbackMessages = catalog?.[DEFAULT_LOCALE] || {};
  const template = targetMessages[resolved.key] ?? fallbackMessages[resolved.key];
  if (typeof template !== 'string') {
    return Object.freeze({ value: original, binding: null, translated: false });
  }
  const localizedValues = Object.fromEntries(
    Object.entries(resolved.values || {}).map(([name, captured]) => [
      name,
      localizeKnownUiValue(captured, {
        catalog,
        index,
        locale: selected,
      }).value,
    ]),
  );
  const localizedCore = formatMessage(template, localizedValues);
  const localizedValue = `${leading}${localizedCore}${trailing}`;
  return Object.freeze({
    value: localizedValue,
    binding: resolved,
    translated: localizedValue !== original,
  });
}

export default localizeKnownUiValue;
