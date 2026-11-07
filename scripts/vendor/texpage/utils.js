const SITE = "texpage";
const DOMAIN = "www.texpage.com";
async function texFetch(page, js) {
  return page.evaluate(`(async () => { ${js} })()`);
}
async function texGet(page, path) {
  const d = await texFetch(
    page,
    `const r = await fetch(${JSON.stringify(path)}, { credentials: 'include' });
     return await r.json();`
  );
  const code = d?.status?.code;
  if (code !== 1) {
    throw new Error(`TeXPage API ${path} failed: ${d?.status?.message || JSON.stringify(d).slice(0, 200)}`);
  }
  return d.result;
}
async function resolveProject(page, input) {
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const result = await texGet(
      page,
      `/api/project?page=${pageNo}&projectName=&sortBy=updateAt&getType=all`
    );
    const list = result?.list || [];
    const hit = list.find((p) => p.projectKey === input || p.projectName === input);
    if (hit) {
      const versionNo = hit.selectedVersion?.versionNo || hit.versionNos?.[0]?.versionNo;
      if (!versionNo) throw new Error(`Project "${input}" has no version info`);
      return {
        ownerKey: hit.ownerKey,
        projectKey: hit.projectKey,
        versionNo,
        projectName: hit.projectName
      };
    }
    if (list.length === 0) break;
  }
  throw new Error(`Project not found: "${input}" (pass a projectKey or exact project name from \`opencli texpage list\`)`);
}
async function cookieHeader(page) {
  const cookies = await page.getCookies({ domain: ".texpage.com" });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function compileViaSocket(page, ref, main, timeoutMs = 9e4) {
  const result = await page.evaluate(
    `(async () => {
      const P = ${JSON.stringify({ ...ref, main })};
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket');
        let phase = 0;
        const reqId = 'compile-' + Math.random().toString(36).slice(2);
        const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('compile timeout')); }, ${timeoutMs});
        const send = (action, data, id) => ws.send('42' + JSON.stringify(['request', {
          request: { requestId: id || Math.random().toString(36).slice(2), action }, data,
        }]));
        ws.onopen = () => ws.send('40');
        ws.onmessage = (ev) => {
          const d = String(ev.data);
          if (d === '2') { ws.send('3'); return; }
          if (d.startsWith('40') && phase === 0) {
            phase = 1;
            send('post:/api/project/joinRoom', { projectKey: P.projectKey, versionNo: P.versionNo }, 'join');
            return;
          }
          if (!d.startsWith('42')) return;
          let msg;
          try { msg = JSON.parse(d.slice(2)); } catch (e) { return; }
          const payload = msg[1] || {};
          if (phase === 1 && payload.requestId === 'join') {
            phase = 2;
            if (payload.status && payload.status.code !== 1) {
              clearTimeout(timer); try { ws.close(); } catch (e) {}
              reject(new Error('joinRoom failed: ' + (payload.status.message || 'unknown')));
              return;
            }
            send('get:/api/project/compile', {
              ownerKey: P.ownerKey, projectKey: P.projectKey, versionNo: P.versionNo,
              filePath: P.main.filePath, fileKey: P.main.fileKey,
              line: 1, column: 1, mainFile: P.main.filePath,
            }, reqId);
            return;
          }
          if (phase === 2 && payload.requestId === reqId) {
            clearTimeout(timer); try { ws.close(); } catch (e) {}
            const code = payload.status && payload.status.code;
            const r = payload.result || {};
            if (code === 1) {
              resolve({ ok: true, pdfUrl: r.pdfUrl, pdfSize: r.pdfSize, logUrl: r.logUrl, raw: r });
            } else {
              resolve({ ok: false, errorType: r.errorType || 'code_' + code,
                message: (payload.status && payload.status.message) || r.message, raw: r });
            }
          }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('socket error')); };
      });
    })()`
  );
  return result;
}
async function resolveFile(page, ref, path) {
  const tree = await texGet(
    page,
    `/api/project/fileTree?ownerKey=${ref.ownerKey}&projectKey=${ref.projectKey}&versionNo=${ref.versionNo}`
  );
  const file = (tree?.treeData || []).find((f) => f.filePath === path && !f.isDir);
  if (!file) throw new Error(`File not found: ${path} (see \`opencli texpage files "${ref.projectName}"\`)`);
  return file.fileKey;
}
// Locally adapted from dull-bird/opencli-plugin-texpage (MIT; see LICENSE).
// Add a joined-document text precondition and reject malformed/denied joins.
async function replaceDocContent(page, ref, fileKey, text, timeoutMs = 3e4, expectedText) {
  return page.evaluate(
    `(async () => {
      const P = ${JSON.stringify({ ...ref, fileKey, text, expectedText })};
      const CHUNK = 200;
      const extent = (s) => {
        const parts = s.split('\\n');
        return { row: parts.length - 1, column: parts[parts.length - 1].length };
      };
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket');
        let phase = 0;
        const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('write timeout')); }, ${timeoutMs});
        const send = (arr) => ws.send('42' + JSON.stringify(arr));
        const expected = [];
        let acked = [];
        ws.onopen = () => ws.send('40');
        ws.onmessage = async (ev) => {
          const d = String(ev.data);
          if (d === '2') { ws.send('3'); return; }
          if (d.startsWith('40') && phase === 0) {
            phase = 1;
            send(['request', { request: { requestId: 'j1', action: 'post:/api/project/joinRoom' },
              data: { projectKey: P.projectKey, versionNo: P.versionNo } }]);
            return;
          }
          if (phase === 1 && d.includes('"j1"')) {
            const joined = JSON.parse(d.slice(2))[1];
            if (joined.requestId !== 'j1' || joined.status?.code !== 1) {
              clearTimeout(timer); ws.close(); reject(new Error('joinRoom denied')); return;
            }
            phase = 2;
            send(['joinDoc', { fileKey: P.fileKey, ownerKey: P.ownerKey,
              projectKey: P.projectKey, versionNo: P.versionNo, v: 'chunk' }]);
            return;
          }
          if (phase === 2 && d.includes('joinedDoc')) {
            phase = 2.5;
            const ops = JSON.parse(d.slice(2))[1]?.data?.operations;
            if (!Array.isArray(ops)) {
              clearTimeout(timer); ws.close(); reject(new Error('Invalid joinedDoc operations')); return;
            }
            try {
              if (typeof P.expectedText !== 'string') throw new Error('Missing write precondition');
              const url = '/api/project/file?' + new URLSearchParams({
                fileKey: P.fileKey, projectKey: P.projectKey, versionNo: P.versionNo });
              const response = await fetch(url, { credentials: 'include' });
              if (!response.ok || await response.text() !== P.expectedText) {
                throw new Error('VERSION_CONFLICT: document changed before CRDT write');
              }
            } catch (error) {
              clearTimeout(timer); ws.close(); reject(error); return;
            }
            const maxSeqs = {};
            for (const o of ops) {
              if (o.spliceId) maxSeqs[o.spliceId.site] = Math.max(maxSeqs[o.spliceId.site] || 0, o.spliceId.seq);
            }
            // Use a fresh random siteId per write. The app uses userKey as its
            // siteId; reusing it here would collide seq numbers with a
            // concurrently open editor and corrupt its CRDT state
            // ("\u6587\u6863\u6570\u636E\u5F02\u5E38" dialog + read-only editor there).
            const site = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
            const base = 1;
            const chunks = [];
            let chunk = '';
            for (const character of P.text) {
              if (chunk.length + character.length > CHUNK) { chunks.push(chunk); chunk = ''; }
              chunk += character;
            }
            if (chunk) chunks.push(chunk);
            const outOps = [];
            chunks.forEach((chunk, i) => {
              const spliceId = { site, seq: base + i };
              const op = { type: 'splice', spliceId };
              if (i === 0) {
                op.deletion = {
                  spliceId,
                  leftDependencyId: { site: 0, seq: 0 },
                  offsetInLeftDependency: { row: 0, column: 0 },
                  rightDependencyId: { site: 0, seq: 1 },
                  offsetInRightDependency: { row: 0, column: 0 },
                  maxSeqsBySite: maxSeqs,
                };
                op.insertion = {
                  text: chunk,
                  leftDependencyId: { site: 0, seq: 0 },
                  offsetInLeftDependency: { row: 0, column: 0 },
                  rightDependencyId: { site: 0, seq: 1 },
                  offsetInRightDependency: { row: 0, column: 0 },
                };
              } else {
                op.insertion = {
                  text: chunk,
                  leftDependencyId: { site, seq: base + i - 1 },
                  offsetInLeftDependency: extent(chunks[i - 1]),
                  rightDependencyId: { site: 0, seq: 1 },
                  offsetInRightDependency: { row: 0, column: 0 },
                };
              }
              expected.push(P.fileKey + '.' + spliceId.seq + '.splice');
              outOps.push({ fileKey: P.fileKey, versionNo: P.versionNo, operation: op });
            });
            if (outOps.length === 0) {
              // Empty replacement content: single deletion-only splice
              const spliceId = { site, seq: base };
              expected.push(P.fileKey + '.' + spliceId.seq + '.splice');
              outOps.push({ fileKey: P.fileKey, versionNo: P.versionNo, operation: {
                type: 'splice', spliceId,
                deletion: { spliceId, leftDependencyId: { site: 0, seq: 0 },
                  offsetInLeftDependency: { row: 0, column: 0 },
                  rightDependencyId: { site: 0, seq: 1 },
                  offsetInRightDependency: { row: 0, column: 0 }, maxSeqsBySite: maxSeqs },
              }});
            }
            phase = 3;
            send(['operations', { syncType: 'sync', operations: outOps }]);
            return;
          }
          if (phase === 3 && d.startsWith('42') && d.includes('mergedOperations')) {
            try {
              const ids = JSON.parse(d.slice(2))[1] || [];
              acked = acked.concat(ids);
              if (expected.every((x) => acked.includes(x))) {
                clearTimeout(timer); try { ws.close(); } catch (e) {}
                resolve({ chunks: expected.length, acked });
              }
            } catch (e) {}
          }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('socket error')); };
      });
    })()`
  );
}
function parseLog(log) {
  const lines = log.split("\n");
  const errors = [];
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning|pdfTeX warning/i.test(l)) {
      warnings.push(l.trim().slice(0, 200));
    } else if (l.startsWith("!")) {
      errors.push([l, lines[i + 1] || "", lines[i + 2] || ""].join(" ").trim().slice(0, 300));
    } else if (/^(?:\.?\/|\w)[^\s()]*\.\w+:\d+: /.test(l)) {
      errors.push(l.trim().slice(0, 300));
    }
  }
  return { errors, warnings };
}
export {
  DOMAIN,
  SITE,
  compileViaSocket,
  cookieHeader,
  parseLog,
  replaceDocContent,
  resolveFile,
  resolveProject,
  texFetch,
  texGet
};
