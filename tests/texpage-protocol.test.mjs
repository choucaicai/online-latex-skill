import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { replaceDocContent, parseLog } from '../scripts/vendor/texpage/utils.js';
import { TexpageBackend } from '../scripts/texpage.mjs';

const ref = { projectKey: 'project', ownerKey: 'owner', versionNo: 'main' };
const site = 'authenticated-site';
const roomId = 'doc_main';
const joinedVersion = 'doc-revision';

function browser({ current = 'old', denied = false, malformed = false, earlyAck = false,
  concurrent = false, rejected = false, wrongBatch = false, split = false } = {}) {
  const sent = [];
  const batches = [];
  let active;
  class Socket {
    constructor() { active = this; this.frame('0{}'); }
    close() {}
    frame(data) { queueMicrotask(() => this.onmessage({ data })); }
    event(name, data) { this.frame('42' + JSON.stringify([name, data])); }
    send(packet) {
      if (packet === '40') { this.frame('40{}'); return; }
      const [, id, encoded] = packet.match(/^42(\d*)(\[.*)$/);
      const [name, payload] = JSON.parse(encoded);
      if (name === 'request') this.event('response', { requestId: payload.request.requestId, status: { code: denied ? 403 : 1 } });
      if (name === 'joinDoc') {
        const operations = [{ spliceId: { site: 'existing', seq: 7 } }, { spliceId: { site, seq: 11 } }];
        if (concurrent) this.event('clients', { roomId, data: [{ userKey: site }, { userKey: site }] });
        const join = data => this.event('joinedDoc', { roomId, data: { ...data, v: joinedVersion, total: 2 } });
        if (split) {
          join({ operations: operations.slice(0, 1), current: 1 });
          join({ operations: operations.slice(1), current: 2 });
        } else join({ operations: malformed ? null : operations, current: 2 });
      }
      if (name === 'operations') {
        batches.push({ id, payload });
        sent.push(...payload.operations);
        const result = { batchId: wrongBatch ? 'unrelated' : payload.batchId, status: rejected ? 'invalid_payload' : 'ok' };
        this.frame(`43${id}${JSON.stringify([result])}`);
      }
    }
  }
  const page = { evaluate: (script, params) => vm.runInNewContext(`(${script.toString()})(${JSON.stringify(params)})`, {
    WebSocket: Socket, crypto: webcrypto, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async () => {
      if (earlyAck) {
        active.event('mergedOperations', { roomId, data: ['doc.12.splice'] });
        active.frame('430[{"batchId":"stale","status":"ok"}]');
        await new Promise(resolve => setImmediate(resolve));
      }
      return { ok: true, text: async () => current };
    },
  }) };
  return { page, sent, batches };
}

test('TeXPage CRDT refuses a changed document after joining and before emitting operations', async () => {
  const { page, sent } = browser({ current: 'human change' });
  await assert.rejects(replaceDocContent(page, ref, 'doc', 'new', 1000, 'old', site), /VERSION_CONFLICT/);
  assert.equal(sent.length, 0);
});

test('denied project join or malformed document state emits no edits', async () => {
  for (const options of [{ denied: true }, { malformed: true }]) {
    const { page, sent } = browser(options);
    await assert.rejects(replaceDocContent(page, ref, 'doc', 'new', 1000, 'old', site));
    assert.equal(sent.length, 0);
  }
});

test('CRDT chunks preserve surrogate pairs, line offsets, existing sequence bounds, and acknowledgments', async () => {
  const { page, sent, batches } = browser({ split: true });
  const text = 'a'.repeat(199) + '😀\n中文' + 'b'.repeat(230);
  const result = await replaceDocContent(page, ref, 'doc', text, 1000, 'old', site);
  const insertions = sent.map(x => x.operation.insertion.text);
  assert.equal(insertions.join(''), text);
  for (const chunk of insertions) {
    assert.ok(chunk.length <= 200);
    assert.equal(chunk.isWellFormed(), true);
  }
  assert.equal(result.chunks, sent.length);
  assert.equal(batches[0].id, '0');
  assert.equal(batches[0].payload.v, joinedVersion);
  assert.equal(batches[0].payload.syncType, 'sync');
  assert.equal(sent[0].operation.spliceId.site, site);
  assert.equal(sent[0].operation.spliceId.seq, 12);
  assert.equal(sent[0].operation.deletion.maxSeqsBySite.existing, 7);
  assert.equal(sent[0].operation.deletion.maxSeqsBySite[site], 11);
  assert.equal(sent[1].operation.insertion.leftDependencyId.seq, 12);
  assert.equal(sent[1].operation.insertion.offsetInLeftDependency.column, 199);
});

test('clearing a TeXPage document sends an acknowledged deletion without an insertion', async () => {
  const { page, sent } = browser();
  const result = await replaceDocContent(page, ref, 'doc', '', 1000, 'old', site);
  assert.equal(result.chunks, 1);
  assert.ok(sent[0].operation.deletion);
  assert.equal(sent[0].operation.insertion, undefined);
});

test('an unrelated acknowledgment during the precondition fetch cannot complete the write', async () => {
  const { page, sent } = browser({ earlyAck: true });
  const result = await replaceDocContent(page, ref, 'doc', 'new', 1000, 'old', site);
  assert.equal(sent.length, 1);
  assert.equal(result.chunks, 1);
  assert.equal(sent[0].operation.insertion.text, 'new');
});

test('TeXPage limits each batch and preserves dependencies across batches', async () => {
  const { page, batches } = browser();
  const { chunks } = await replaceDocContent(page, ref, 'doc', 'a'.repeat(20001), 1000, 'old', site);
  assert.equal(chunks, 101);
  assert.deepEqual(batches.map(({ id, payload }) => [id, payload.operations.length]), [['0', 100], ['1', 1]]);
  assert.notEqual(batches[0].payload.batchId, batches[1].payload.batchId);
  const last = batches[0].payload.operations.at(-1).operation;
  assert.equal(batches[1].payload.operations[0].operation.insertion.leftDependencyId.seq, last.spliceId.seq);
});

test('a rejected or mismatched batch acknowledgment prevents sending more operations', async () => {
  for (const [options, error] of [[{ rejected: true }, /invalid_payload/], [{ wrongBatch: true }, /Invalid TeXPage write acknowledgment/]]) {
    const { page, batches } = browser(options);
    await assert.rejects(replaceDocContent(page, ref, 'doc', 'a'.repeat(20001), 1000, 'old', site), error);
    assert.equal(batches.length, 1);
  }
});

test('multiple reported sessions for the same editor stop the write', async () => {
  const { page, sent } = browser({ concurrent: true });
  await assert.rejects(replaceDocContent(page, ref, 'doc', 'new', 1000, 'old', site), /close other TeXPage editors/);
  assert.equal(sent.length, 0);
});

test('manual commit and unknown sync modes stop before opening the write socket', async () => {
  const project = { id: ref.projectKey, name: 'Paper', _ownerKey: ref.ownerKey, versionNo: ref.versionNo };
  for (const mode of ['async', undefined]) {
    const backend = new TexpageBackend('/unused');
    backend.file = async () => ({ fileKey: 'doc' });
    let evaluated = 0;
    backend.open = async () => ({ evaluate: async () => {
      assert.equal(evaluated++, 0);
      return { mode, site };
    } });
    await assert.rejects(backend.write(project, 'main.tex', 'new', { before: 'old' }), { code: 'TEXPAGE_SYNC_MODE' });
    assert.equal(evaluated, 1);
  }
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
