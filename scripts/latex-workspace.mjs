#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WorkspaceError, changeFile, readFile, selectProject, withLock } from './core.mjs';
import { PROVIDER_REGISTRY, PROVIDERS, providerForUrl, loadBackend, providerDependencies } from './providers.mjs';

const VERSION = '0.1.0';
const STATE_HOME = path.resolve(process.env.LATEX_WORKSPACE_HOME || path.join(os.homedir(), '.local', 'share', 'latex-workspace'));
const HELP = `latex-workspace ${VERSION} — ${PROVIDERS.map(id => PROVIDER_REGISTRY[id].label).join(' / ')} CLI

Commands (JSON output):
  doctor                                   Check local dependencies and sessions
  auth login  --provider ${PROVIDERS.join('|')}   Open browser and save the signed-in session
  auth status [--provider all] [--live]     Local session presence; --live checks access
  auth logout --provider ${PROVIDERS.join('|')}   Remove this tool's saved login and profile
  project list [--provider all]             List accessible projects on both platforms
  file list  --provider SITE --project ID   List the project file tree
  file read  --provider SITE --project ID --path main.tex [--output ./main.tex]
  file edit  --provider SITE --project ID --path main.tex --edits edits.json [--dry-run]
  file write --provider SITE --project ID --path main.tex --file ./main.tex --if-match SHA256 [--dry-run]
  compile    --provider SITE --project ID [--main-file main.tex] [--pdf out.pdf] [--log build.log]

SITE is ${PROVIDERS.join(' or ')}. Project accepts an ID, exact name, or project URL.
Project URLs can infer the provider. TeXPage supports --project-version VERSION_NO.
Edits JSON: [{"old":"unique original text","new":"replacement text"}]
Whole-file writes require the SHA256 returned by file read. Every changed file is
backed up locally and read back after writing. --file - reads UTF-8 from stdin.
--json is accepted; output is always JSON. Credentials stay in the local data directory.
Data directory: ${STATE_HOME}
`;

function requireValue(value, name) {
  if (value === undefined || value === '') throw new WorkspaceError('INVALID_ARGUMENT', `Missing --${name}.`);
  return value;
}

function providerOf(value, allowAll = false) {
  if (PROVIDERS.includes(value) || (allowAll && value === 'all')) return value;
  throw new WorkspaceError('INVALID_PROVIDER', `Use --provider ${allowAll ? 'all, ' : ''}${PROVIDERS.join(' or ')}.`);
}

function projectInput(values) {
  let input = requireValue(values.project, 'project');
  let provider = values.provider;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const inferred = providerForUrl(url);
    if (!inferred || (provider && provider !== inferred)) throw new WorkspaceError('INVALID_PROJECT_URL', 'Project URL and provider must refer to the same supported platform.');
    provider = inferred;
    input = PROVIDER_REGISTRY[provider].projectIdFromUrl(url);
    if (!input) throw new WorkspaceError('INVALID_PROJECT_URL', 'No project ID was found in that URL; use an ID from project list.');
  }
  return { provider: providerOf(provider), input };
}

async function backendFor(provider) {
  const backend = await loadBackend(provider, STATE_HOME);
  try { await backend.init(); return backend; }
  catch (e) { await backend.close(); throw e; }
}

async function using(provider, action) {
  return withLock(STATE_HOME, provider, async () => {
    const backend = await backendFor(provider);
    let failed = false;
    try { return await action(backend); }
    catch (e) { failed = true; throw e; }
    finally { try { await backend.close(); } catch (e) { if (!failed) throw e; } }
  });
}

async function across(provider, action) {
  const names = provider === 'all' ? PROVIDERS : [provider];
  const results = [], errors = [];
  // Each provider owns a login/session; perform calls sequentially to keep interactive login simple.
  for (const name of names) {
    try { results.push(await using(name, action)); }
    catch (error) { errors.push({ provider: name, ...errorInfo(error) }); }
  }
  return { results, errors };
}

