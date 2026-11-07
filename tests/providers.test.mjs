import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_REGISTRY, PROVIDERS, providerForUrl, loadBackend } from '../scripts/providers.mjs';

test('registered providers load adapters implementing the shared CLI contract without starting a session', async () => {
  for (const id of PROVIDERS) {
    const adapter = await loadBackend(id, '/unused');
    assert.equal(adapter.provider, id);
    for (const method of ['init', 'login', 'status', 'projects', 'files', 'read', 'write', 'compile', 'close']) {
      assert.equal(typeof adapter[method], 'function', `${id}.${method} must be implemented`);
    }
  }
});

test('project URLs route only to registered exact hosts', () => {
  const cases = [
    ['https://www.overleaf.com/project/0123456789abcdef01234567', 'overleaf', '0123456789abcdef01234567'],
    ['https://www.texpage.com/project/12345678-1234-1234-1234-123456789abc', 'texpage', '12345678-1234-1234-1234-123456789abc'],
    ['https://www.texpage.com/console?projectKey=test-key', 'texpage', 'test-key'],
  ];
  for (const [input, expected, id] of cases) {
    const url = new URL(input);
    assert.equal(providerForUrl(url), expected);
    assert.equal(PROVIDER_REGISTRY[expected].projectIdFromUrl(url), id);
  }
  for (const input of ['https://overleaf.com.example.org/project/x', 'https://example.com/?projectKey=x']) {
    assert.equal(providerForUrl(new URL(input)), undefined);
  }
});
