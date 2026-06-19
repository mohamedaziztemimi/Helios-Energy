<script type="text/x-dc" data-dc-script="" data-props="{
  &quot;$preview&quot;: { &quot;width&quot;: &quot;100%&quot;, &quot;height&quot;: &quot;100%&quot; },
  &quot;startView&quot;: { &quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;login&quot;, &quot;app&quot;], &quot;default&quot;: &quot;login&quot;, &quot;tsType&quot;: &quot;string&quot; },
  &quot;traceSpeed&quot;: { &quot;editor&quot;: &quot;enum&quot;, &quot;options&quot;: [&quot;Fast&quot;, &quot;Normal&quot;, &quot;Slow&quot;], &quot;default&quot;: &quot;Normal&quot;, &quot;tsType&quot;: &quot;string&quot; },
  &quot;showPlantsRail&quot;: { &quot;editor&quot;: &quot;boolean&quot;, &quot;default&quot;: true, &quot;tsType&quot;: &quot;boolean&quot; }
}">
class Component extends DCLogic {
  companies = {
    helios: { name:'Helios Renewables', cid:'helios', zone:'CAISO-SP15', plants:[
      { id:'C1-001', cap:'4.2 MW', status:'online',   out:'3.10 MW', pr:'94%', mtd:1842394 },
      { id:'C1-002', cap:'4.2 MW', status:'degraded', out:'2.41 MW', pr:'78%', mtd:1206800 },
      { id:'C1-003', cap:'6.0 MW', status:'online',   out:'4.88 MW', pr:'96%', mtd:2954120 },
    ]},
    aurora: { name:'Aurora Grid Energy', cid:'aurora', zone:'CAISO-NP15', plants:[
      { id:'AG-101', cap:'5.5 MW', status:'online',  out:'4.62 MW', pr:'95%', mtd:2410500 },
      { id:'AG-102', cap:'5.5 MW', status:'online',  out:'4.40 MW', pr:'93%', mtd:2298900 },
      { id:'AG-103', cap:'8.0 MW', status:'offline', out:'0.00 MW', pr:'—',   mtd:412000 },
    ]},
  };

  users = [
    { id:'mo', name:'Maria Okonkwo', initials:'MO', email:'m.okonkwo@heliosrenew.com', company:'helios', companyName:'Helios Renewables', role:'admin',    access:'energy+financial' },
    { id:'dr', name:'Dan Reyes',     initials:'DR', email:'d.reyes@heliosrenew.com',   company:'helios', companyName:'Helios Renewables', role:'operator', access:'energy' },
    { id:'pn', name:'Priya Nair',    initials:'PN', email:'p.nair@auroragrid.io',      company:'aurora', companyName:'Aurora Grid Energy', role:'admin',    access:'energy+financial' },
    { id:'tb', name:'Tomás Berg',    initials:'TB', email:'t.berg@auroragrid.io',      company:'aurora', companyName:'Aurora Grid Energy', role:'operator', access:'energy' },
  ];

  fmtMeta = {
    pdf:  { label:'PDF',  color:'#f0716a' },
    docx: { label:'DOCX', color:'#5b8def' },
    xlsx: { label:'XLSX', color:'#5fd08a' },
  };

  constructor(props) {
    super(props);
    const start = (props && props.startView) || 'login';
    this.state = {
      view: start,
      user: start === 'app' ? this.users[0] : null,
      messages: [], running: false, trace: [], input: '', toast: '',
    };
    this._timers = [];
  }

  componentWillUnmount() { this.clearTimers(); clearTimeout(this._toast); }

  componentDidUpdate() {
    if (this._scrollNext) { this._scrollNext = false; if (this._scroll) this._scroll.scrollTop = this._scroll.scrollHeight; }
  }

  clearTimers() { (this._timers || []).forEach(clearTimeout); this._timers = []; clearInterval(this._tick); }

  plantsFor() { const c = this.state.user ? this.state.user.company : 'helios'; return this.companies[c].plants; }

  nf(n) { return n.toLocaleString('en-US'); }

  fmtT(ms) { const d = new Date(ms); const p = (n, l) => String(n).padStart(l || 2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3); }

  stamp(raw) {
    const base = Date.now(); let cum = 0;
    return raw.map(r => { cum += r[0]; return { after: r[0], t: this.fmtT(base + cum), kind: r[1], text: r[2], indent: r[3] || 0 }; });
  }

