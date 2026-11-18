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
async function replaceDocContent(page, ref, fileKey, text, timeoutMs = 3e4, expectedText, site) {
  return page.evaluate(async ({ ownerKey, projectKey, versionNo, fileKey, text, timeoutMs, expectedText, site }) => {
    if (typeof expectedText !== 'string') throw new Error('Missing write precondition');
    if (typeof site !== 'string' || !site) throw new Error('Missing TeXPage editor identity');
    const chunkSize = 200;
    const batchSize = 100;
    const roomId = `${fileKey}_${versionNo}`;
    const fileUrl = '/api/project/file?' + new URLSearchParams({ fileKey, projectKey, versionNo });
    const origin = { row: 0, column: 0 };
    const extent = value => {
      const lines = value.split('\n');
      return { row: lines.length - 1, column: lines.at(-1).length };
    };

    return new Promise((resolve, reject) => {
      const socket = new WebSocket('wss://socket.texpage.com/socket.io/?EIO=4&transport=websocket');
      const controller = new AbortController();
      const timer = setTimeout(() => finish(new Error('TeXPage write timed out')), timeoutMs);
      const existing = [];
      const outOps = [];
      let phase = 'connect';
      let documentVersion, total, batchId;
      let ackId = 0;
      let offset = 0;
      const send = (event, data, id = '') => socket.send(`42${id}${JSON.stringify([event, data])}`);

      function finish(error) {
        if (phase === 'done') return;
        phase = 'done';
        clearTimeout(timer);
        controller.abort();
        socket.close();
        if (error) reject(error);
        else resolve({ chunks: outOps.length });
      }

      function sendBatch() {
        if (offset >= outOps.length) return finish();
        const operations = outOps.slice(offset, offset + batchSize);
        batchId = crypto.randomUUID();
        send('operations', { batchId, syncType: 'sync', operations, v: documentVersion,
          range: { start: origin, end: origin } }, ackId);
      }

      socket.onmessage = async ({ data }) => {
        if (phase === 'done' || typeof data !== 'string') return;
        try {
          if (data === '2') { socket.send('3'); return; }
          if (phase === 'connect' && data.startsWith('0')) { socket.send('40'); return; }
          if (phase === 'connect' && data.startsWith('40')) {
            phase = 'room';
            send('request', { request: { requestId: 'join', action: 'post:/api/project/joinRoom' },
              data: { projectKey, versionNo } });
            return;
          }
          const ack = data.match(/^43(\d+)(\[.*)$/s);
          if (phase === 'write' && ack?.[1] === String(ackId)) {
            const [result] = JSON.parse(ack[2]);
            if (result?.batchId !== batchId) throw new Error('Invalid TeXPage write acknowledgment');
            if (result.status !== 'ok') throw new Error(`TeXPage rejected write batch: ${result.status}`);
            offset += batchSize;
            ackId++;
            sendBatch();
            return;
          }
          if (!data.startsWith('42')) return;
          const [event, payload] = JSON.parse(data.slice(2));
          if (phase === 'room' && event === 'response' && payload?.requestId === 'join') {
            if (payload.status?.code !== 1) throw new Error('TeXPage project join denied');
            phase = 'doc';
            send('joinDoc', { fileKey, ownerKey, projectKey, versionNo, v: 'chunk' });
            return;
          }
          if (payload?.roomId !== roomId) return;
          if (event === 'clients' && Array.isArray(payload.data) &&
              payload.data.filter(client => client.userKey === site).length > 1) {
            throw new Error('VERSION_CONFLICT: close other TeXPage editors using this account before writing');
          }
          if (['refresh', 'refreshing', 'resetContent'].includes(event)) {
            throw new Error('VERSION_CONFLICT: TeXPage refreshed the document during the write');
          }
          if (phase !== 'doc' || event !== 'joinedDoc') return;

          const joined = payload.data;
          if (joined?.isLargeFile) throw new Error('TeXPage opened this document as a read-only large file');
          if (!Array.isArray(joined?.operations) || typeof joined.v !== 'string' || !joined.v) {
            throw new Error('Invalid TeXPage joinedDoc state');
          }
          const size = joined.total ?? joined.operations.length;
          documentVersion ??= joined.v;
          total ??= size;
          if (joined.v !== documentVersion || !Number.isSafeInteger(total) || size !== total ||
              existing.length + joined.operations.length > total) throw new Error('Invalid TeXPage document chunks');
          for (const operation of joined.operations) existing.push(operation);
          if (existing.length !== total) return;

          phase = 'check';
          const response = await fetch(fileUrl, { credentials: 'include', cache: 'no-store', signal: controller.signal });
          if (!response.ok || await response.text() !== expectedText) {
            throw new Error('VERSION_CONFLICT: document changed before CRDT write');
          }
          if (phase !== 'check') return;

          const maxSeqsBySite = Object.create(null);
          for (const { spliceId } of existing) {
            if (spliceId) maxSeqsBySite[spliceId.site] = Math.max(maxSeqsBySite[spliceId.site] || 0, spliceId.seq);
          }
          const initialSequence = maxSeqsBySite[site] || 0;
          const chunks = [];
          let chunk = '';
          for (const character of text) {
            if (chunk.length + character.length > chunkSize) { chunks.push(chunk); chunk = ''; }
            chunk += character;
          }
          if (chunk || !chunks.length) chunks.push(chunk);
          for (const [index, value] of chunks.entries()) {
            const spliceId = { site, seq: initialSequence + index + 1 };
            const bounds = { leftDependencyId: { site: 0, seq: 0 }, offsetInLeftDependency: origin,
              rightDependencyId: { site: 0, seq: 1 }, offsetInRightDependency: origin };
            const operation = { type: 'splice', spliceId };
            if (index === 0) operation.deletion = { ...bounds, spliceId, maxSeqsBySite };
            else {
              bounds.leftDependencyId = { site, seq: initialSequence + index };
              bounds.offsetInLeftDependency = extent(chunks[index - 1]);
            }
            if (value) operation.insertion = { ...bounds, text: value };
            outOps.push({ fileKey, versionNo, operation });
          }
          phase = 'write';
          sendBatch();
        } catch (error) { finish(error); }
      };
      socket.onerror = () => finish(new Error('TeXPage write socket error'));
      socket.onclose = () => finish(new Error('TeXPage write socket closed before acknowledgment'));
    });
  }, { ...ref, fileKey, text, timeoutMs, expectedText, site });
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
