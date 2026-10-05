import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const scriptRoot = new URL('../scripts/', import.meta.url);
const browserPathScripts = readdirSync(scriptRoot)
  .filter((name) => /^qa-.*\.mjs$/.test(name))
  .map((name) => ({ name, source: readFileSync(new URL(name, scriptRoot), 'utf8') }))
  .filter(({ source }) => source.includes('puppeteer.executablePath()'));

// Execute each harness's actual path expression without starting its browser
// scenario. Wrapping the result in an object preserves unresolved promises so
// an async function's return-value assimilation cannot hide the regression.
function resolveCandidate(source, executablePath) {
  const line = source.split('\n').find((entry) => entry.includes('puppeteer.executablePath()'));
  const fallback = line.match(/(?:await\s+)?\((?:async\s+)?\(\)\s*=>[^\r\n]+?\}\)\(\)/);
  const direct = line.match(/(?:await\s+)?puppeteer\.executablePath\(\)/);
  const expression = fallback?.[0] || direct?.[0];
  assert.ok(expression, 'browser discovery expression is available');
  return vm.runInNewContext(`(async () => {
    const candidate = ${expression};
    return { candidate };
  })()`, { puppeteer: { executablePath } });
}

test('browser-path coverage discovers QA harnesses', () => {
  assert.ok(browserPathScripts.length > 0);
});

for (const { name, source } of browserPathScripts) {
  test(`${name} resolves Puppeteer browser paths before use`, async () => {
    const result = await resolveCandidate(source, () => Promise.resolve('C:/browser/chrome.exe'));
    assert.equal(result.candidate, 'C:/browser/chrome.exe');
  });

  test(`${name} handles failed asynchronous browser discovery`, async () => {
    const rejection = Promise.reject(new Error('Browser cache unavailable'));
    rejection.catch(() => {});
    const result = resolveCandidate(source, () => rejection);
    if (name === 'qa-voice-wav.mjs') {
      await assert.rejects(result, /Browser cache unavailable/);
    } else {
      const { candidate } = await result;
      assert.ok(candidate === null || candidate === undefined);
    }
  });
}