  finish(raw, completeAfter, fin, toolCount) {
    const sum = raw.reduce((a, s) => a + s[0], 0) + completeAfter;
    const secs = (sum / 1000).toFixed(1);
    raw.push([completeAfter, 'ok', 'complete · ' + toolCount + ' tool_calls · ' + secs + 's', 0]);
    return { steps: this.stamp(raw), traceTime: secs + 's' };
  }

  mapLine(l) {
    const M = {
      info:   { c:'#6b7480', t:'#aeb6c2' },
      tool:   { c:'#f5a623', t:'#f5c06b' },
      query:  { c:'#3a424d', t:'#6b7480' },
      result: { c:'#5fd08a', t:'#86c7a4' },
      ok:     { c:'#5fd08a', t:'#86c7a4' },
      deny:   { c:'#f0716a', t:'#f0a09a' },
      warn:   { c:'#f5a623', t:'#f5c06b' },
    }[l.kind] || { c:'#6b7480', t:'#aeb6c2' };
    const G = { info:'▸', tool:'▸', query:'└─', result:'└─', ok:'✓', deny:'✕', warn:'!' }[l.kind] || '·';
    return { t: l.t, glyph: G, color: M.c, textColor: M.t, text: l.text, pad: ((l.indent || 0) * 18) + 'px' };
  }

  // ---- runs ----
  buildRun(q) {
    const ql = q.toLowerCase();
    if (/underperform|under-?perform|\bwhy\b|drop|fault|trip|offline|down\b|decline|incident/.test(ql)) return this.diagnosticRun();
    if (/revenue|report|portfolio|all my plant|performance ratio|across all|fleet|whole/.test(ql)) return this.portfolioRun();
    return this.productionRun();
  }