function errorInfo(error) {
  let code = error.code;
  if (!code && /AuthError|No .* session|session.*expired|session.*invalid|not signed in/i.test(`${error.name} ${error.message}`)) code = 'AUTH_REQUIRED';
  const message = String(error.message || error)
    .replace(/claudeleaf login/g, 'latex-workspace auth login --provider overleaf')
    .replace(/(https?:\/\/[^\s?'"<>]+)\?[^\s'"<>]+/g, '$1?[redacted]');
  return { code: code || 'BACKEND_ERROR', message, ...error.details };
}

async function utf8(file) {
  const bytes = file === '-' ? await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  }) : await fs.readFile(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new WorkspaceError('INVALID_ENCODING', 'Input must be UTF-8 text.'); }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: Object.fromEntries([
      ...['provider', 'project', 'path', 'file', 'edits', 'if-match', 'output', 'pdf', 'log', 'main-file', 'project-version'].map(k => [k, { type: 'string' }]),
      ...['json', 'dry-run', 'live', 'help', 'version'].map(k => [k, { type: 'boolean' }]),
    ]) });
  if (values.help || !positionals.length && !values.version) { process.stdout.write(HELP); return 0; }
  if (values.version) { process.stdout.write(JSON.stringify({ version: VERSION }) + '\n'); return 0; }
  const [command, verb] = positionals;
  const allowed = {
    doctor: [], 'auth login': ['provider'], 'auth status': ['provider', 'live'], 'auth logout': ['provider'],
    'project list': ['provider'], 'file list': ['provider', 'project', 'project-version'],
    'file read': ['provider', 'project', 'path', 'output', 'project-version'],
    'file write': ['provider', 'project', 'path', 'file', 'if-match', 'dry-run', 'project-version'],
    'file edit': ['provider', 'project', 'path', 'edits', 'if-match', 'dry-run', 'project-version'],
    compile: ['provider', 'project', 'main-file', 'pdf', 'log', 'project-version'],
  }[[command, verb].filter(Boolean).join(' ')];
  if (!allowed) throw new WorkspaceError('UNKNOWN_COMMAND', 'Unknown command; run latex-workspace --help.');
  for (const key of Object.keys(values)) {
    if (!['json', 'help', 'version', ...allowed].includes(key)) {
      throw new WorkspaceError('INVALID_ARGUMENT', `--${key} does not apply to this command.`);
    }
  }
  if (positionals.length > (['auth', 'project', 'file'].includes(command) ? 2 : 1)) throw new WorkspaceError('INVALID_ARGUMENT', 'Unexpected positional arguments; use --help.');
  let result, ok = true, exitCode = 0;
  if (command === 'doctor') {
    const dependencies = {};
    for (const name of providerDependencies()) {
      try { await import(name); dependencies[name] = 'installed'; }
      catch { dependencies[name] = 'missing'; }
    }
    result = { version: VERSION, node: process.version, dataDirectory: STATE_HOME, dependencies,
      sessions: (await across('all', b => b.status(false))) };
    ok = Object.values(dependencies).every(v => v === 'installed') && !result.sessions.errors.length;
    exitCode = ok ? 0 : 1;
  } else if (command === 'auth' && ['login', 'status', 'logout'].includes(verb)) {
    const provider = providerOf(values.provider || (verb === 'status' ? 'all' : undefined), verb === 'status');
    if (verb === 'status') {
      result = await across(provider, b => b.status(Boolean(values.live)));
      ok = !result.errors.length; exitCode = ok ? 0 : 1;
    } else if (verb === 'login') {
      process.stderr.write(`正在打开 ${provider} 登录窗口，请在浏览器中完成登录。\n`);
      result = await using(provider, b => b.login());
    } else {
      result = await withLock(STATE_HOME, provider, async () => {
        await fs.rm(path.join(STATE_HOME, 'auth', provider), { recursive: true, force: true });
        return { provider, authenticated: false, sessionRemoved: true };
      });
    }
  } else if (command === 'project' && verb === 'list') {
    const gathered = await across(providerOf(values.provider || 'all', true), b => b.projects());
    result = { projects: gathered.results.flat().map(project =>
      Object.fromEntries(Object.entries(project).filter(([key]) => !key.startsWith('_')))), errors: gathered.errors };
    ok = !result.errors.length; exitCode = ok ? 0 : 1;
  } else if (command === 'compile' || command === 'file' && ['list', 'read', 'write', 'edit'].includes(verb)) {
    const { provider, input } = projectInput(values);
    const capabilities = PROVIDER_REGISTRY[provider].capabilities;
    if (values['main-file'] && !capabilities.mainFile) {
      throw new WorkspaceError('UNSUPPORTED_OPTION', `${provider} uses its configured root document and does not accept --main-file.`);
    }
    if (values['project-version'] && !capabilities.projectVersions) {
      throw new WorkspaceError('UNSUPPORTED_OPTION', `${provider} does not accept --project-version.`);
    }
    // Validate local inputs before opening a remote session.
    let edits, content;
    if (verb === 'write') content = await utf8(requireValue(values.file, 'file'));
    if (verb === 'edit') {
      try { edits = JSON.parse(await utf8(requireValue(values.edits, 'edits'))); }
      catch (e) { if (e instanceof SyntaxError) throw new WorkspaceError('INVALID_EDITS', 'The edits file is not valid JSON.'); throw e; }
    }
    if (['read', 'write', 'edit'].includes(verb)) requireValue(values.path, 'path');
    if (verb === 'write') requireValue(values['if-match'], 'if-match');
    for (const target of [values.output, values.pdf, values.log].filter(Boolean)) await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
    result = await using(provider, async backend => {
      const project = selectProject(await backend.projects(), input);
      if (values['project-version']) {
        if (values['project-version'] !== project.versionNo && !project.versions?.some(v => v.id === values['project-version'])) {
          throw new WorkspaceError('VERSION_NOT_FOUND', 'Use a version ID from project list.');
        }
        project.versionNo = values['project-version'];
      }
      if (command === 'compile') return backend.compile(project, { mainFile: values['main-file'], pdf: values.pdf, log: values.log });
      if (verb === 'list') return { provider, project: project.id, files: await backend.files(project) };
      if (verb === 'read') return readFile(backend, project, values.path, values.output);
      return changeFile(backend, project, values.path, { home: STATE_HOME, edits, content,
        ifMatch: values['if-match'], dryRun: Boolean(values['dry-run']) });
    });
    if (command === 'compile' && !result.success) { ok = false; exitCode = 2; }
  } else throw new WorkspaceError('UNKNOWN_COMMAND', 'Unknown command; run latex-workspace --help.');
  process.stdout.write(JSON.stringify({ ok, result }) + '\n');
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: errorInfo(error) }) + '\n');
    process.exitCode = 1;
  });
}
