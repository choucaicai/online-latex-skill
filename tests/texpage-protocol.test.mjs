import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { replaceDocContent, parseLog } from '../scripts/vendor/texpage/utils.js';
import { TexpageBackend } from '../scripts/texpage.mjs';

const ref = { projectKey: 'project', ownerKey: 'owner', versionNo: 'main' };
function browser({ current = 'old', denied = false, malformed = false, earlyAck = false } = {}) {
  const sent = [];
  let active;
  class Socket {
    constructor() { active = this; queueMicrotask(() => this.onopen()); }
    close() {}
    event(name, data) { queueMicrotask(() => this.onmessage({ data: '42' + JSON.stringify([name, data]) })); }
    send(packet) {
      if (packet === '40') { queueMicrotask(() => this.onmessage({ data: '40{}' })); return; }
      const [name, payload] = JSON.parse(packet.slice(2));
      if (name === 'request') this.event('response', { requestId: 'j1', status: { code: denied ? 403 : 1 } });
      if (name === 'joinDoc') this.event('joinedDoc', { data: { operations: malformed ? null : [{ spliceId: { site: 'existing', seq: 7 } }] } });
      if (name === 'operations') {
        sent.push(...payload.operations);
        this.event('mergedOperations', payload.operations.map(x => `${x.fileKey}.${x.operation.spliceId.seq}.splice`));
      }
    }
  }
  const page = { evaluate: script => vm.runInNewContext(script, {
    WebSocket: Socket, crypto: webcrypto, URLSearchParams, setTimeout, clearTimeout,
    fetch: async () => {
      if (earlyAck) {
        active.event('mergedOperations', ['other-doc.1.splice']);
        await new Promise(resolve => setImmediate(resolve));
      }
      return { ok: true, text: async () => current };
    },
  }) };
  return { page, sent };
}

test('TeXPage CRDT refuses a changed document after joining and before emitting operations', async () => {
  const { page, sent } = browser({ current: 'human change' });
  await assert.rejects(replaceDocContent(page, ref, 'doc', 'new', 1000, 'old'), /VERSION_CONFLICT/);
  assert.equal(sent.length, 0);
});

test('denied project join or malformed document state emits no edits', async () => {
  for (const options of [{ denied: true }, { malformed: true }]) {
    const { page, sent } = browser(options);
    await assert.rejects(replaceDocContent(page, ref, 'doc', 'new', 1000, 'old'));
    assert.equal(sent.length, 0);
  }
});

test('CRDT chunks preserve surrogate pairs, line offsets, existing sequence bounds, and acknowledgments', async () => {
  const { page, sent } = browser();
  const text = 'a'.repeat(199) + '😀\n中文' + 'b'.repeat(230);
  const result = await replaceDocContent(page, ref, 'doc', text, 1000, 'old');
  const insertions = sent.map(x => x.operation.insertion.text);
  assert.equal(insertions.join(''), text);
  for (const chunk of insertions) {
    assert.ok(chunk.length <= 200);
    assert.equal(chunk.isWellFormed(), true);
  }
  assert.equal(result.chunks, sent.length);
  assert.equal(sent[0].operation.deletion.maxSeqsBySite.existing, 7);
  assert.equal(sent[1].operation.insertion.offsetInLeftDependency.column, 199);
});

test('clearing a TeXPage document sends an acknowledged deletion without an insertion', async () => {
  const { page, sent } = browser();
  const result = await replaceDocContent(page, ref, 'doc', '', 1000, 'old');
  assert.equal(result.chunks, 1);
  assert.ok(sent[0].operation.deletion);
  assert.equal(sent[0].operation.insertion, undefined);
});

test('an unrelated acknowledgment during the precondition fetch cannot complete the write', async () => {
  const { page, sent } = browser({ earlyAck: true });
  const result = await replaceDocContent(page, ref, 'doc', 'new', 1000, 'old');
  assert.equal(sent.length, 1);
  assert.equal(result.chunks, 1);
  assert.equal(sent[0].operation.insertion.text, 'new');
});

test('file/line-prefixed warnings remain warnings and recovered TeX errors remain errors', () => {
  const result = parseLog('main.tex:12: Package hyperref Warning: bad link\n! Undefined control sequence.\nl.13 \\bad\n');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Undefined control sequence/);
});

test('file tree request satisfies the live API parameter contract without leaking display metadata', async () => {
  const backend = new TexpageBackend('/unused');
  backend.open = async () => ({ evaluate: async (fn, { route }) => {
    const url = new URL(route, 'https://www.texpage.com');
    const valid = url.pathname === '/api/project/fileTree' &&
      [...url.searchParams.keys()].sort().join(',') === 'ownerKey,projectKey,versionNo';
    return { status: 200, html: false, json: valid ?
      { status: { code: 1 }, result: { treeData: [{ filePath: 'paper.tex', isDir: false }] } } :
      { status: { code: 400 }, message: 'The requested parameters are incorrect' } };
  } });
  assert.deepEqual(await backend.files({ id: 'project', name: 'My Paper', _ownerKey: 'owner', versionNo: 'main' }),
    [{ path: 'paper.tex', type: 'file' }]);
});