  productionRun() {
    const u = this.state.user, fin = u.access === 'energy+financial';
    const co = this.companies[u.company], plants = co.plants, P = plants[0];
    const pid = P.id, price = 48.20, nf = n => this.nf(n);
    const daily = []; let total = 0, peak = { d:1, k:0 };
    for (let i = 1; i <= 18; i++) {
      let k = 100000 + Math.round(Math.sin(i * 1.25) * 8500) + (i % 6 === 0 ? -12000 : 0);
      if (i === 11) k = 121400;
      daily.push(['2026-06-' + String(i).padStart(2, '0'), k]);
      total += k; if (k > peak.k) peak = { d:i, k };
    }
    const value = Math.round(total / 1000 * price);
    const raw = [
      [0,   'info',  'session.init  plant=' + pid + '  user=' + u.email, 0],
      [220, 'info',  'parse_request  intent=production_summary' + (fin ? '+price_comparison' : ''), 0],
      [300, 'tool',  'query_generation_db', 0],
      [180, 'query', "SELECT day, SUM(kwh) FROM generation WHERE plant_id='" + pid + "' AND month='2026-06' GROUP BY day", 1],
      [540, 'result', '18 rows · ' + nf(total) + ' kWh MTD', 1],
      [240, 'tool',  'fetch_plant_metadata', 0],
      [160, 'query', 'GET /plants/' + pid + ' → capacity=' + P.cap + ' zone=' + co.zone, 1],
      [300, 'result', 'ok · 1 record', 1],
    ];
    if (fin) {
      raw.push([280, 'tool',  'fetch_market_prices  src=CAISO_dayahead', 0]);
      raw.push([160, 'query', "SELECT interval, lmp FROM market_prices WHERE zone='" + co.zone.split('-')[1] + "' AND month='2026-06'", 1]);
      raw.push([560, 'result', '720 intervals · avg $' + price.toFixed(2) + '/MWh', 1]);
    } else {
      raw.push([320, 'deny', 'fetch_market_prices  BLOCKED · access=energy (financial scope not granted)', 0]);
    }
    raw.push([300, 'info', fin ? 'compute revenue_estimate · plan_variance' : 'compute plan_variance', 0]);
    raw.push([360, 'info', 'render_report  formats=' + (fin ? 'pdf,docx,xlsx' : 'pdf,xlsx'), 0]);
    const { steps, traceTime } = this.finish(raw, 420, fin, fin ? 5 : 4);

    const answer = fin
      ? 'Plant ' + pid + ' generated ' + nf(total) + ' kWh month-to-date in June 2026 — roughly 9.4% above its trailing three-month average. Valued at the ' + co.zone + ' day-ahead average of $' + price.toFixed(2) + '/MWh, that output represents an estimated $' + nf(value) + ' in market revenue. Peak single-day yield was ' + nf(peak.k) + ' kWh on June ' + peak.d + '. The full daily breakdown is attached below.'
      : 'Plant ' + pid + ' generated ' + nf(total) + ' kWh month-to-date in June 2026 — roughly 9.4% above its trailing three-month average, with a peak single-day yield of ' + nf(peak.k) + ' kWh on June ' + peak.d + '.';
    const metrics = fin
      ? [ { label:'MTD output', value:(total/1e6).toFixed(2)+'M kWh', color:'#e6e9ee' },
          { label:'vs 3-mo avg', value:'+9.4%', color:'#5fd08a' },
          { label:'Est. revenue', value:'$'+nf(value), color:'#f5a623' },
          { label:'Peak day', value:(peak.k/1000).toFixed(1)+' MWh', color:'#e6e9ee' } ]
      : [ { label:'MTD output', value:(total/1e6).toFixed(2)+'M kWh', color:'#e6e9ee' },
          { label:'vs 3-mo avg', value:'+9.4%', color:'#5fd08a' },
          { label:'Peak day', value:(peak.k/1000).toFixed(1)+' MWh', color:'#e6e9ee' } ];
    const notice = fin ? '' : 'Market-price comparison was withheld. Your access level (energy) does not include financial data — ask a ' + u.companyName + ' admin to enable energy+financial access for revenue analysis.';
    const report = fin
      ? { title: pid + ' · June 2026 Production & Market Analysis', slug: pid + '_2026-06_production_market', meta: '18 daily records · market-valued · 3 pages', formats:['pdf','docx','xlsx'],
          columns:['date','kwh','price_usd_mwh','market_value_usd'], rows: daily.map(r => [r[0], r[1], price.toFixed(2), Math.round(r[1]/1000*price)]),
          summary: pid + ' — June 2026 MTD\nTotal output: ' + nf(total) + ' kWh\nAvg price (' + co.zone + ' day-ahead): $' + price.toFixed(2) + '/MWh\nEstimated market revenue: $' + nf(value) + '\nPeak day: June ' + peak.d + ' (' + nf(peak.k) + ' kWh)' }
      : { title: pid + ' · June 2026 Production Summary', slug: pid + '_2026-06_production', meta: '18 daily records · 2 pages', formats:['pdf','xlsx'],
          columns:['date','kwh'], rows: daily,
          summary: pid + ' — June 2026 MTD\nTotal output: ' + nf(total) + ' kWh\nPeak day: June ' + peak.d + ' (' + nf(peak.k) + ' kWh)\nFinancial data withheld (access=energy)' };
    return { steps, traceTime, answer, notice, metrics, report };
  }

