
const API_BASE_URL = "http://127.0.0.1:8000";

class Component extends DCLogic {
  // Real backend tenant names (no fake plant data — the fleet rail was removed)
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
    // Three views: 'gate' (access-key splash, runtime default) → 'login'
    // (user picker, after key is validated) → 'app' (chat). Design-preview
    // props can jump directly to 'login' or 'app' without a key.
    const start = (props && props.startView) || 'gate';
    this.state = {
      view: start, user: null,
      messages: [], running: false, trace: [], input: '', toast: '',
      sessionId: null, usersLoading: false, usersError: '',
      // Gate state — accessKey lives in-memory only, never localStorage.
      accessKey: '', gateInput: '', gateError: '', gateBusy: false,
    };
    this._timers = [];
  }

  componentDidMount() {
    // The runtime entry view is 'gate' — wait for unlock() before fetching
    // /api/users. Only fetch immediately if a design-preview prop bypassed
    // the gate (startView='login' or 'app').
    if (this.state.view !== 'gate') {
      this.fetchUsers('');
    }
  }

  // Shared header builder — every authenticated fetch goes through this.
  _apiHeaders(userId, extra) {
    const h = Object.assign({}, extra || {});
    if (this.state.accessKey) h['X-Demo-Key'] = this.state.accessKey;
    if (userId) h['Authorization'] = 'Bearer ' + userId;
    return h;
  }

  fetchUsers(keyOverride) {
    // keyOverride is used during the gate validation, before accessKey is
    // committed to state (setState is async, so we can't rely on it yet).
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
      id: u.id, name, initials,
      email: u.email || '',
      company: u.company_id,
      companyName,
      role: u.role || '',
      access: u.access_scope || '',
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
      code:     { c:'#a78bfa', t:'#c4b1ff' },   // run_python — purple
      artifact: { c:'#ffb84d', t:'#ffd486' },   // generate_pdf/word/excel
    }[l.kind] || { c:'#6b7480', t:'#aeb6c2' };
    const G = {
      info:'▸', tool:'▸', query:'└─', result:'└─', ok:'✓', deny:'✕', warn:'!',
      code:'▶', artifact:'◆',
    }[l.kind] || '·';
    return { t: l.t || this.fmtT(Date.now()), glyph: G, color: M.c, textColor: M.t, text: l.text, pad: ((l.indent || 0) * 18) + 'px' };
  }

  pick(u) {
    this.clearTimers();
    this._scrollNext = true;
    this.setState({ view:'app', user:u, messages:[], running:false, trace:[], input:'', sessionId:null });
    // Load this user's past conversation so reopening the app doesn't show
    // the empty "Ask the analyst" state when there's history to recover.
    this.loadHistory(u.id);
  }

  loadHistory(userId) {
    fetch(API_BASE_URL + '/api/runs', { headers: this._apiHeaders(userId) })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(runs => {
        if (!Array.isArray(runs) || runs.length === 0) return; // truly new user — keep empty state
        // /api/runs returns most-recent-first; transcript reads oldest→newest top to bottom.
        const ordered = runs.slice().reverse();
        const messages = [];
        for (const run of ordered) {
          if (!run) continue;
          if (run.input) messages.push({ role:'user', text: run.input });
          messages.push(this._messageFromHistory(run));
        }
        // Continue the most-recent session_id by default — next POST /api/chat
        // groups onto that thread instead of forking a new one.
        const latest = ordered[ordered.length - 1];
        this._scrollNext = true;
        this.setState({ messages, sessionId: latest && latest.session_id ? latest.session_id : null });
      })
      .catch(err => {
        this.setState({ toast: 'Could not load history — ' + (err.message || err) });
        clearTimeout(this._toast);
        this._toast = setTimeout(() => this.setState({ toast:'' }), 4000);
      });
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
    let answer;
    if (run.status === 'failed') {
      answer = 'Agent run failed.';
    } else if (run.status === 'running') {
      answer = 'Run was still in progress when last loaded. Refresh or send a new message to continue.';
    } else {
      answer = files.length
        ? files.length + ' file' + (files.length > 1 ? 's' : '') + ' generated (shown below). Expand the trace to see the agent’s tool calls.'
        : 'Run completed' + (traceTime ? ' in ' + traceTime : '') + '. Expand the agent trace below to see the full reasoning and tool calls.';
    }
    return {
      role:'agent', trace, traceTime, traceOpen:false,
      answer, notice:'', metrics:[], report:null, files,
    };
  }
  switchUser() { this.clearTimers(); this.setState({ view:'login', user:null, messages:[], running:false, trace:[], input:'', sessionId:null }); }
  toggleTrace(i) { this.setState(st => ({ messages: st.messages.map((m, idx) => idx === i ? Object.assign({}, m, { traceOpen: !m.traceOpen }) : m) })); }

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
      messages: st.messages.concat([{ role:'user', text:q }]),
      input:'', running:true, trace:[],
    }));
    this._start = Date.now();
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

  streamRun(runId, userId) {
    // EventSource can't set custom headers, so the demo key piggybacks on
    // the query string alongside user_id. The backend middleware accepts
    // either X-Demo-Key header OR ?demo_key= query for /api/* routes.
    let url = API_BASE_URL + '/api/runs/' + encodeURIComponent(runId)
      + '/stream?user_id=' + encodeURIComponent(userId);
    if (this.state.accessKey) url += '&demo_key=' + encodeURIComponent(this.state.accessKey);
    let es;
    try { es = new EventSource(url); }
    catch (e) { this.pollRun(runId, userId); return; }
    this._es = es;
    let lastLen = 0;
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
      if (data.status === 'completed' || data.status === 'failed') {
        try { es.close(); } catch(e){}
        this.finishRun(data.status, output, data.error);
      }
    };
    es.onerror = () => {
      if (fellBack) return;
      fellBack = true;
      try { es.close(); } catch (e) {}
      this._es = null;
      this.pollRun(runId, userId);
    };
  }

  pollRun(runId, userId) {
    let lastLen = 0;
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
        if (data.status === 'completed' || data.status === 'failed') {
          this.finishRun(data.status, output, data.error);
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
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      let type = null;
      if (/generate_pdf/i.test(line)) type = 'pdf';
      else if (/generate_word|generate_docx/i.test(line)) type = 'word';
      else if (/generate_excel|generate_xlsx/i.test(line)) type = 'excel';
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
      // Backend writes to OUTPUT_DIR/<run_id>/<filename>, so the segment
      // immediately above the filename is the run_id.
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

  finishRun(status, output, error) {
    clearInterval(this._tick);
    const traceTime = ((Date.now() - this._start) / 1000).toFixed(1) + 's';
    const rawFiles = this.extractGeneratedFiles(output || '');
    // Stamp this run's id onto any file that didn't carry one in its path.
    const runId = this._runId || '';
    const files = rawFiles.map(f => Object.assign({}, f, { runId: f.runId || runId }));
    const answer = status === 'failed'
      ? ('Agent run failed: ' + (error || 'unknown error'))
      : (files.length
          ? 'Run completed in ' + traceTime + '. ' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' generated (shown below). Expand the trace to see the agent’s tool calls.'
          : 'Run completed in ' + traceTime + '. Expand the agent trace below to see the full reasoning and tool calls.');
    this._scrollNext = true;
    this.setState(st => ({
      messages: st.messages.concat([{
        role:'agent',
        trace: st.trace, traceTime, traceOpen:false,
        answer, notice: '', metrics: [], report: null,
        files,
      }]),
      running:false, trace:[],
    }));
  }

  handleRunError(err) {
    clearInterval(this._tick);
    try { if (this._es) { this._es.close(); this._es = null; } } catch(e){}
    const traceTime = ((Date.now() - this._start) / 1000).toFixed(1) + 's';
    this._scrollNext = true;
    this.setState(st => ({
      messages: st.messages.concat([{
        role:'agent',
        trace: st.trace, traceTime, traceOpen:false,
        answer: 'Request failed: ' + (err && err.message ? err.message : String(err)),
        notice: '', metrics: [], report: null, files: [],
      }]),
      running:false, trace:[],
    }));
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

    const msgs = this.state.messages.map((m, i) => {
      if (m.role === 'user') return { isUser:true, isAgent:false, text:m.text };
      return {
        isUser:false, isAgent:true, answer:m.answer,
        hasNotice: !!m.notice, notice: m.notice || '',
        hasMetrics: (m.metrics || []).length > 0, metrics: m.metrics || [],
        hasFiles: (m.files || []).length > 0,
        files: (m.files || []).map(f => Object.assign({}, f, { onClick: () => this._downloadFile(f) })),
        hasReport: false, report: null,
        trace: (m.trace || []).map(l => this.mapLine(l)), traceCount: (m.trace || []).length,
        traceTime: m.traceTime || '', traceOpen: !!m.traceOpen, caret: m.traceOpen ? ' ▾' : ' ▸',
        toggle: () => this.toggleTrace(i),
      };
    });

    const canSend = !this.state.running && (this.state.input || '').trim().length > 0 && !!this.state.user;
    const gateCanSubmit = !this.state.gateBusy && (this.state.gateInput || '').trim().length > 0;

    return {
      // Gate
      isGate: this.state.view === 'gate',
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

      // Login + app (unchanged contract)
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
