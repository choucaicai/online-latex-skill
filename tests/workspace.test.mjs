import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { changeFile, sha256, selectProject, remotePath, withLock } from '../scripts/core.mjs';
import { OverleafBackend } from '../scripts/overleaf.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../scripts/latex-workspace.mjs', import.meta.url));
const project = { id: 'test-project', name: 'My Paper' };

async function fixture(t, text = 'Title: Old\n正文 😀\n') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-workspace-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const backend = { provider: 'texpage', text, writes: 0, reads: 0,
    async read() { this.reads++; return this.text; },
    async write(p, file, content) { this.writes++; this.text = content; } };
  return { home, backend };
}

test('a verified edit preserves Unicode/literal replacement text and backs up the original privately', async t => {
  const { home, backend } = await fixture(t);
  const original = backend.text;
  const replacement = '新标题 😀 $& `x` $(literal)';
  const result = await changeFile(backend, project, 'sections/intro.tex', {
    home, edits: [{ old: 'Old', new: replacement }] });
  assert.equal(result.verified, true);
  assert.equal(backend.text, original.replace('Old', () => replacement));
  assert.equal(backend.writes, 1);
  const backup = path.join(result.backup, 'original.txt');
  assert.equal(await fs.readFile(backup, 'utf8'), original);
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  assert.equal(result.afterSha256, sha256(backend.text));
});

test('stale whole-file hash refuses a write before making a backup or mutation', async t => {
  const { home, backend } = await fixture(t);
  await assert.rejects(changeFile(backend, project, 'main.tex', { home, content: 'new', ifMatch: sha256('stale') }), { code: 'VERSION_CONFLICT' });
  assert.equal(backend.writes, 0);
  await assert.rejects(fs.access(path.join(home, 'backups')));
});

test('whole-file writes require a read hash, including dry runs', async t => {
  const { home, backend } = await fixture(t);
  await assert.rejects(changeFile(backend, project, 'main.tex', { home, content: 'new', dryRun: true }), { code: 'PRECONDITION_REQUIRED' });
  assert.equal(backend.writes, 0);
});

test('ambiguous or missing edits validate the entire edit list before any mutation', async t => {
  const { home, backend } = await fixture(t, 'aaa\nTitle: Old');
  for (const old of ['aa', 'missing']) {
    await assert.rejects(changeFile(backend, project, 'main.tex', { home,
      edits: [{ old: 'Old', new: 'New' }, { old, new: 'x' }] }), { code: 'EDIT_MATCH_CONFLICT' });
  }
  assert.equal(backend.text, 'aaa\nTitle: Old');
  assert.equal(backend.writes, 0);
});