  diagnosticRun() {
    const u = this.state.user, fin = u.access === 'energy+financial';
    const co = this.companies[u.company], plants = co.plants;
    const P = plants.find(x => x.status !== 'online') || plants[1];
    const pid = P.id, nf = n => this.nf(n);
    const rows = [];
    for (let h = 0; h < 24; h++) {
      let k = 0; if (h >= 6 && h <= 19) { const x = (h - 6) / 13; k = Math.round(Math.sin(x * Math.PI) * 3000); }
      let status = 'ok'; if (h >= 11 && h <= 14) { k = Math.round(k * 0.1); status = 'FAULT'; }
      rows.push([String(h).padStart(2, '0') + ':00', k, status]);
    }
    const raw = [
      [0,   'info',  'session.init  plant=' + pid + '  user=' + u.email, 0],
      [220, 'info',  'parse_request  intent=anomaly_diagnosis  window=2026-06-08', 0],
      [300, 'tool',  'query_generation_db', 0],
      [170, 'query', "SELECT hour, kwh FROM generation WHERE plant_id='" + pid + "' AND day='2026-06-08'", 1],
      [500, 'result', '24 rows · output gap 11:00–15:00 (−23%)', 1],
      [260, 'tool',  'query_inverter_events', 0],
      [160, 'query', "SELECT ts, code, msg FROM inverter_events WHERE plant_id='" + pid + "' AND day='2026-06-08'", 1],
      [520, 'result', '3 events · block_B fault code=IGBT-OT 11:20→14:50', 1],
      [240, 'tool',  'fetch_weather', 0],
      [160, 'query', 'GET /weather/' + pid + '?day=2026-06-08 → ambient_max=41°C irradiance=nominal', 1],
      [420, 'result', 'ok · irradiance nominal · heat advisory active', 1],
    ];
    if (fin) {
      raw.push([260, 'tool',  'estimate_lost_revenue', 0]);
      raw.push([150, 'query', '14200 kWh × $48.20/MWh', 1]);
      raw.push([320, 'result', '≈ $684 estimated loss', 1]);
    } else {
      raw.push([300, 'deny', 'estimate_lost_revenue  BLOCKED · access=energy (financial scope not granted)', 0]);
    }
    raw.push([320, 'info', 'render_report  formats=' + (fin ? 'pdf,docx' : 'pdf'), 0]);
    const { steps, traceTime } = this.finish(raw, 420, fin, fin ? 4 : 3);

    const answer = pid + "'s yield fell about 23% on June 8. Root cause: a 3.5-hour fault on inverter block B (code IGBT-OT, 11:20–14:50) during a 41°C heat peak. Irradiance was nominal that day, so this was equipment-driven, not weather. Estimated lost production was 14,200 kWh" + (fin ? ' (≈ $684 at day-ahead prices)' : '') + '. The inverter auto-recovered at 14:50 — recommend a thermal inspection of block B cooling before the next heat event.';
    const metrics = fin
      ? [ { label:'Yield loss', value:'−23%', color:'#f0716a' },
          { label:'Downtime', value:'3.5 h', color:'#e6e9ee' },
          { label:'Lost output', value:'14.2 MWh', color:'#e6e9ee' },
          { label:'Est. loss', value:'$684', color:'#f5a623' } ]
      : [ { label:'Yield loss', value:'−23%', color:'#f0716a' },
          { label:'Downtime', value:'3.5 h', color:'#e6e9ee' },
          { label:'Lost output', value:'14.2 MWh', color:'#e6e9ee' } ];
    const notice = fin ? '' : 'Estimated revenue impact was withheld — your access level (energy) does not include financial data.';
    const report = { title: pid + ' · Underperformance Incident — June 8', slug: pid + '_2026-06-08_incident', meta: '24 hourly records · root-cause', formats: fin ? ['pdf','docx'] : ['pdf'],
      columns:['hour','kwh','status'], rows,
      summary: pid + ' — Incident June 8, 2026\nRoot cause: inverter block_B fault (IGBT-OT), 11:20–14:50\nYield loss: ~23% · downtime 3.5h · lost ~14,200 kWh' + (fin ? '\nEstimated revenue loss: ~$684' : '') + '\nRecommendation: thermal inspection of block B cooling' };
    return { steps, traceTime, answer, notice, metrics, report };
  }

