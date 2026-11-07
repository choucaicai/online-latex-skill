import fs from 'node:fs/promises';
import path from 'node:path';
import { privateDir, privateJSON, WorkspaceError } from './core.mjs';
import { compileViaSocket, replaceDocContent, parseLog } from './vendor/texpage/utils.js';

const ORIGIN = 'https://www.texpage.com';
const LIST = '/api/project?page=1&projectName=&sortBy=updateAt&getType=all';
const query = (route, args) => `${route}?${new URLSearchParams(args)}`;

export async function launchBrowser(headless = true) {
  const { chromium } = await import('playwright-core');
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless }); }
    catch { /* try the next installed browser */ }
  }
  throw new WorkspaceError('BROWSER_MISSING', 'Install Google Chrome or Microsoft Edge to use browser login.');
}

function cleanState(state) {
  const belongs = domain => domain.replace(/^\./, '') === 'texpage.com' || domain.endsWith('.texpage.com');
  return { cookies: state.cookies.filter(c => belongs(c.domain)),
    origins: state.origins.filter(o => belongs(new URL(o.origin).hostname)) };
}

export class TexpageBackend {
  provider = 'texpage';
  constructor(home) {
    this.home = path.join(home, 'auth', this.provider);
    this.stateFile = path.join(this.home, 'session.json');
  }
  async init() {}

