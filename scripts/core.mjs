import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export function remotePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\\') || input.includes('\0') ||
      input.startsWith('/') || input.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new WorkspaceError('INVALID_PATH', 'Use a project-relative file path without . or .. segments.');
  }
  return input;
}

export function selectProject(projects, input) {
  const byId = projects.filter(p => p.id === input);
  const matches = byId.length ? byId : projects.filter(p => p.name === input);
  if (!matches.length) throw new WorkspaceError('PROJECT_NOT_FOUND', `Project not found: ${input}`);
  if (matches.length > 1) throw new WorkspaceError('AMBIGUOUS_PROJECT', 'Several projects have that name; use an ID.',
    { projects: matches.map(({ id, name }) => ({ id, name })) });
  return matches[0];
}

export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new WorkspaceError('INVALID_EDITS', 'Edits must be a nonempty JSON array of {old, new} objects.');
  }
  let next = text;
  for (const [i, edit] of edits.entries()) {
    if (!edit || typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string') {
      throw new WorkspaceError('INVALID_EDITS', `Edit ${i + 1} needs a nonempty old string and a new string.`);
    }
    const at = next.indexOf(edit.old);
    if (at < 0 || next.indexOf(edit.old, at + 1) >= 0) {
      throw new WorkspaceError('EDIT_MATCH_CONFLICT', `Edit ${i + 1}: old text must match exactly once.`, { edit: i + 1 });
    }
    next = next.slice(0, at) + edit.new + next.slice(at + edit.old.length);
  }
  return next;
}

export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

export async function privateJSON(file, data) {
  await privateDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function withLock(home, provider, action) {
  const dir = path.join(home, 'locks');
  await privateDir(dir);
  const file = path.join(dir, `${provider}.json`);
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = await fs.open(file, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let dead = false;
      try {
        const owner = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (err) { dead = err.code === 'ESRCH'; }
        }
      } catch { /* a concurrently created lock may still be empty */ }
      if (dead && attempt === 0) { await fs.rm(file, { force: true }); continue; }
      throw new WorkspaceError('PROVIDER_BUSY', `Another ${provider} command is running.`, { lock: file });
    }
  }
  if (!fd) throw new WorkspaceError('PROVIDER_BUSY', `Another ${provider} command is running.`);
  await fd.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  await fd.close();
  try { return await action(); }
  finally { await fs.rm(file, { force: true }); }
}

export async function readFile(backend, project, file, output) {
  remotePath(file);
  const content = await backend.read(project, file);
  if (typeof content !== 'string') throw new WorkspaceError('INVALID_RESPONSE', 'Backend did not return document text.');
  if (output) {
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, content, { mode: 0o600 });
  }
  return { provider: backend.provider, project: project.id, path: file, sha256: sha256(content),
    bytes: Buffer.byteLength(content), ...(output ? { output: path.resolve(output) } : { content }) };
}

export async function changeFile(backend, project, file, options) {
  remotePath(file);
  const before = await backend.read(project, file);
  const beforeHash = sha256(before);
  if (options.ifMatch && options.ifMatch !== beforeHash) {
    throw new WorkspaceError('VERSION_CONFLICT', 'The document changed after it was read; read it again.', { currentSha256: beforeHash });
  }
  if (!options.edits && !options.ifMatch) {
    throw new WorkspaceError('PRECONDITION_REQUIRED', 'Whole-file writes require --if-match from a fresh file read.');
  }
  const after = options.edits ? applyEdits(before, options.edits) : options.content;
  if (typeof after !== 'string') throw new WorkspaceError('INVALID_CONTENT', 'Replacement content must be UTF-8 text.');
  const plan = { provider: backend.provider, project: project.id, path: file,
    beforeSha256: beforeHash, afterSha256: sha256(after), changed: before !== after,
    beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
  if (options.dryRun) return { ...plan, dryRun: true };
  if (before === after) return { ...plan, verified: true };

  // Check once more immediately before backing up and sending the mutation.
  if (sha256(await backend.read(project, file)) !== beforeHash) {
    throw new WorkspaceError('VERSION_CONFLICT', 'The document changed while preparing this edit; read it again.');
  }
  const backup = path.join(options.home, 'backups', backend.provider,
    `${Date.now()}-${randomUUID()}`);
  await privateDir(backup);
  await fs.writeFile(path.join(backup, 'original.txt'), before, { mode: 0o600 });
  await privateJSON(path.join(backup, 'manifest.json'), { ...plan, projectName: project.name,
    created: new Date().toISOString() });
  try {
    await backend.write(project, file, after, { before, edits: options.edits });
    const actual = await backend.read(project, file, { fresh: true });
    if (actual !== after) {
      throw new WorkspaceError('WRITE_UNVERIFIED', 'Read-back differs from the requested content; inspect the current file before retrying.',
        { actualSha256: sha256(actual) });
    }
  } catch (error) {
    throw new WorkspaceError(error.code || 'WRITE_FAILED', error.message,
      { ...error.details, backup, beforeSha256: beforeHash, expectedSha256: plan.afterSha256, retry: 'read-first' });
  }
  return { ...plan, backup, verified: true };
}