  portfolioRun() {
    const u = this.state.user, fin = u.access === 'energy+financial';
    const co = this.companies[u.company], plants = co.plants;
    const price = 48.20, nf = n => this.nf(n);
    const total = plants.reduce((a, p) => a + p.mtd, 0);
    const value = Math.round(total / 1000 * price);
    const flagged = (plants.find(p => p.status !== 'online') || plants[1]).id;
    const raw = [
      [0,   'info',  'session.init  scope=portfolio  user=' + u.email, 0],
      [220, 'info',  'parse_request  intent=portfolio_report  plants=' + plants.length, 0],
      [300, 'tool',  'query_generation_db', 0],
      [180, 'query', "SELECT plant_id, SUM(kwh) FROM generation WHERE company='" + co.cid + "' AND month='2026-06' GROUP BY plant_id", 1],
      [540, 'result', plants.length + ' plants · ' + nf(total) + ' kWh MTD', 1],
      [240, 'tool',  'compute_performance_ratio', 0],
      [420, 'result', 'avg PR 90% · 1 plant flagged (' + flagged + ')', 1],
    ];
    if (fin) {
      raw.push([280, 'tool',  'fetch_market_prices  src=CAISO_dayahead', 0]);
      raw.push([520, 'result', 'avg $' + price.toFixed(2) + '/MWh · est. value $' + nf(value), 1]);
    } else {
      raw.push([300, 'deny', 'fetch_market_prices  BLOCKED · access=energy (financial scope not granted)', 0]);
    }
    raw.push([360, 'info', 'render_report  formats=' + (fin ? 'pdf,docx,xlsx' : 'pdf,xlsx'), 0]);
    const { steps, traceTime } = this.finish(raw, 420, fin, fin ? 4 : 3);

    const answer = fin
      ? 'Across your ' + plants.length + ' ' + u.companyName + ' plants, total month-to-date generation is ' + nf(total) + ' kWh, worth an estimated $' + nf(value) + ' at the ' + co.zone + ' day-ahead average. Fleet performance ratio averages 90%, but ' + flagged + ' is flagged below target and is driving most of the shortfall. Per-plant figures are in the report.'
      : 'Across your ' + plants.length + ' ' + u.companyName + ' plants, total month-to-date generation is ' + nf(total) + ' kWh. Fleet performance ratio averages 90%, but ' + flagged + ' is flagged below target and is driving most of the shortfall. Per-plant production is in the report.';
    const metrics = fin
      ? [ { label:'Plants', value:String(plants.length), color:'#e6e9ee' },
          { label:'MTD output', value:(total/1e6).toFixed(2)+'M kWh', color:'#e6e9ee' },
          { label:'Est. value', value:'$'+nf(value), color:'#f5a623' },
          { label:'Avg PR', value:'90%', color:'#5fd08a' } ]
      : [ { label:'Plants', value:String(plants.length), color:'#e6e9ee' },
          { label:'MTD output', value:(total/1e6).toFixed(2)+'M kWh', color:'#e6e9ee' },
          { label:'Avg PR', value:'90%', color:'#5fd08a' } ];
    const notice = fin ? '' : 'Market valuation was withheld — your access level (energy) does not include financial data.';
    const report = fin
      ? { title: u.companyName + ' Portfolio · June 2026', slug: co.cid + '_portfolio_2026-06', meta: plants.length + ' plants · revenue & production', formats:['pdf','docx','xlsx'],
          columns:['plant','kwh','price_usd_mwh','value_usd'], rows: plants.map(p => [p.id, p.mtd, price.toFixed(2), Math.round(p.mtd/1000*price)]),
          summary: u.companyName + ' Portfolio — June 2026 MTD\nTotal output: ' + nf(total) + ' kWh\nEstimated value: $' + nf(value) + '\nFlagged: ' + flagged }
      : { title: u.companyName + ' Portfolio · June 2026', slug: co.cid + '_portfolio_2026-06', meta: plants.length + ' plants · production', formats:['pdf','xlsx'],
          columns:['plant','kwh'], rows: plants.map(p => [p.id, p.mtd]),
          summary: u.companyName + ' Portfolio — June 2026 MTD\nTotal output: ' + nf(total) + ' kWh\nFlagged: ' + flagged + '\nFinancial data withheld (access=energy)' };
    return { steps, traceTime, answer, notice, metrics, report };
  }

  // ---- actions ----
  pick(u) { this.clearTimers(); this._scrollNext = true; this.setState({ view:'app', user:u, messages:[], running:false, trace:[], input:'' }); }
  switchUser() { this.clearTimers(); this.setState({ view:'login', user:null, messages:[], running:false, trace:[], input:'' }); }
  toggleTrace(i) { this.setState(st => ({ messages: st.messages.map((m, idx) => idx === i ? Object.assign({}, m, { traceOpen: !m.traceOpen }) : m) })); }

  send() {
    const q = (this.state.input || '').trim();
    if (!q || this.state.running) return;
    const plan = this.buildRun(q);
    const mult = ({ Fast:0.55, Normal:1, Slow:1.7 })[(this.props && this.props.traceSpeed) || 'Normal'] || 1;
    this._scrollNext = true;
    this.setState(st => ({ messages: st.messages.concat([{ role:'user', text:q }]), input:'', running:true, trace:[] }));
    this._start = Date.now();
    this.clearTimers();
    this._tick = setInterval(() => this.forceUpdate(), 100);
    let acc = 0;
    plan.steps.forEach(s => {
      acc += s.after * mult;
      this._timers.push(setTimeout(() => { this._scrollNext = true; this.setState(st => ({ trace: st.trace.concat([s]) })); }, acc));
    });
    this._timers.push(setTimeout(() => {
      clearInterval(this._tick); this._scrollNext = true;
      this.setState(st => ({
        messages: st.messages.concat([{ role:'agent', trace: st.trace, traceTime: plan.traceTime, traceOpen:false, answer: plan.answer, notice: plan.notice, metrics: plan.metrics, report: plan.report }]),
        running:false, trace:[],
      }));
    }, acc + 500 * mult));
  }