  async apiOn(page, route, text = false) {
    const response = await page.evaluate(async ({ route, text }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const r = await fetch(route, { credentials: 'include', signal: controller.signal });
        const body = await r.text();
        let json;
        try { json = JSON.parse(body); } catch { /* handled outside the browser */ }
        return { status: r.status, type: r.headers.get('content-type'), json,
          ...(text ? { text: body } : {}), html: /^\s*(?:<!doctype|<html|<script|<meta)/i.test(body) };
      } finally { clearTimeout(timer); }
    }, { route, text });
    if ([401, 403].includes(response.status)) throw new WorkspaceError('AUTH_REQUIRED', 'TeXPage needs browser login.');
    if (response.html) throw new WorkspaceError('BROWSER_CHALLENGE', 'TeXPage returned a browser verification page; run auth login --provider texpage.');
    if (response.status < 200 || response.status >= 300) throw new WorkspaceError('API_ERROR', `TeXPage returned HTTP ${response.status}.`);
    if (text && !response.json?.status) return response.text;
    const data = response.json;
    if (data?.status?.code !== 1) {
      const message = data?.status?.message || 'The API did not return a successful response.';
      const auth = /login|登录|未登录|unauth|session|认证|expired/i.test(message);
      throw new WorkspaceError(auth ? 'AUTH_REQUIRED' : 'API_ERROR', `TeXPage: ${message}`);
    }
    if (text) throw new WorkspaceError('INVALID_RESPONSE', 'The file endpoint returned metadata instead of text.');
    return data.result;
  }

  async login() {
    await privateDir(this.home);
    this.browser = await launchBrowser(false);
    let cached;
    try { cached = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); } catch { /* first login */ }
    this.context = await this.browser.newContext({ ...(cached ? { storageState: cached.storageState, userAgent: cached.userAgent } : {}) });
    this.page = await this.context.newPage();
    await this.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    process.stderr.write('请在打开的 TeXPage 浏览器中点击登录并完成验证；成功后会自动保存会话。\n');
    const deadline = Date.now() + 300000;
    let last;
    while (Date.now() < deadline) {
      if (this.page.isClosed()) throw new WorkspaceError('LOGIN_CANCELLED', 'The login window was closed.');
      try {
        if (new URL(this.page.url()).origin === ORIGIN) {
          await this.apiOn(this.page, LIST);
          this.userAgent = await this.page.evaluate(() => navigator.userAgent);
          this.persist = true;
          await this.saveState();
          return { provider: this.provider, authenticated: true };
        }
      } catch (e) { last = e; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new WorkspaceError('LOGIN_TIMEOUT', 'TeXPage sign-in was not completed within five minutes.', { lastCode: last?.code });
  }

  async open() {
    if (this.page) return this.page;
    let state;
    try { state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')); }
    catch { throw new WorkspaceError('AUTH_REQUIRED', 'Run latex-workspace auth login --provider texpage.'); }
    this.browser = await launchBrowser(true);
    this.userAgent = state.userAgent;
    this.context = await this.browser.newContext({ storageState: state.storageState, userAgent: this.userAgent });
    this.page = await this.context.newPage();
    await this.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    this.persist = true;
    return this.page;
  }

  async saveState() {
    if (this.persist && this.context) {
      await privateJSON(this.stateFile, { userAgent: this.userAgent,
        storageState: cleanState(await this.context.storageState()) });
    }
  }

  async status(live = false) {
    const cached = await fs.access(this.stateFile).then(() => true, () => false);
    if (!live || !cached) return { provider: this.provider, sessionStored: cached,
      checked: 'local', ...(cached ? {} : { authenticated: false }) };
    const projects = await this.projects();
    return { provider: this.provider, sessionStored: true, authenticated: true, checked: 'live', projects: projects.length };
  }

  async projects() {
    const page = await this.open();
    const projects = [];
    const seen = new Set();
    for (let number = 1; number <= 200; number++) {
      const data = await this.apiOn(page, `/api/project?page=${number}&projectName=&sortBy=updateAt&getType=all`);
      if (!Array.isArray(data?.list)) throw new WorkspaceError('INVALID_RESPONSE', 'TeXPage project list has an unexpected shape.');
      if (!data.list.length) return projects;
      let added = 0;
      for (const p of data.list) {
        if (seen.has(p.projectKey)) continue;
        seen.add(p.projectKey); added++;
        const version = p.selectedVersion || p.versionNos?.[0];
        projects.push({ provider: this.provider, id: p.projectKey, name: p.projectName,
          version: version?.versionName || 'main', versionNo: version?.versionNo == null ? undefined : String(version.versionNo),
          versions: (p.versionNos || []).map(v => ({ id: String(v.versionNo), name: v.versionName })),
          owner: p.ownerName, accessLevel: p.privilege, lastUpdated: p.updateAt,
          _ownerKey: p.ownerKey });
      }
      if (!added) throw new WorkspaceError('PAGINATION_FAILED', 'TeXPage repeated a project page; the list may be incomplete.');
    }
    throw new WorkspaceError('PAGINATION_LIMIT', 'More than 200 project pages; narrow the operation before continuing.');
  }

  ref(project) {
    if (!project.versionNo) throw new WorkspaceError('VERSION_REQUIRED', 'The project has no selected version.');
    return { ownerKey: project._ownerKey, projectKey: project.id, versionNo: project.versionNo, projectName: project.name };
  }

  async tree(project) {
    const { ownerKey, projectKey, versionNo } = this.ref(project);
    const data = await this.apiOn(await this.open(), query('/api/project/fileTree', { ownerKey, projectKey, versionNo }));
    if (!Array.isArray(data?.treeData)) throw new WorkspaceError('INVALID_RESPONSE', 'TeXPage file tree has an unexpected shape.');
    return data.treeData;
  }

  async files(project) {
    return (await this.tree(project)).map(f => ({ path: f.filePath, type: f.isDir ? 'folder' : 'file' }));
  }

  async file(project, file) {
    const entry = (await this.tree(project)).find(f => f.filePath === file && !f.isDir);
    if (!entry) throw new WorkspaceError('FILE_NOT_FOUND', `File not found: ${file}`);
    return entry;
  }

  async read(project, file) {
    const entry = await this.file(project, file);
    return this.apiOn(await this.open(), query('/api/project/file', {
      fileKey: entry.fileKey, projectKey: project.id, versionNo: project.versionNo }), true);
  }

  async write(project, file, content, { before } = {}) {
    const entry = await this.file(project, file);
    // Supply a final precondition inside the socket's joinedDoc phase, before emitting ops.
    try { await replaceDocContent(await this.open(), this.ref(project), entry.fileKey, content, 30000, before); }
    catch (e) {
      if (e.message.includes('VERSION_CONFLICT:')) throw new WorkspaceError('VERSION_CONFLICT', 'The document changed before the TeXPage write; read it again.');
      throw e;
    }
  }

  async compile(project, options) {
    const tree = (await this.tree(project)).filter(f => !f.isDir);
    let main = options.mainFile ? tree.find(f => f.filePath === options.mainFile) : tree.find(f => f.filePath === 'main.tex');
    const tex = tree.filter(f => f.filePath.endsWith('.tex'));
    if (!main && !options.mainFile && tex.length === 1) main = tex[0];
    if (!main) throw new WorkspaceError('MAIN_FILE_REQUIRED', 'Pass --main-file with a .tex path from file list.');
    const result = await compileViaSocket(await this.open(), this.ref(project), main, 180000);
    if (!result.ok) return { provider: this.provider, project: project.id, success: false,
      status: result.errorType || 'failed', errors: [result.message || 'Compilation failed.'], warnings: [] };
    let log = '';
    if (result.logUrl) {
      const response = await this.context.request.get(result.logUrl, { timeout: 60000 });
      if (!response.ok()) throw new WorkspaceError('LOG_UNAVAILABLE', `Log download returned HTTP ${response.status()}.`);
      log = await response.text();
    } else throw new WorkspaceError('LOG_UNAVAILABLE', 'Compilation returned no log; success could not be checked.');
    const parsed = parseLog(log);
    if (options.log) await fs.writeFile(options.log, log, { mode: 0o600 });
    if (options.pdf) {
      if (!result.pdfUrl) throw new WorkspaceError('PDF_UNAVAILABLE', 'Compilation returned no PDF.');
      const response = await this.context.request.get(result.pdfUrl, { timeout: 60000 });
      if (!response.ok()) throw new WorkspaceError('DOWNLOAD_FAILED', `PDF download returned HTTP ${response.status()}.`);
      const buffer = await response.body();
      if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new WorkspaceError('INVALID_PDF', 'The artifact response is not a PDF.');
      await fs.writeFile(options.pdf, buffer, { mode: 0o600 });
    }
    return { provider: this.provider, project: project.id, success: !parsed.errors.length,
      status: parsed.errors.length ? 'success-with-errors' : 'success', ...parsed,
      ...(options.pdf ? { pdf: path.resolve(options.pdf) } : {}), ...(options.log ? { log: path.resolve(options.log) } : {}) };
  }

  async close() {
    try { await this.saveState(); }
    finally { await this.browser?.close(); }
  }
}
