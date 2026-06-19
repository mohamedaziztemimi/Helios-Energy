
const API_BASE_URL = "http://127.0.0.1:8000";
// sessionStorage keys (NOT localStorage — auto-clears when the tab closes,
// which is the desired behavior for a session-only hiring demo).
const SS_KEY_KEY = 'invertix.accessKey';
const SS_USER_KEY = 'invertix.userId';

function _ssGet(k) {
  try { return (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(k) : null; }
  catch (e) { return null; }
}
function _ssSet(k, v) {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(k, v); } catch (e) {}
}
function _ssDel(k) {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(k); } catch (e) {}
}

class Component extends DCLogic {
  companyNames = {
    company_1: 'Helios Renewables',
    company_2: 'Aurora Grid Energy',
  };

  users = [];

  fmtMeta = {
    pdf:  { label:'PDF',  color:'#f0716a' },
    docx: { label:'DOCX', color:'#5b8def' },
    xlsx: { label:'XLSX', color:'#5fd08a' },
  };

  constructor(props) {
    super(props);
    // If sessionStorage has BOTH a key and a user id (an in-tab refresh),
    // start in a transient 'restoring' view that immediately re-validates.
    // While restoring we still treat ourselves as 'gate'-equivalent for the
    // template (isGate=true) so nothing flashes; if validation succeeds we
    // jump straight to 'app', otherwise we fall back to the gate input.
    const savedKey = _ssGet(SS_KEY_KEY);
    const savedUser = _ssGet(SS_USER_KEY);
    const designStart = props && props.startView; // 'login' or 'app' for editor preview
    let start = designStart || 'gate';
    if (!designStart && savedKey && savedUser) start = 'restoring';

    this.state = {
      view: start, user: null,
      messages: [], running: false, trace: [], input: '', toast: '',
      sessionId: null, usersLoading: false, usersError: '',
      accessKey: '', gateInput: '', gateError: '', gateBusy: false,
    };
    this._timers = [];
    this._msgSeq = 0; // monotonic id source for stable message identity
    this._restorePending = (start === 'restoring')
      ? { key: savedKey, userId: savedUser } : null;
  }

  componentDidMount() {
    if (this._restorePending) {
      this._restoreFromSession(this._restorePending);
      this._restorePending = null;
      return;
    }
    if (this.state.view !== 'gate') {
      this.fetchUsers('');
    }
  }