  download(report, fmt) {
    let content, name, type;
    if (fmt === 'xlsx') {
      content = [report.columns.join(',')].concat(report.rows.map(r => r.join(','))).join('\n');
      name = report.slug + '.csv'; type = 'text/csv';
    } else {
      const table = [report.columns.join('\t')].concat(report.rows.map(r => r.join('\t'))).join('\n');
      content = report.title + '\n' + '='.repeat(report.title.length) + '\n\n' + report.summary + '\n\n' + table + '\n';
      name = report.slug + (fmt === 'pdf' ? '.pdf.txt' : '.docx.txt'); type = 'text/plain';
    }
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    this.setState({ toast: 'Downloaded ' + name });
    clearTimeout(this._toast);
    this._toast = setTimeout(() => this.setState({ toast:'' }), 2800);
  }

  renderVals() {
    const accClr = a => a === 'energy+financial'
      ? { color:'#f5a623', bg:'#f5a6231a', border:'#f5a62340' }
      : { color:'#8fb8a0', bg:'#5fd08a14', border:'#5fd08a33' };
    const accLabel = a => a === 'energy+financial' ? 'energy + financial' : 'energy';

    const companyGroups = ['helios', 'aurora'].map(cid => ({
      name: this.companies[cid].name,
      users: this.users.filter(u => u.company === cid).map(u => {
        const c = accClr(u.access);
        return Object.assign({}, u, {
          roleLabel: u.role.toUpperCase(), accessLabel: accLabel(u.access),
          accessColor: c.color, accessBg: c.bg, accessBorder: c.border,
          pick: () => this.pick(u),
        });
      }),
    }));

    const u = this.state.user || {};
    const uc = accClr(u.access);
    const plants = this.plantsFor().map(p => Object.assign({}, p, {
      statusColor: p.status === 'online' ? '#5fd08a' : (p.status === 'degraded' ? '#f5a623' : '#f0716a'),
    }));

    const pid = this.plantsFor()[0].id;
    const pid2 = (this.plantsFor().find(p => p.status !== 'online') || this.plantsFor()[1]).id;
    const sugTexts = [
      "What's my total energy production for " + pid + " this month, and how does it compare to market prices?",
      'Why did ' + pid2 + ' underperform recently?',
      'Generate a June revenue report for my whole portfolio.',
      'Show the performance ratio across all my plants.',
    ];
    const suggestions = sugTexts.map(t => ({ text: t, ask: () => this.setState({ input: t }, () => this.send()) }));

    const msgs = this.state.messages.map((m, i) => {
      if (m.role === 'user') return { isUser:true, isAgent:false, text:m.text };
      const rep = m.report ? Object.assign({}, m.report, {
        fmts: m.report.formats.map(f => Object.assign({}, this.fmtMeta[f], { onClick: () => this.download(m.report, f) })),
        onDownload: () => this.download(m.report, m.report.formats.indexOf('xlsx') >= 0 ? 'xlsx' : m.report.formats[0]),
      }) : null;
      return {
        isUser:false, isAgent:true, answer:m.answer,
        hasNotice: !!m.notice, notice: m.notice || '',
        hasMetrics: (m.metrics || []).length > 0, metrics: m.metrics || [],
        hasReport: !!m.report, report: rep,
        trace: (m.trace || []).map(l => this.mapLine(l)), traceCount: (m.trace || []).length,
        traceTime: m.traceTime || '', traceOpen: !!m.traceOpen, caret: m.traceOpen ? ' ▾' : ' ▸',
        toggle: () => this.toggleTrace(i),
      };
    });

    const canSend = !this.state.running && (this.state.input || '').trim().length > 0;

    return {
      isLogin: this.state.view === 'login',
      isApp: this.state.view === 'app',
      companyGroups, plants,
      companyName: u.companyName || '', userEmail: u.email || '', userInitials: u.initials || '',
      userRole: (u.role || '').toUpperCase(), userAccessLabel: accLabel(u.access),
      userAccessColor: uc.color, userAccessBg: uc.bg, userAccessBorder: uc.border,
      showRail: this.props.showPlantsRail !== false,
      railCols: this.props.showPlantsRail !== false ? '264px minmax(0,1fr)' : '0px minmax(0,1fr)',
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
</script>