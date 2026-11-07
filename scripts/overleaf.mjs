import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from './core.mjs';

export class OverleafBackend {
  provider = 'overleaf';
  constructor(home) { this.home = path.join(home, 'auth', this.provider); }

  async init() {
    const { Config, OverleafClient } = await import('claudeleaf');
    // Keep this tool's sessions independent from any other claudeleaf installation.
    class WorkspaceConfig extends Config {
      get sessionPath() { return path.join(this.home, 'session.json'); }
      get browserProfile() { return path.join(this.home, 'browser-profile'); }
    }
    this.config = new WorkspaceConfig({ home: this.home, baseUrl: 'https://www.overleaf.com' });
    this.client = new OverleafClient(this.config);
  }

  async login() {
    await this.client.login();
    return { provider: this.provider, authenticated: true };
  }

  async status(live = false) {
    const cached = await fs.access(this.config.sessionPath).then(() => true, () => false);
    if (!live || !cached) return { provider: this.provider, sessionStored: cached,
      checked: 'local', ...(cached ? {} : { authenticated: false }) };
    // Use the actual list request so network failures remain distinguishable from auth failures.
    const projects = await this.projects();
    return { provider: this.provider, sessionStored: true, checked: 'live', authenticated: true, projects: projects.length };
  }

  async projects() {
    return (await this.client.listProjects()).map(p => ({ provider: this.provider, ...p }));
  }

  async files(project) {
    return (await this.client.listDocuments(project.id, true)).map(e => ({ path: e.path, type: e.type }));
  }

  async read(project, file, { fresh = false } = {}) {
    if (fresh) return (await this.client.resync(project.id, file)).text;
    return this.client.readDocument(project.id, file);
  }

  async write(project, file, content, { before, edits } = {}) {
    if (edits) {
      let expected = before;
      for (const edit of edits) {
        const current = await this.client.readDocument(project.id, file);
        if (current !== expected) throw new WorkspaceError('VERSION_CONFLICT', 'A collaborator changed the document; read it again.');
        const count = await this.client.replaceText(project.id, file, edit.old, edit.new, 1);
        if (count !== 1) throw new WorkspaceError('VERSION_CONFLICT', 'The replacement no longer matches; read the document again.');
        expected = expected.replace(edit.old, () => edit.new);
      }
    } else {
      if (await this.client.readDocument(project.id, file) !== before) {
        throw new WorkspaceError('VERSION_CONFLICT', 'A collaborator changed the document; read it again.');
      }
      // Replacing the exact original text also preserves unrelated text that might
      // arrive during the SDK's resync, rather than diffing over that new text.
      if (before) {
        const count = await this.client.replaceText(project.id, file, before, content, 1);
        if (count !== 1) throw new WorkspaceError('VERSION_CONFLICT', 'The original document no longer matches; read it again.');
      } else await this.client.append(project.id, file, content);
    }
  }

  async compile(project, options) {
    const result = await this.client.compile(project.id);
    if (options.log) await fs.writeFile(options.log, result.log, { mode: 0o600 });
    if (options.pdf) {
      if (!result.pdfUrl) throw new WorkspaceError('PDF_UNAVAILABLE', 'Compilation did not return a PDF.');
      // Playwright's request context sends only cookies whose domain/path match the artifact URL.
      const { request } = await import('playwright-core');
      const { cookies } = JSON.parse(await fs.readFile(this.config.sessionPath, 'utf8'));
      const http = await request.newContext({ storageState: { cookies: Object.entries(cookies).map(([name, value]) =>
        ({ name, value, domain: '.overleaf.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' })), origins: [] } });
      try {
        const response = await http.get(result.pdfUrl, { timeout: 60000 });
        if (!response.ok()) throw new WorkspaceError('DOWNLOAD_FAILED', `PDF download returned HTTP ${response.status()}.`);
        const buffer = await response.body();
        if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new WorkspaceError('INVALID_PDF', 'The artifact response is not a PDF.');
        await fs.writeFile(options.pdf, buffer, { mode: 0o600 });
      } finally { await http.dispose(); }
    }
    return { provider: this.provider, project: project.id, status: result.status,
      success: result.success && !result.errors.length, errors: result.errors, warnings: result.warnings,
      ...(options.pdf ? { pdf: path.resolve(options.pdf) } : {}), ...(options.log ? { log: path.resolve(options.log) } : {}) };
  }

  async close() { this.client?.close(); }
}