test('dry run describes the change without backing up or writing', async t => {
  const { home, backend } = await fixture(t);
  const result = await changeFile(backend, project, 'main.tex', { home, edits: [{ old: 'Old', new: 'New' }], dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);
  assert.equal(backend.writes, 0);
  await assert.rejects(fs.access(path.join(home, 'backups')));
});

test('concurrent change between planning and sending refuses the mutation', async t => {
  const { home, backend } = await fixture(t);
  backend.read = async () => ++backend.reads === 1 ? backend.text : backend.text + 'collaborator';
  await assert.rejects(changeFile(backend, project, 'main.tex', { home, edits: [{ old: 'Old', new: 'New' }] }), { code: 'VERSION_CONFLICT' });
  assert.equal(backend.writes, 0);
});

test('a failed or unverified write returns the backup and never replays the mutation', async t => {
  for (const fails of [false, true]) {
    const { home, backend } = await fixture(t);
    backend.write = async () => { backend.writes++; if (fails) throw new Error('connection closed'); };
    await assert.rejects(changeFile(backend, project, 'main.tex', { home, edits: [{ old: 'Old', new: 'New' }] }), e => {
      assert.equal(e.code, fails ? 'WRITE_FAILED' : 'WRITE_UNVERIFIED');
      assert.ok(e.details.backup);
      assert.equal(e.details.retry, 'read-first');
      return true;
    });
    assert.equal(backend.writes, 1);
  }
});

test('empty content is a valid guarded whole-file replacement', async t => {
  const { home, backend } = await fixture(t);
  const result = await changeFile(backend, project, 'main.tex', { home, content: '', ifMatch: sha256(backend.text) });
  assert.equal(result.verified, true);
  assert.equal(backend.text, '');
});

test('project name ambiguity requires an ID; an exact ID wins over a matching name', () => {
  const list = [{ id: 'one', name: 'Paper' }, { id: 'two', name: 'Paper' }, { id: 'three', name: 'one' }];
  assert.throws(() => selectProject(list, 'Paper'), { code: 'AMBIGUOUS_PROJECT' });
  assert.equal(selectProject(list, 'one').id, 'one');
  assert.throws(() => selectProject(list, 'other'), { code: 'PROJECT_NOT_FOUND' });
});

test('project-relative paths reject traversal and platform separators', () => {
  for (const bad of ['../main.tex', '/main.tex', 'x/../main.tex', 'x\\main.tex', 'x//main.tex', './main.tex']) {
    assert.throws(() => remotePath(bad), { code: 'INVALID_PATH' });
  }
  assert.equal(remotePath('章节/main.tex'), '章节/main.tex');
});

test('provider lock prevents simultaneous writes and releases after completion', async t => {
  const { home } = await fixture(t);
  await withLock(home, 'overleaf', async () => {
    await assert.rejects(withLock(home, 'overleaf', async () => assert.fail('must not execute')), { code: 'PROVIDER_BUSY' });
  });
  assert.equal(await withLock(home, 'overleaf', async () => 'released'), 'released');
});

test('CLI rejects unsupported dry-run on logout before removing any credentials', async t => {
  const { home } = await fixture(t);
  const session = path.join(home, 'auth', 'texpage', 'session.json');
  await fs.mkdir(path.dirname(session), { recursive: true });
  await fs.writeFile(session, 'test fixture');
  await assert.rejects(exec(process.execPath, [cli, 'auth', 'logout', '--provider', 'texpage', '--dry-run'],
    { env: { ...process.env, LATEX_WORKSPACE_HOME: home } }), e => {
    assert.equal(JSON.parse(e.stdout).error.code, 'INVALID_ARGUMENT'); return true;
  });
  assert.equal(await fs.readFile(session, 'utf8'), 'test fixture');
});

test('CLI auth status distinguishes absent sessions from a live verification', async t => {
  const { home } = await fixture(t);
  const { stdout } = await exec(process.execPath, [cli, 'auth', 'status'], { env: { ...process.env, LATEX_WORKSPACE_HOME: home } });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.result.results.length, 2);
  for (const state of result.result.results) {
    assert.equal(state.sessionStored, false); assert.equal(state.authenticated, false); assert.equal(state.checked, 'local');
  }
});

test('CLI rejects provider/URL mismatch before looking up remote projects', async t => {
  const { home } = await fixture(t);
  await assert.rejects(exec(process.execPath, [cli, 'file', 'list', '--provider', 'texpage', '--project',
    'https://www.overleaf.com/project/0123456789abcdef01234567'], { env: { ...process.env, LATEX_WORKSPACE_HOME: home } }), e => {
    assert.equal(JSON.parse(e.stdout).error.code, 'INVALID_PROJECT_URL'); return true;
  });
});

test('project list reports missing logins per provider and points to the unified auth commands', async t => {
  const { home } = await fixture(t);
  await assert.rejects(exec(process.execPath, [cli, 'project', 'list'], { env: { ...process.env, LATEX_WORKSPACE_HOME: home } }), e => {
    const response = JSON.parse(e.stdout);
    assert.equal(response.ok, false);
    assert.deepEqual(response.result.projects, []);
    assert.deepEqual(response.result.errors.map(x => x.code), ['AUTH_REQUIRED', 'AUTH_REQUIRED']);
    assert.match(response.result.errors[0].message, /latex-workspace auth login --provider overleaf/);
    assert.match(response.result.errors[1].message, /latex-workspace auth login --provider texpage/);
    return true;
  });
});

test('Overleaf whole-file replacement preserves a collaborator append received during SDK resync', async t => {
  const { home } = await fixture(t);
  const backend = new OverleafBackend(home);
  let actual = 'original';
  backend.client = {
    readDocument: async () => actual,
    resync: async () => ({ text: actual }),
    replaceText: async (projectId, file, old, next) => {
      actual += '\nhuman addition'; // arrives while the SDK synchronizes
      actual = actual.replace(old, () => next);
      return 1;
    },
    setText: () => assert.fail('must not replace the resynced document'),
  };
  await assert.rejects(changeFile(backend, project, 'main.tex', { home, content: 'updated', ifMatch: sha256('original') }), { code: 'WRITE_UNVERIFIED' });
  assert.equal(actual, 'updated\nhuman addition');
});