  // Re-validate the saved key against /api/users — if it succeeds, jump
  // straight to the app view with the saved user pre-selected.
  _restoreFromSession({ key, userId }) {
    fetch(API_BASE_URL + '/api/users', { headers: { 'X-Demo-Key': key } })
      .then(r => {
        if (r.status === 403) {
          _ssDel(SS_KEY_KEY); _ssDel(SS_USER_KEY);
          this.setState({ view: 'gate', accessKey: '', gateError: '' });
          return null;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(raw => {
        if (raw === null) return;
        this.users = (raw || []).map(u => this.mapApiUser(u));
        const saved = this.users.find(u => u.id === userId);
        if (!saved) {
          // The userId from the previous tab session is no longer in the
          // user list (could happen if backend re-seeded). Drop straight
          // to the login picker rather than the gate.
          _ssDel(SS_USER_KEY);
          this.setState({ accessKey: key, view: 'login' });
          return;
        }
        this.setState({
          accessKey: key, view: 'app', user: saved,
          messages: [], running: false, trace: [], input: '', sessionId: null,
        });
        this.loadHistory(saved.id);
      })
      .catch(err => {
        // Network error — fall back to gate; the user can retype the key.
        _ssDel(SS_KEY_KEY); _ssDel(SS_USER_KEY);
        this.setState({
          view: 'gate', accessKey: '',
          gateError: 'Session restore failed — ' + (err.message || err),
        });
      });
  }

  _apiHeaders(userId, extra) {
    const h = Object.assign({}, extra || {});
    if (this.state.accessKey) h['X-Demo-Key'] = this.state.accessKey;
    if (userId) h['Authorization'] = 'Bearer ' + userId;
    return h;
  }

  fetchUsers(keyOverride) {
    const keyForHeader = keyOverride || this.state.accessKey;
    const headers = {};
    if (keyForHeader) headers['X-Demo-Key'] = keyForHeader;
    this.setState({ usersLoading: true });
    return fetch(API_BASE_URL + '/api/users', { headers })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(raw => {
        this.users = (raw || []).map(u => this.mapApiUser(u));
        this.setState({ usersLoading: false, usersError: '' });
      })
      .catch(err => {
        this.users = [];
        const msg = 'Could not load users from ' + API_BASE_URL + ' — ' + (err.message || err);
        this.setState({ usersLoading: false, usersError: msg, toast: msg });
        clearTimeout(this._toast);
        this._toast = setTimeout(() => this.setState({ toast:'' }), 5000);
      });
  }

  unlock() {
    const key = (this.state.gateInput || '').trim();
    if (!key) { this.setState({ gateError: 'Please enter an access key.' }); return; }
    if (this.state.gateBusy) return;
    this.setState({ gateBusy: true, gateError: '' });

    fetch(API_BASE_URL + '/api/users', { headers: { 'X-Demo-Key': key } })
      .then(r => {
        if (r.status === 403) {
          this.setState({ gateBusy: false, gateError: 'Incorrect access key.' });
          return null;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(raw => {
        if (raw === null) return;
        this.users = (raw || []).map(u => this.mapApiUser(u));
        _ssSet(SS_KEY_KEY, key);
        this.setState({
          accessKey: key, view: 'login',
          gateBusy: false, gateError: '', gateInput: '',
          usersLoading: false, usersError: '',
        });
      })
      .catch(err => {
        this.setState({ gateBusy: false, gateError: 'Could not validate access key — ' + (err.message || err) });
      });
  }

  mapApiUser(u) {
    const local = (u.email || '').split('@')[0] || u.id || '';
    const parts = local.split(/[._-]+/).filter(Boolean);
    const name = parts.length
      ? parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
      : (u.id || '');
    const initials = parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : (parts[0] || u.id || '??').slice(0, 2).toUpperCase();
    const companyName = this.companyNames[u.company_id] || u.company_id;
    return {
      id: u.id, name, initials, email: u.email || '',
      company: u.company_id, companyName,
      role: u.role || '', access: u.access_scope || '',
    };
  }

  componentWillUnmount() { this.clearTimers(); clearTimeout(this._toast); }
  componentDidUpdate() {
    if (this._scrollNext) { this._scrollNext = false; if (this._scroll) this._scroll.scrollTop = this._scroll.scrollHeight; }
  }
  clearTimers() {
    (this._timers || []).forEach(clearTimeout);
    this._timers = [];
    clearInterval(this._tick);
    try { if (this._es) { this._es.close(); this._es = null; } } catch (e) {}
  }

  nf(n) { return (typeof n === 'number' ? n : 0).toLocaleString('en-US'); }
  fmtT(ms) { const d = new Date(ms); const p = (n, l) => String(n).padStart(l || 2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }

  mapLine(l) {
    const M = {
      info:     { c:'#6b7480', t:'#aeb6c2' },
      tool:     { c:'#f5a623', t:'#f5c06b' },
      query:    { c:'#3a424d', t:'#6b7480' },
      result:   { c:'#5fd08a', t:'#86c7a4' },
      ok:       { c:'#5fd08a', t:'#86c7a4' },
      deny:     { c:'#f0716a', t:'#f0a09a' },
      warn:     { c:'#f5a623', t:'#f5c06b' },
      code:     { c:'#a78bfa', t:'#c4b1ff' },
      artifact: { c:'#ffb84d', t:'#ffd486' },
    }[l.kind] || { c:'#6b7480', t:'#aeb6c2' };
    const G = {
      info:'▸', tool:'▸', query:'└─', result:'└─', ok:'✓', deny:'✕', warn:'!',
      code:'▶', artifact:'◆',
    }[l.kind] || '·';
    return { t: l.t || this.fmtT(Date.now()), glyph: G, color: M.c, textColor: M.t, text: l.text, pad: ((l.indent || 0) * 18) + 'px' };
  }

  _mkId() { this._msgSeq += 1; return 'm' + this._msgSeq; }

  pick(u) {
    this.clearTimers();
    this._scrollNext = true;
    _ssSet(SS_USER_KEY, u.id);
    this.setState({ view:'app', user:u, messages:[], running:false, trace:[], input:'', sessionId:null });
    this.loadHistory(u.id);
  }
  switchUser() {
    this.clearTimers();
    _ssDel(SS_USER_KEY);
    this.setState({ view:'login', user:null, messages:[], running:false, trace:[], input:'', sessionId:null });
  }
  // BUG FIX: previously this used the iteration index, which created subtle
  // stale-closure issues when the messages array was rebuilt across
  // loadHistory + new runs (the index baked into one render's closure no
  // longer pointed at the same message after a later render shuffled refs
  // around). Look up by a stable per-message _id instead.
  toggleTrace(id) {
    this.setState(st => ({
      messages: st.messages.map(m => m._id === id
        ? Object.assign({}, m, { traceOpen: !m.traceOpen })
        : m),
    }));
  }

  classifyLine(raw) {
    if (/generate_pdf|generate_word|generate_docx|generate_excel|generate_xlsx/i.test(raw)) return 'artifact';
    if (/run_python|python_repl|exec_python/i.test(raw)) return 'code';
    if (/error|exception|traceback|fail|denied|blocked/i.test(raw)) return 'deny';
    if (/^\s*\[tools?\b/i.test(raw)) return 'tool';
    if (/^\s*\[agent\b/i.test(raw)) return 'info';
    if (/^\s*SELECT\b|^\s*INSERT\b|^\s*UPDATE\b|^\s*DELETE\b|^\s*WITH\b/i.test(raw)) return 'query';
    if (/complete|done|ok\b/i.test(raw)) return 'result';
    return 'info';
  }

  pushOutputLines(newText) {
    const lines = newText.split(/\r?\n/).filter(l => l.length > 0);
    if (lines.length === 0) return;
    const ts = this.fmtT(Date.now());
    const steps = lines.map(l => ({ kind: this.classifyLine(l), text: l, indent: 0, t: ts }));
    this._scrollNext = true;
    this.setState(st => ({ trace: st.trace.concat(steps) }));
  }

  send() {
    const q = (this.state.input || '').trim();
    if (!q || this.state.running) return;
    if (!this.state.user) return;
    const userId = this.state.user.id;
    const sessionId = this.state.sessionId;

    this._scrollNext = true;
    this.setState(st => ({
      messages: st.messages.concat([{ _id: this._mkId(), role:'user', text:q }]),
      input:'', running:true, trace:[],
    }));
    this._start = Date.now();
    this._finalizedRunId = null; // new run — clear finalize guard
    this._activeBubbleId = null; // and the in-progress-bubble pointer
    this.clearTimers();
    this._tick = setInterval(() => this.forceUpdate(), 100);

    fetch(API_BASE_URL + '/api/chat', {
      method: 'POST',
      headers: this._apiHeaders(userId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: q, session_id: sessionId || undefined }),
    })
    .then(r => { if (!r.ok) return r.text().then(t => { throw new Error('HTTP ' + r.status + ': ' + t.slice(0,200)); }); return r.json(); })
    .then(({ run_id, session_id }) => {
      this.setState({ sessionId: session_id });
      this._runId = run_id;
      this.streamRun(run_id, userId);
    })
    .catch(err => this.handleRunError(err));
  }

  // Show or update the in-progress agent bubble as soon as final_text is
  // non-null. The bubble's answer follows the latest final_text the backend
  // returns — the agent may revise its answer mid-run (e.g. recover from a
  // SQL error), and the chat should reflect the latest text, not freeze on
  // the first version. Trace stays in the live panel below until finishRun.
  _showOrUpdateBubble(finalText, output) {
    const runId = this._runId || '';
    if (this._activeBubbleId) {
      const id = this._activeBubbleId;
      this.setState(st => ({
        messages: st.messages.map(m =>
          m._id === id ? Object.assign({}, m, { answer: finalText }) : m
        ),
      }));
      return;
    }
    const id = this._mkId();
    this._activeBubbleId = id;
    this._scrollNext = true;
    const files = this.extractGeneratedFiles(output || '')
      .map(f => Object.assign({}, f, { runId: f.runId || runId }));
    this.setState(st => ({
      messages: st.messages.concat([{
        _id: id, role: 'agent',
        trace: st.trace.slice(),           // snapshot for the toggle while pending
        traceTime: '', traceOpen: false,
        answer: finalText, notice: '', metrics: [], report: null,
        files, pending: true,
      }]),
    }));
  }

  streamRun(runId, userId, initialOutputLen) {
    let url = API_BASE_URL + '/api/runs/' + encodeURIComponent(runId)
      + '/stream?user_id=' + encodeURIComponent(userId);
    if (this.state.accessKey) url += '&demo_key=' + encodeURIComponent(this.state.accessKey);
    let es;
    try { es = new EventSource(url); }
    catch (e) { this.pollRun(runId, userId, initialOutputLen); return; }
    this._es = es;
    let lastLen = initialOutputLen || 0;
    let fellBack = false;
    es.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.error && !data.status) { try { es.close(); } catch(e){} this.handleRunError(new Error(data.error)); return; }
      const output = data.output || '';
      if (output.length > lastLen) {
        this.pushOutputLines(output.slice(lastLen));
        lastLen = output.length;
      }
      const ft = (typeof data.final_text === 'string' && data.final_text.trim()) ? data.final_text.trim() : '';
      if (ft) this._showOrUpdateBubble(ft, output);
      if (data.status === 'completed' || data.status === 'failed') {
        try { es.close(); } catch(e){}
        this.finishRun(data.status, output, data.error, data.final_text);
      }
    };
    es.onerror = () => {
      if (fellBack) return;
      fellBack = true;
      try { es.close(); } catch (e) {}
      this._es = null;
      this.pollRun(runId, userId, lastLen);
    };
  }

  pollRun(runId, userId, initialOutputLen) {
    let lastLen = initialOutputLen || 0;
    const tick = () => {
      if (!this.state.running) return;
      fetch(API_BASE_URL + '/api/runs/' + encodeURIComponent(runId), {
        headers: this._apiHeaders(userId),
      })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(data => {
        if (!this.state.running) return;
        if (data.error && !data.status) { this.handleRunError(new Error(data.error)); return; }
        const output = data.output || '';
        if (output.length > lastLen) {
          this.pushOutputLines(output.slice(lastLen));
          lastLen = output.length;
        }
        const ft = (typeof data.final_text === 'string' && data.final_text.trim()) ? data.final_text.trim() : '';
        if (ft) this._showOrUpdateBubble(ft, output);
        if (data.status === 'completed' || data.status === 'failed') {
          this.finishRun(data.status, output, data.error, data.final_text);
        } else {
          const t = setTimeout(tick, 1500);
          this._timers.push(t);
        }
      })
      .catch(err => this.handleRunError(err));
    };
    tick();
  }

  extractGeneratedFiles(output) {
    if (!output) return [];
    const palette = {
      pdf:   { label:'PDF',   color:'#f0716a', bgColor:'#f0716a1a', borderColor:'#f0716a40' },
      word:  { label:'WORD',  color:'#5b8def', bgColor:'#5b8def1a', borderColor:'#5b8def40' },
      excel: { label:'EXCEL', color:'#5fd08a', bgColor:'#5fd08a1a', borderColor:'#5fd08a40' },
    };
    const files = [];
    const seen = new Set();
    for (const line of output.split(/\r?\n/)) {
      let type = /generate_pdf/i.test(line) ? 'pdf'
              : /generate_word|generate_docx/i.test(line) ? 'word'
              : /generate_excel|generate_xlsx/i.test(line) ? 'excel' : null;
      if (!type) continue;
      const extPat = type === 'pdf' ? 'pdf' : (type === 'word' ? 'docx?' : 'xlsx?');
      const rx = new RegExp("[A-Za-z0-9_./\\\\:\\- ]+\\.(?:" + extPat + ")\\b", 'i');
      const m = line.match(rx);
      let path = m ? m[0].trim() : '';
      if (!path) {
        const fm = line.match(/['"]filename['"]\s*:\s*['"]([^'"]+)['"]/i);
        if (fm) path = fm[1];
      }
      if (!path) continue;
      const displayPath = path.replace(/\\\\/g, '/').replace(/\\/g, '/');
      const key = type + ':' + displayPath;
      if (seen.has(key)) continue;
      seen.add(key);
      const segs = displayPath.split('/').filter(Boolean);
      const name = segs[segs.length - 1] || displayPath;
      const runId = segs.length >= 2 ? segs[segs.length - 2] : '';
      files.push(Object.assign({ type, path: displayPath, name, runId }, palette[type]));
    }
    return files;
  }

  _downloadFile(file) {
    if (!file || !file.name) return;
    const userId = this.state.user && this.state.user.id;
    if (!userId) return;
    const runId = file.runId || this._runId;
    if (!runId) {
      this.setState({ toast: 'Cannot download — run id missing.' });
      return;
    }
    const url = API_BASE_URL + '/api/runs/' + encodeURIComponent(runId)
      + '/files/' + encodeURIComponent(file.name);
    this.setState({ toast: 'Downloading ' + file.name + '…' });
    fetch(url, { headers: this._apiHeaders(userId) })
      .then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error('HTTP ' + r.status + ': ' + t.slice(0,160)); });
        return r.blob();
      })
      .then(blob => {
        const bUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = bUrl; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(bUrl), 4000);
        this.setState({ toast: 'Downloaded ' + file.name });
        clearTimeout(this._toast);
        this._toast = setTimeout(() => this.setState({ toast: '' }), 2800);
      })
      .catch(err => {
        this.setState({ toast: 'Download failed — ' + (err.message || err) });
        clearTimeout(this._toast);
        this._toast = setTimeout(() => this.setState({ toast: '' }), 4500);
      });
  }

  finishRun(status, output, error, finalText) {
    if (this._finalizedRunId && this._finalizedRunId === this._runId) return;
    this._finalizedRunId = this._runId;
    clearInterval(this._tick);
    const traceTime = ((Date.now() - this._start) / 1000).toFixed(1) + 's';
    const rawFiles = this.extractGeneratedFiles(output || '');
    const runId = this._runId || '';
    const files = rawFiles.map(f => Object.assign({}, f, { runId: f.runId || runId }));
    const cleanFinal = (typeof finalText === 'string' && finalText.trim()) ? finalText.trim() : '';
    let answer;
    if (status === 'failed') {
      answer = cleanFinal || ('Agent run failed: ' + (error || 'unknown error'));
    } else if (cleanFinal) {
      answer = cleanFinal;
    } else if (files.length) {
      answer = 'Run completed in ' + traceTime + '. ' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' generated (shown below).';
    } else {
      answer = 'Run completed in ' + traceTime + '. Expand the trace below to see the agent’s reasoning and tool calls.';
    }

    const activeId = this._activeBubbleId;
    this._activeBubbleId = null;
    this._scrollNext = true;
    this.setState(st => {
      // If we already surfaced a bubble for this run mid-stream, finalize
      // it in place: lock in the final answer, attach the full trace, drop
      // the "pending" flag. Otherwise (no final_text ever arrived mid-run)
      // push a fresh bubble now.
      if (activeId) {
        return {
          messages: st.messages.map(m => m._id === activeId ? Object.assign({}, m, {
            answer, trace: st.trace, traceTime, files, pending: false,
          }) : m),
          running: false, trace: [],
        };
      }
      return {
        messages: st.messages.concat([{
          _id: this._mkId(),
          role: 'agent',
          trace: st.trace, traceTime, traceOpen: false,
          answer, notice: '', metrics: [], report: null,
          files, pending: false,
        }]),
        running: false, trace: [],
      };
    });
  }

  handleRunError(err) {
    if (this._finalizedRunId && this._finalizedRunId === this._runId) return;
    this._finalizedRunId = this._runId;
    clearInterval(this._tick);
    try { if (this._es) { this._es.close(); this._es = null; } } catch(e){}
    const traceTime = ((Date.now() - this._start) / 1000).toFixed(1) + 's';
    const errMsg = 'Request failed: ' + (err && err.message ? err.message : String(err));
    const activeId = this._activeBubbleId;
    this._activeBubbleId = null;
    this._scrollNext = true;
    this.setState(st => {
      if (activeId) {
        return {
          messages: st.messages.map(m => m._id === activeId ? Object.assign({}, m, {
            answer: errMsg, trace: st.trace, traceTime, pending: false,
          }) : m),
          running: false, trace: [],
        };
      }
      return {
        messages: st.messages.concat([{
          _id: this._mkId(),
          role:'agent',
          trace: st.trace, traceTime, traceOpen:false,
          answer: errMsg, notice: '', metrics: [], report: null, files: [],
          pending: false,
        }]),
        running:false, trace:[],
      };
    });
  }

  loadHistory(userId) {
    fetch(API_BASE_URL + '/api/runs', { headers: this._apiHeaders(userId) })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(runs => {
        if (!Array.isArray(runs) || runs.length === 0) return;

        // The backend now runs agents in a detached background thread, so a
        // run can still be 'running' (with no final_text yet) after a tab
        // close + reopen. The MOST RECENT such run is the one the user was
        // mid-conversation with — reconnect to its stream/poll so the final
        // answer arrives in-place when it finishes.
        const ordered = runs.slice().reverse();          // chronological
        const newest = runs[0] || null;                  // most-recent-first
        const newestIsLive = newest
          && newest.status === 'running'
          && !(typeof newest.final_text === 'string' && newest.final_text.trim());

        const messages = [];
        for (const run of ordered) {
          if (!run) continue;
          // Skip the live run from the static transcript — we'll re-show its
          // input + live trace + (eventual) finishRun bubble for it.
          if (newestIsLive && run.id === newest.id) continue;
          if (run.input) messages.push({ _id: this._mkId(), role:'user', text: run.input });
          messages.push(this._messageFromHistory(run));
        }

        // Continue the most-recent session_id so the next POST /api/chat
        // groups onto that thread.
        const latestForSession = ordered[ordered.length - 1];
        const newState = {
          messages,
          sessionId: latestForSession && latestForSession.session_id ? latestForSession.session_id : null,
        };

        if (newestIsLive) {
          // Push the live run's input as a user message
          if (newest.input) messages.push({ _id: this._mkId(), role:'user', text: newest.input });
          // Pre-populate the live trace with what already streamed
          const initialOutput = newest.output || '';
          newState.messages = messages;
          newState.running = true;
          newState.trace = this._traceFromOutput(initialOutput);
          this._runId = newest.id;
          this._start = newest.created_at ? Date.parse(newest.created_at) : Date.now();
          this._finalizedRunId = null;
          this._activeBubbleId = null;
          // If the still-running run already has a non-null final_text in
          // history, surface it as a bubble right away instead of waiting
          // for the stream's first frame.
          const histFt = (typeof newest.final_text === 'string' && newest.final_text.trim()) ? newest.final_text.trim() : '';
          if (histFt) {
            const id = this._mkId();
            this._activeBubbleId = id;
            const runId = newest.id;
            const histFiles = this.extractGeneratedFiles(initialOutput)
              .map(f => Object.assign({}, f, { runId: f.runId || runId }));
            messages.push({
              _id: id, role: 'agent',
              trace: newState.trace.slice(),
              traceTime: '', traceOpen: false,
              answer: histFt, notice: '', metrics: [], report: null,
              files: histFiles, pending: true,
            });
          }
        }

        this._scrollNext = true;
        this.setState(newState);

        if (newestIsLive) {
          this._tick = setInterval(() => this.forceUpdate(), 100);
          this.streamRun(newest.id, userId, (newest.output || '').length);
        }
      })
      .catch(err => {
        this.setState({ toast: 'Could not load history — ' + (err.message || err) });
        clearTimeout(this._toast);
        this._toast = setTimeout(() => this.setState({ toast:'' }), 4000);
      });
  }

  _traceFromOutput(output) {
    const ts = this.fmtT(Date.now());
    return (output || '').split(/\r?\n/).filter(l => l.length > 0)
      .map(l => ({ kind: this.classifyLine(l), text: l, indent: 0, t: ts }));
  }

  _messageFromHistory(run) {
    const output = run.output || '';
    const ts = run.created_at ? this.fmtT(Date.parse(run.created_at)) : this.fmtT(Date.now());
    const lines = output.split(/\r?\n/).filter(l => l.length > 0);
    const trace = lines.map(l => ({ kind: this.classifyLine(l), text: l, indent: 0, t: ts }));
    const rawFiles = this.extractGeneratedFiles(output);
    const files = rawFiles.map(f => Object.assign({}, f, { runId: f.runId || run.id }));
    let traceTime = '';
    if (run.created_at && run.updated_at) {
      const ms = Date.parse(run.updated_at) - Date.parse(run.created_at);
      if (ms > 0) traceTime = (ms / 1000).toFixed(1) + 's';
    }
    // Prefer the backend's extracted final_text. This is the same path the
    // live finishRun uses, so refresh and live show the SAME answer.
    const cleanFinal = (typeof run.final_text === 'string' && run.final_text.trim()) ? run.final_text.trim() : '';
    let answer;
    if (cleanFinal) {
      answer = cleanFinal;
    } else if (run.status === 'failed') {
      answer = 'Agent run failed.';
    } else if (run.status === 'running') {
      answer = 'Run still in progress…';
    } else {
      answer = files.length
        ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' generated (shown below). Expand the trace to see the agent’s tool calls.'
        : 'Run completed' + (traceTime ? ' in ' + traceTime : '') + '. Expand the agent trace below to see the full reasoning and tool calls.';
    }
    return {
      _id: this._mkId(),
      role:'agent', trace, traceTime, traceOpen:false,
      answer, notice:'', metrics:[], report:null, files,
    };
  }

  download(report) {
    const name = report && report.slug ? report.slug : 'report';
    this.setState({ toast: 'File download not yet available — ' + name });
    clearTimeout(this._toast);
    this._toast = setTimeout(() => this.setState({ toast:'' }), 2800);
  }

  renderVals() {
    const accClr = a => a === 'energy+financial'
      ? { color:'#f5a623', bg:'#f5a6231a', border:'#f5a62340' }
      : { color:'#8fb8a0', bg:'#5fd08a14', border:'#5fd08a33' };
    const accLabel = a => a === 'energy+financial' ? 'energy + financial' : (a || 'energy');

    const cids = [];
    (this.users || []).forEach(u => { if (cids.indexOf(u.company) === -1) cids.push(u.company); });
    const companyGroups = cids.map(cid => ({
      name: this.companyNames[cid] || cid,
      users: this.users.filter(u => u.company === cid).map(u => {
        const c = accClr(u.access);
        return Object.assign({}, u, {
          roleLabel: (u.role || '').toUpperCase(), accessLabel: accLabel(u.access),
          accessColor: c.color, accessBg: c.bg, accessBorder: c.border,
          pick: () => this.pick(u),
        });
      }),
    }));

    const u = this.state.user || {};
    const uc = accClr(u.access);

    const sugTexts = [
      'How many plants do I have and what is their total nominal capacity?',
      'Generate a PDF report summarizing my plants’ energy production this month.',
      'Which of my plants produced the most energy in the last 7 days?',
      'Use Python to compute the daily generation breakdown across all my plants.',
    ];
    const suggestions = sugTexts.map(t => ({ text: t, ask: () => this.setState({ input: t }, () => this.send()) }));

    const msgs = this.state.messages.map((m) => {
      if (m.role === 'user') return { isUser:true, isAgent:false, text:m.text };
      // Bind toggle by the message's stable id, NOT by index. This fixes
      // the trace-expand bug where later messages' onclick still pointed at
      // the wrong message after the array was rebuilt by loadHistory.
      const mid = m._id;
      return {
        isUser:false, isAgent:true, answer:m.answer,
        hasNotice: !!m.notice, notice: m.notice || '',
        hasMetrics: (m.metrics || []).length > 0, metrics: m.metrics || [],
        hasFiles: (m.files || []).length > 0,
        files: (m.files || []).map(f => Object.assign({}, f, { onClick: () => this._downloadFile(f) })),
        hasReport: false, report: null,
        trace: (m.trace || []).map(l => this.mapLine(l)), traceCount: (m.trace || []).length,
        traceTime: m.traceTime || '', traceOpen: !!m.traceOpen, caret: m.traceOpen ? ' ▾' : ' ▸',
        toggleLabel: m.traceOpen ? 'hide trace' : 'show trace',
        toggle: () => this.toggleTrace(mid),
      };
    });

    const canSend = !this.state.running && (this.state.input || '').trim().length > 0 && !!this.state.user;
    const gateCanSubmit = !this.state.gateBusy && (this.state.gateInput || '').trim().length > 0;

    // Treat the transient 'restoring' view as gate-equivalent so the user
    // never sees a flash of login/app while the saved key re-validates.
    const isGateLike = this.state.view === 'gate' || this.state.view === 'restoring';

    return {
      isGate: isGateLike,
      gateInput: this.state.gateInput,
      gateError: this.state.gateError,
      hasGateError: !!this.state.gateError,
      gateBusy: this.state.gateBusy,
      gateDisabled: !gateCanSubmit,
      gateLabel: this.state.gateBusy ? 'Validating…' : 'Continue',
      gateBg: gateCanSubmit ? '#f5a623' : '#2a323c',
      gateOpacity: gateCanSubmit ? '1' : '0.55',
      gateCursor: gateCanSubmit ? 'pointer' : 'not-allowed',
      onGateInput: e => this.setState({ gateInput: e.target.value, gateError: '' }),
      onGateKey: e => { if (e.key === 'Enter') { e.preventDefault(); this.unlock(); } },
      unlock: () => this.unlock(),

      isLogin: this.state.view === 'login',
      isApp: this.state.view === 'app',
      companyGroups,
      companyName: u.companyName || '', userEmail: u.email || '', userInitials: u.initials || '',
      userRole: (u.role || '').toUpperCase(), userAccessLabel: accLabel(u.access),
      userAccessColor: uc.color, userAccessBg: uc.bg, userAccessBorder: uc.border,
      showEmpty: this.state.messages.length === 0 && !this.state.running,
      msgs,
      running: this.state.running,
      liveTrace: this.state.trace.map(l => this.mapLine(l)),
      liveElapsed: (this.state.running && this._start) ? ((Date.now() - this._start) / 1000).toFixed(1) + 's' : '0.0s',
      suggestions,
      input: this.state.input,
      onInput: e => this.setState({ input: e.target.value }),
      onKey: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } },
      send: () => this.send(),
      switchUser: () => this.switchUser(),
      setScrollRef: el => { this._scroll = el; },
      sendDisabled: !canSend,
      sendBg: canSend ? '#f5a623' : '#2a323c',
      sendOpacity: canSend ? '1' : '0.55',
      sendCursor: canSend ? 'pointer' : 'not-allowed',
      hasToast: !!this.state.toast, toast: this.state.toast,
    };
  }
}
