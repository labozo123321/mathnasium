/* Mathnasium Live - dashboard front-end.
   Hand-rolled SVG charts: thin marks, rounded data-ends, hairline grid,
   tooltips + table views. All person/center names are inserted with
   textContent - never innerHTML. */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const tooltip = $('#tooltip');

  const state = {
    overview: null,
    trends: [],
    rosters: new Map(), // centerId -> students[]
    center: '',         // '' = all centers
    days: 30,
    search: '',
    detail: null,       // per-center detail payload
    map: null,          // Leaflet map instance
    layers: null,       // { schools, zips } layer groups
    basemap: 'streets', // 'streets' | 'satellite'
    queueTab: 'runningOut',
  };
  try { state.basemap = localStorage.getItem('mn-basemap') || 'streets'; } catch (e) { /* private mode */ }

  // ---------- tiny DOM helper ----------
  function h(tag, attrs = {}, children = []) {
    const ns = ['svg', 'g', 'rect', 'path', 'line', 'circle', 'text', 'polyline'].includes(tag)
      ? 'http://www.w3.org/2000/svg' : null;
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) el.appendChild(c);
    return el;
  }

  // Inline icons (static markup, no user data goes through here).
  const ICONS = {
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M16 4a4 4 0 0 1 0 8M22 21c0-3-2-5-5-5.5"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    flame: '<path d="M12 2c1 4 6 6.5 6 12a6 6 0 0 1-12 0c0-2.5 1.5-4 1.5-4S8 13 10 13c1.5-3-1-7 2-11z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    hourglass: '<path d="M6 2h12M6 22h12M7 2c0 6 5 6 5 10s-5 4-5 10M17 2c0 6-5 6-5 10s5 4 5 10"/>',
    down: '<path d="M3 7l6 6 4-4 8 8M14 17h7v-7"/>',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  function fmtMins(m) {
    if (m == null) return '—';
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  }

  function timeOnly(s) {
    const m = /(\d{1,2}:\d{2})(?::\d{2})?\s*(AM|PM)/i.exec(s || '');
    return m ? `${m[1]} ${m[2].toUpperCase()}` : '—';
  }

  function niceTicks(max) {
    if (max <= 0) return [0, 1];
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    let unit = step;
    if (max / step >= 5) unit = step * 2;
    if (max / step >= 10) unit = step * 5;
    const top = Math.ceil(max / unit) * unit;
    const ticks = [];
    for (let v = 0; v <= top; v += unit) ticks.push(v);
    return ticks;
  }

  // ---------- tooltip ----------
  function showTip(evt, rows) {
    tooltip.replaceChildren(...rows);
    tooltip.hidden = false;
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const r = tooltip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function tipRows(value, label) {
    return [
      h('div', {}, [h('span', { class: 'key' }), h('span', { class: 'tip-value', text: String(value) })]),
      h('div', { text: label }),
    ];
  }
  function hideTip() { tooltip.hidden = true; }

  // bar with a 4px rounded data-end, square at the baseline
  function barPath(x, y, w, hgt, r, horizontal) {
    if (horizontal) {
      const rr = Math.min(r, w, hgt / 2);
      return `M${x},${y} h${Math.max(w - rr, 0)} q${rr},0 ${rr},${rr} v${hgt - 2 * rr} q0,${rr} -${rr},${rr} h-${Math.max(w - rr, 0)} z`;
    }
    const rr = Math.min(r, hgt, w / 2);
    return `M${x},${y + hgt} v-${Math.max(hgt - rr, 0)} q0,-${rr} ${rr},-${rr} h${w - 2 * rr} q${rr},0 ${rr},${rr} v${Math.max(hgt - rr, 0)} z`;
  }

  // ---------- data ----------
  async function apiFetch(path) {
    const res = await fetch(path);
    if (res.status === 401) throw { auth: true };
    if (!res.ok) {
      let msg = 'Request failed (' + res.status + ')';
      try { msg = (await res.json()).error || msg; } catch (e) { /* non-JSON error */ }
      throw { msg, status: res.status };
    }
    return res.json();
  }
  async function loadOverview() {
    state.overview = await apiFetch('/api/overview');
  }
  async function loadTrends() {
    const q = new URLSearchParams({ days: state.days });
    if (state.center) q.set('center', state.center);
    state.trends = (await apiFetch('/api/trends?' + q)).days;
  }
  async function loadRosters() {
    if (!state.overview) return;
    const wanted = state.center
      ? state.overview.centers.filter((c) => String(c.id) === state.center)
      : state.overview.centers;
    await Promise.all(wanted.map(async (c) => {
      state.rosters.set(c.id, (await apiFetch('/api/roster/' + c.id)).students || []);
    }));
  }

  function visibleCenters() {
    if (!state.overview) return [];
    return state.center
      ? state.overview.centers.filter((c) => String(c.id) === state.center)
      : state.overview.centers;
  }

  async function loadDetail() {
    const path = state.center ? '/api/center/' + state.center : '/api/center/all';
    try {
      state.detail = await apiFetch(path);
    } catch (e) {
      if (e && e.auth) throw e;
      state.detail = null;
    }
  }

  // ---------- renders ----------
  function renderChrome() {
    const o = state.overview;
    const badge = $('#modeBadge');
    badge.hidden = false;
    if (o.mode === 'live') { badge.textContent = 'LIVE'; badge.classList.add('live'); }
    else if (o.mode === 'mock') { badge.textContent = 'DEMO DATA'; badge.classList.remove('live'); }
    else { badge.textContent = o.mode.toUpperCase().slice(0, 24); badge.classList.remove('live'); }
    $('#lastSync').textContent = o.lastSync
      ? 'Updated ' + new Date(o.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : 'Waiting for first sync…';
    renderAlerts(o);

    const note = $('#configNote');
    note.hidden = !o.note;
    if (o.note) {
      note.replaceChildren(document.createTextNode(o.note + ' '));
      if (o.canSetup) {
        note.appendChild(h('button', {
          class: 'ghost-btn', type: 'button', text: 'Connect Radius',
          onclick: () => { $('#setup').hidden = false; $('#setupUser').focus(); },
        }));
      }
    }

    // first time we see demo data, offer the connect form right away
    if (o.canSetup && !state.setupOffered) {
      state.setupOffered = true;
      let dismissed = false;
      try { dismissed = sessionStorage.getItem('mn-setup-skip') === '1'; } catch (e) { /* private mode */ }
      if (!dismissed) { $('#setup').hidden = false; $('#setupUser').focus(); }
    }

    const sel = $('#centerFilter');
    if (sel.options.length <= 1 && o.centers.length) {
      for (const c of o.centers) sel.appendChild(h('option', { value: c.id, text: c.name }));
    }
  }

  function sparkSvg(byHour) {
    const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const W = 180; const H = 34; const bw = Math.min(W / HOURS.length - 2, 14);
    const max = Math.max(1, ...HOURS.map((hh) => byHour[hh] || 0));
    const nowH = new Date().getHours();
    const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, class: 'spark', 'aria-hidden': 'true' });
    HOURS.forEach((hh, i) => {
      const v = byHour[hh] || 0;
      const bh = v ? Math.max((v / max) * (H - 6), 2) : 2;
      const x = i * (W / HOURS.length) + (W / HOURS.length - bw) / 2;
      svg.appendChild(h('path', {
        d: barPath(x, H - bh, bw, bh, 2, false),
        fill: hh === nowH ? 'var(--series-1)' : (v ? 'var(--de-emphasis)' : 'var(--grid-line)'),
      }));
    });
    return svg;
  }

  function renderCenters() {
    const grid = $('#centerGrid');
    grid.replaceChildren(...state.overview.centers.map((c) => {
      const selected = state.center === String(c.id);
      const card = h('div', {
        class: 'center-card' + (selected ? ' selected' : ''),
        role: 'button', tabindex: '0',
        onclick: () => setCenter(selected ? '' : String(c.id)),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCenter(selected ? '' : String(c.id)); } },
      }, [
        h('div', { class: 'head' }, [
          h('span', { class: 'name', text: c.name }),
          h('span', { class: 'status' + ((c.checkedIn || c.staffIn) ? ' on' : ''), text: (c.checkedIn || c.staffIn) ? 'Open' : 'Quiet',
            title: (c.checkedIn || c.staffIn) ? 'People are checked in' : 'Nobody checked in' }),
        ]),
        h('div', { class: 'live-num' }, [
          document.createTextNode(c.checkedIn == null ? '—' : String(c.checkedIn)),
          h('span', { class: 'unit', text: 'in now' }),
        ]),
        h('div', { class: 'row' }, [
          h('span', { text: `Staff: ${c.staffIn == null ? '—' : c.staffIn}` }),
          h('span', { text: `Today: ${c.visitsToday == null ? '—' : c.visitsToday}` }),
        ]),
        sparkSvg(c.byHourToday || {}),
      ]);
      if (c.error) card.appendChild(h('div', { class: 'err', text: 'sync issue: ' + c.error }));
      return card;
    }));
  }

  function renderByCenter() {
    const cs = state.overview.centers;
    const W = 560; const rowH = 30; const barH = 18; const left = 108; const right = 40;
    const Hgt = cs.length * rowH + 8;
    const max = Math.max(1, ...cs.map((c) => c.checkedIn || 0));
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Students checked in right now, by center' });
    cs.forEach((c, i) => {
      const y = i * rowH + 6;
      const v = c.checkedIn || 0;
      const w = Math.max((v / max) * (W - left - right), v ? 3 : 0);
      const emphasized = !state.center || state.center === String(c.id);
      svg.appendChild(h('text', { x: left - 8, y: y + barH / 2 + 4, 'text-anchor': 'end', text: c.name }));
      svg.appendChild(h('line', { x1: left, y1: y + barH + 3, x2: W - right, y2: y + barH + 3, stroke: 'var(--grid-line)', 'stroke-width': i === cs.length - 1 ? 1 : 0 }));
      if (v > 0) {
        svg.appendChild(h('path', { d: barPath(left, y, w, barH, 4, true), fill: emphasized ? 'var(--series-1)' : 'var(--de-emphasis)' }));
      } else {
        svg.appendChild(h('line', { x1: left, y1: y + barH / 2, x2: left + 3, y2: y + barH / 2, stroke: 'var(--axis)', 'stroke-width': 2 }));
      }
      svg.appendChild(h('text', { x: left + w + 6, y: y + barH / 2 + 4, class: 'val-label', text: String(v) }));
      // oversized hit target with hover + click-to-filter
      svg.appendChild(h('rect', {
        x: 0, y: y - 4, width: W, height: rowH, fill: 'transparent', style: 'cursor:pointer',
        onpointermove: (e) => showTip(e, tipRows(`${v} in now`, `${c.name} · ${c.visitsToday ?? 0} visits today`)),
        onpointerleave: hideTip,
        onclick: () => setCenter(state.center === String(c.id) ? '' : String(c.id)),
      }));
    });
    $('#byCenterChart').replaceChildren(svg);

    const tbl = h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', { text: 'Center' }), h('th', { text: 'In now' }), h('th', { text: 'Visits today' })])),
      h('tbody', {}, cs.map((c) => h('tr', {}, [
        h('td', { text: c.name }),
        h('td', { class: 'num', text: String(c.checkedIn ?? '—') }),
        h('td', { class: 'num', text: String(c.visitsToday ?? '—') }),
      ]))),
    ]);
    $('#byCenterTable').replaceChildren(tbl);
  }

  function renderInNow() {
    const centers = visibleCenters();
    const rows = [];
    for (const c of centers) {
      for (const s of c.inNow || []) rows.push({ ...s, center: c.name });
    }
    rows.sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    const tbody = $('#inNowTable tbody');
    tbody.replaceChildren(...rows.map((r) => h('tr', {}, [
      h('td', { text: r.name }),
      h('td', { text: r.center }),
      h('td', { class: 'num', text: timeOnly(r.arrival) }),
      h('td', { class: 'num', text: fmtMins(r.minutes) }),
    ])));
    $('#inNowEmpty').hidden = rows.length > 0;
    $('#inNowTable').hidden = rows.length === 0;
  }

  function renderTrend() {
    const data = state.trends;
    const W = 560; const Hgt = 220; let left = 36; const right = 16; const top = 12; const bottom = 26;
    let iw = W - left - right; const ih = Hgt - top - bottom;
    const box = $('#trendChart');
    if (!data.length) {
      box.replaceChildren(h('p', { class: 'muted empty', text: 'History builds up while the app runs - check back tomorrow.' }));
      $('#trendTable').replaceChildren();
      return;
    }
    const max = Math.max(1, ...data.map((d) => d.visits));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    left = 14 + topVal.toLocaleString().length * 7.5;
    iw = W - left - right;
    const x = (i) => left + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = (v) => top + ih - (v / topVal) * ih;

    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Daily student visits' });
    for (const t of ticks) {
      svg.appendChild(h('line', { x1: left, y1: y(t), x2: W - right, y2: y(t), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: left - 6, y: y(t) + 3, 'text-anchor': 'end', text: t.toLocaleString() }));
    }
    const step = Math.max(1, Math.ceil(data.length / 6));
    data.forEach((d, i) => {
      if (i % step === 0 || i === data.length - 1) {
        svg.appendChild(h('text', { x: x(i), y: Hgt - 8, 'text-anchor': 'middle', text: d.date.slice(5).replace('-', '/') }));
      }
    });
    const pts = data.map((d, i) => `${x(i)},${y(d.visits)}`).join(' ');
    const areaD = `M${x(0)},${y(0)} L${pts.split(' ').join(' L')} L${x(data.length - 1)},${y(0)} Z`;
    svg.appendChild(h('path', { d: areaD, fill: 'var(--series-1-wash)', stroke: 'none' }));
    svg.appendChild(h('polyline', { points: pts, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = data[data.length - 1];
    svg.appendChild(h('circle', { cx: x(data.length - 1), cy: y(last.visits), r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.appendChild(h('text', { x: x(data.length - 1) - 8, y: Math.max(y(last.visits) - 8, 12), 'text-anchor': 'end', class: 'val-label', text: last.visits.toLocaleString() }));

    // crosshair + tooltip
    const cross = h('line', { y1: top, y2: top + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = h('circle', { r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(cross); svg.appendChild(dot);
    svg.appendChild(h('rect', {
      x: left, y: top, width: iw, height: ih, fill: 'transparent',
      onpointermove: (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - left) / iw) * (data.length - 1))));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(data[i].visits)); dot.setAttribute('visibility', 'visible');
        showTip(e, tipRows(`${data[i].visits} visits`, data[i].date + (data[i].peak ? ` · peak ${data[i].peak} in at once` : '')));
      },
      onpointerleave: () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); },
    }));
    box.replaceChildren(svg);

    $('#trendTable').replaceChildren(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', { text: 'Date' }), h('th', { text: 'Visits' }), h('th', { text: 'Peak in at once' })])),
      h('tbody', {}, data.slice().reverse().map((d) => h('tr', {}, [
        h('td', { text: d.date }),
        h('td', { class: 'num', text: String(d.visits) }),
        h('td', { class: 'num', text: String(d.peak) }),
      ]))),
    ]));
  }

  function renderHours() {
    const byHour = {};
    for (const d of state.trends) {
      for (const [hh, n] of Object.entries(d.byHour || {})) byHour[hh] = (byHour[hh] || 0) + n;
    }
    const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const labels = HOURS.map((hh) => (hh === 12 ? '12p' : hh > 12 ? (hh - 12) + 'p' : hh + 'a'));
    const W = 560; const Hgt = 220; const right = 12; const top = 12; const bottom = 26;
    const ih = Hgt - top - bottom;
    const max = Math.max(1, ...HOURS.map((hh) => byHour[hh] || 0));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    const left = 14 + topVal.toLocaleString().length * 7.5;
    const iw = W - left - right;
    const bw = Math.min(iw / HOURS.length - 4, 24);
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Arrivals by hour of day' });
    for (const t of ticks) {
      const yy = top + ih - (t / topVal) * ih;
      svg.appendChild(h('line', { x1: left, y1: yy, x2: W - right, y2: yy, stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: left - 6, y: yy + 3, 'text-anchor': 'end', text: t.toLocaleString() }));
    }
    HOURS.forEach((hh, i) => {
      const v = byHour[hh] || 0;
      const cx = left + i * (iw / HOURS.length) + (iw / HOURS.length) / 2;
      const bh = (v / topVal) * ih;
      if (v > 0) {
        svg.appendChild(h('path', { d: barPath(cx - bw / 2, top + ih - bh, bw, bh, 4, false), fill: 'var(--series-1)' }));
      }
      svg.appendChild(h('text', { x: cx, y: Hgt - 8, 'text-anchor': 'middle', text: labels[i] }));
      svg.appendChild(h('rect', {
        x: cx - (iw / HOURS.length) / 2, y: top, width: iw / HOURS.length, height: ih, fill: 'transparent',
        onpointermove: (e) => showTip(e, tipRows(`${v} arrivals`, `${labels[i].replace('a', ' AM').replace('p', ' PM')} · selected range`)),
        onpointerleave: hideTip,
      }));
    });
    $('#hoursChart').replaceChildren(svg);
    $('#hoursTable').replaceChildren(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', { text: 'Hour' }), h('th', { text: 'Arrivals' })])),
      h('tbody', {}, HOURS.map((hh, i) => h('tr', {}, [
        h('td', { text: labels[i] }),
        h('td', { class: 'num', text: String(byHour[hh] || 0) }),
      ]))),
    ]));
  }

  function renderRoster() {
    const centers = visibleCenters();
    const rows = [];
    for (const c of centers) {
      for (const s of state.rosters.get(c.id) || []) rows.push({ ...s, center: c.name });
    }
    const q = state.search.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => (r.name || '').toLowerCase().includes(q)) : rows;
    filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const shown = filtered.slice(0, 400);
    $('#rosterTable tbody').replaceChildren(...shown.map((r) => h('tr', {}, [
      h('td', { text: r.name || '—' }),
      h('td', { text: r.center }),
      h('td', { text: r.enrollmentType || '—' }),
      h('td', { class: 'num', text: r.sessionsLeft == null ? '—' : String(r.sessionsLeft) }),
      h('td', { text: r.lastActivity || '—' }),
    ])));
    $('#rosterCount').textContent = filtered.length === rows.length
      ? `${rows.length} students`
      : `${filtered.length} of ${rows.length} students` + (shown.length < filtered.length ? ` (showing first ${shown.length})` : '');
  }

  function fmtMonths(m) {
    if (m == null) return '—';
    if (m < 12) return `${m.toFixed(1)} mo`;
    return `${(m / 12).toFixed(1)} yr`;
  }

  function renderDetail() {
    const d = state.detail;
    if (!d) return; // keep whatever is shown until data arrives
    const allScope = !state.center;
    $('#detailTitle').textContent = allScope ? 'All centers' : d.name;
    $('#detailNote').textContent = `${d.memberCount} members`;
    $('#mapTitle').textContent = allScope
      ? 'Where students come from — all centers' : 'Where students come from';

    // attendance for this scope comes from the live overview
    const centers = visibleCenters();
    const sumOv = (f) => centers.reduce((a, c) => a + (f(c) || 0), 0);
    const anyLive = centers.some((c) => c.checkedIn != null);
    const inNow = anyLive ? sumOv((c) => c.checkedIn) : null;
    const visitsToday = anyLive ? sumOv((c) => c.visitsToday) : null;

    const pct = (a, b) => (a != null && b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : null);
    const activePct = pct(d.active, d.enrolled);
    const holdPct = pct(d.holds, d.enrolled);
    const nowPct = pct(inNow, visitsToday);
    const tiles = [
      { tone: 't-blue', icon: 'users', label: 'Enrolled', value: d.enrolled, sub: 'students enrolled now' },
      { tone: 't-green', icon: 'bolt', label: 'Active', value: d.active,
        sub: activePct == null ? 'attended in last 30 days' : `${activePct}% of enrolled, last 30 days`, bar: activePct },
      { tone: 't-orange', icon: 'pause', label: 'On hold', value: d.holds,
        sub: holdPct == null ? 'frozen memberships' : `${holdPct}% of enrolled frozen`, bar: holdPct },
      { tone: 't-red', icon: 'flame', label: 'Visits today', value: visitsToday ?? '—',
        sub: `${inNow ?? '—'} in session now`, bar: nowPct },
      { tone: 't-purple', icon: 'clock', label: 'Avg stay', value: fmtMonths(d.avgTenureMonths), sub: 'running average since sign-up' },
    ];
    $('#detailKpis').replaceChildren(...tiles.map((t) => h('div', { class: 'tile ' + t.tone }, [
      h('div', { class: 'tile-icon' }, icon(t.icon)),
      h('div', { class: 'tile-body' }, [
        h('div', { class: 'value', text: String(t.value ?? '—') }),
        h('div', { class: 'label', text: t.label }),
        h('div', { class: 'sub', text: t.sub }),
        t.bar == null ? null : h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(t.bar), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t.label },
          h('span', { style: `width:${t.bar}%` })),
      ]),
    ])));

    renderQueue(d, allScope);

    // top schools
    const schools = d.schools || [];
    $('#schoolsTable tbody').replaceChildren(...schools.slice(0, 60).map((s, i) => h('tr', {}, [
      h('td', { class: 'rank' }, h('span', { class: 'medal' + (i < 3 ? ' m' + (i + 1) : ''), text: String(i + 1) })),
      h('td', { text: s.name }),
      h('td', { class: 'num score', text: String(s.count) }),
    ])));

    const pending = $('#mapPending');
    if (d.geocodePending > 0) {
      pending.hidden = false;
      pending.textContent = `Locating ${d.geocodePending} more place(s) on the map — they'll appear in a moment.`;
    } else pending.hidden = true;

    renderMap(d);
  }

  // Three readable size steps instead of a continuous radius.
  function sizeSteps(max) {
    const m = Math.max(2, Math.ceil(max * 0.25));
    const l = Math.max(m + 1, Math.ceil(max * 0.6));
    return { m, l };
  }
  function sizeClass(count, steps) {
    return count >= steps.l ? 'sz-l' : count >= steps.m ? 'sz-m' : 'sz-s';
  }
  const NODE_PX = { 'sz-s': 30, 'sz-m': 40, 'sz-l': 52 };
  const DISC_PX = { 'sz-s': 20, 'sz-m': 28, 'sz-l': 38 };

  const TILES = {
    streets: {
      light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; OpenStreetMap &copy; CARTO',
    },
    satellite: {
      imagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      labels: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      attr: 'Imagery &copy; Esri &middot; Labels &copy; CARTO',
    },
  };

  function isDarkTheme() {
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // Flat Duolingo-style "path node": a chunky circle with a thick bottom edge.
  // Only numbers / fixed strings go into the HTML; names travel via tooltips.
  function nodeIcon(classes, label, px, badge) {
    const div = document.createElement('div');
    div.className = 'node ' + classes;
    const span = document.createElement('span');
    span.textContent = String(label);
    div.appendChild(span);
    if (badge != null) {
      const em = document.createElement('em');
      em.className = 'node-badge';
      em.textContent = String(Number(badge));
      div.appendChild(em);
    }
    return L.divIcon({ className: 'mn-node-icon', html: div.outerHTML, iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
  }
  // A label pill whose top sits on the bottom edge of a disc of radius r.
  function pillIcon(text, r) {
    const div = document.createElement('div');
    div.className = 'zip-pill';
    div.textContent = text;
    return L.divIcon({ className: 'mn-node-icon', html: div.outerHTML, iconSize: [0, 0], iconAnchor: [0, -(r - 6)] });
  }

  // Zoomed out (all centers, country scale) only the center nodes are shown;
  // schools and neighborhoods appear once you zoom in - like opening a unit.
  const FAR_ZOOM = 9;
  function applyZoomVisibility() {
    if (!state.map) return;
    $('#map').classList.toggle('mn-far', state.map.getZoom() < FAR_ZOOM);
  }

  function applyBasemap(dark) {
    const key = state.basemap + ':' + (dark ? 'dark' : 'light');
    if (state.tileKey === key) return;
    for (const l of state.tileLayers || []) state.map.removeLayer(l);
    const layers = [];
    if (state.basemap === 'satellite') {
      layers.push(L.tileLayer(TILES.satellite.imagery, { maxZoom: 18, attribution: TILES.satellite.attr }));
      layers.push(L.tileLayer(TILES.satellite.labels, { maxZoom: 18 }));
    } else {
      layers.push(L.tileLayer(dark ? TILES.streets.dark : TILES.streets.light, { maxZoom: 18, attribution: TILES.streets.attr }));
    }
    layers.forEach((l) => l.addTo(state.map));
    state.tileLayers = layers;
    state.tileKey = key;
  }

  // On-map key: what each node means, the three sizes, and the medal rings.
  function buildMapKey(d, steps) {
    const el = state.mapKeyEl;
    if (!el) return;
    const node = (cls, label) => {
      const n = h('span', { class: 'node key-node ' + cls }, h('span', { text: label }));
      return n;
    };
    const row = (swatch, text) => h('div', { class: 'key-row' }, [swatch, h('span', { text })]);
    el.replaceChildren(
      h('div', { class: 'key-title', text: 'Map key' }),
      row(node('node-home sz-s', 'M'), 'Mathnasium center'),
      row(node('node-school sz-s', '7'), 'School · number = students'),
      row(h('span', { class: 'key-disc' }), 'Neighborhood (ZIP) · students'),
      h('div', { class: 'key-sizes' }, [
        h('div', { class: 'key-size' }, [node('node-school sz-s', ''), h('span', { text: `1–${steps.m - 1}` })]),
        h('div', { class: 'key-size' }, [node('node-school sz-m', ''), h('span', { text: `${steps.m}–${steps.l - 1}` })]),
        h('div', { class: 'key-size' }, [node('node-school sz-l', ''), h('span', { text: `${steps.l}+` })]),
      ]),
      row(node('node-school sz-s rank-1', '1'), 'Top 3 schools wear a medal ring'),
      h('div', { class: 'key-hint', text: 'Zoom in or click an M to see its schools' }),
    );
  }

  function renderMap(d) {
    if (typeof L === 'undefined') {
      state.mapRetries = (state.mapRetries || 0) + 1;
      if (state.mapRetries <= 20) { setTimeout(() => renderMap(d), 400); return; }
      const el = $('#map');
      if (el && !el.dataset.failed) {
        el.dataset.failed = '1';
        el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center'; el.style.padding = '20px';
        el.textContent = 'Map library could not load. The school and neighborhood counts are in the tables.';
      }
      return;
    }

    const dark = isDarkTheme();
    const yellow = cssVar('--yellow', '#FFC800');
    const yellowShade = cssVar('--yellow-shade', '#E5A800');

    if (!state.map) {
      state.map = L.map('map', { scrollWheelZoom: false, center: [39.5, -98.35], zoom: 4 });
      state.layers = { zips: L.layerGroup(), schools: L.layerGroup(), centers: L.layerGroup() };
      L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(state.map);
      const key = L.control({ position: 'bottomright' });
      key.onAdd = () => {
        const el = L.DomUtil.create('div', 'map-key');
        L.DomEvent.disableClickPropagation(el);
        state.mapKeyEl = el;
        return el;
      };
      key.addTo(state.map);
      state.map.on('zoomend', applyZoomVisibility);
    }

    applyBasemap(dark);
    state.map.invalidateSize();
    state.layers.schools.clearLayers();
    state.layers.zips.clearLayers();
    state.layers.centers.clearLayers();

    const pts = [];
    const total = Math.max(1, d.memberCount || 0);

    // Neighborhoods: flat yellow discs with a solid edge and a ZIP · count pill.
    const zipList = (d.zips || []).filter((z) => z.lat != null && z.lng != null);
    const zipSteps = sizeSteps(Math.max(1, ...zipList.map((z) => z.count)));
    for (const z of zipList) {
      pts.push([z.lat, z.lng]);
      const sz = sizeClass(z.count, zipSteps);
      L.circleMarker([z.lat, z.lng], {
        radius: DISC_PX[sz], color: yellowShade, weight: 2.5, opacity: 0.95,
        fillColor: yellow, fillOpacity: dark ? 0.3 : 0.28,
      }).bindTooltip(
        `<b>ZIP ${escapeHtml(z.zip)}</b><br>${z.count} student${z.count === 1 ? '' : 's'} live near here`,
        { direction: 'top', sticky: true },
      ).addTo(state.layers.zips);
      L.marker([z.lat, z.lng], {
        icon: pillIcon(`${String(z.zip).replace(/\D/g, '')} · ${z.count}`, DISC_PX[sz]), interactive: false, zIndexOffset: 0,
      }).addTo(state.layers.zips);
    }

    // Schools: blue path nodes with the count inside; top 3 wear medal rings.
    const schoolList = (d.schools || []).filter((s) => s.lat != null && s.lng != null);
    const ranked = (d.schools || []).slice().sort((a, b) => b.count - a.count).slice(0, 3).map((s) => s.name);
    const steps = sizeSteps(Math.max(1, ...schoolList.map((s) => s.count)));
    for (const s of schoolList) {
      pts.push([s.lat, s.lng]);
      const sz = sizeClass(s.count, steps);
      const rank = ranked.indexOf(s.name);
      const share = Math.round((s.count / total) * 100);
      L.marker([s.lat, s.lng], {
        icon: nodeIcon('node-school ' + sz + (rank >= 0 ? ' rank-' + (rank + 1) : ''), s.count, NODE_PX[sz]),
        zIndexOffset: 100 + s.count, riseOnHover: true,
      }).bindTooltip(`<b>${escapeHtml(s.name)}</b><br>${s.count} student${s.count === 1 ? '' : 's'}`, { direction: 'top' })
        .bindPopup(`<b>${escapeHtml(s.name)}</b><br>${s.count} student${s.count === 1 ? '' : 's'} · ${share}% of this scope${rank >= 0 ? `<br>#${rank + 1} school` : ''}`)
        .addTo(state.layers.schools);
    }

    // The centers themselves: red "M" home nodes.
    for (const c of d.centerPins || []) {
      if (c.lat == null || c.lng == null) continue;
      pts.push([c.lat, c.lng]);
      const m = L.marker([c.lat, c.lng], {
        icon: nodeIcon('node-home' + (c.approx ? ' approx' : ''), 'M', 56, c.members), zIndexOffset: 1000, riseOnHover: true,
      }).bindTooltip(
        `<b>Mathnasium ${escapeHtml(c.name)}</b><br>${c.members != null ? c.members + ' students · ' : ''}click to zoom in${c.approx ? '<br>approximate location' : ''}`,
        { direction: 'top' },
      );
      m.on('click', () => state.map.flyTo([c.lat, c.lng], Math.max(state.map.getZoom(), 12), { duration: 0.8 }));
      m.addTo(state.layers.centers);
    }

    applyMapToggles();
    buildMapKey(d, steps);
    if (pts.length) state.map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
    applyZoomVisibility();
  }

  function applyMapToggles() {
    if (!state.map || !state.layers) return;
    const wantS = $('#tglSchools').checked;
    const wantZ = $('#tglZips').checked;
    toggleLayer(state.layers.zips, wantZ);   // discs under the nodes
    toggleLayer(state.layers.schools, wantS);
    toggleLayer(state.layers.centers, true);
  }
  function toggleLayer(layer, want) {
    const on = state.map.hasLayer(layer);
    if (want && !on) layer.addTo(state.map);
    if (!want && on) state.map.removeLayer(layer);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- needs-attention queue ----------
  const QUEUE_TABS = [
    { key: 'runningOut', label: 'Running out', icon: 'hourglass', hint: '2 or fewer sessions left on their plan',
      empty: 'Nobody is about to run out of sessions.' },
    { key: 'holdsList', label: 'On hold', icon: 'pause', hint: 'longest holds first - 30+ days is a renewal risk',
      empty: 'No students on hold.' },
    { key: 'belowAverage', label: 'Dropped', icon: 'down', hint: 'longer since their last visit than this center\'s average',
      empty: "Everyone's attendance is on track." },
  ];

  function renderQueue(d, allScope) {
    const lists = { runningOut: d.runningOut || [], holdsList: d.holdsList || [], belowAverage: d.belowAverage || [] };
    if (!lists[state.queueTab]) state.queueTab = 'runningOut';

    $('#queueTabs').replaceChildren(...QUEUE_TABS.map((t) => h('button', {
      type: 'button', role: 'tab', class: 'queue-tab' + (state.queueTab === t.key ? ' active' : ''),
      'aria-selected': String(state.queueTab === t.key), title: t.hint, 'data-tab': t.key,
    }, [
      icon(t.icon),
      h('span', { text: t.label }),
      h('span', { class: 'count', text: String(lists[t.key].length) }),
    ])));

    const tab = QUEUE_TABS.find((t) => t.key === state.queueTab);
    const rows = lists[state.queueTab];
    const cols = ['Student', ...(allScope ? ['Center'] : [])];
    let cell;
    if (state.queueTab === 'runningOut') {
      cols.push('Plan', 'Left', 'Seen');
      cell = (r) => [
        h('td', {}, [h('span', { text: r.plan || '—' }), r.isPackage ? h('span', { class: 'pill', text: 'package' }) : null]),
        h('td', { class: 'num ' + (r.sessionsLeft <= 1 ? 'flag' : ''), text: String(r.sessionsLeft) }),
        h('td', { class: 'num', text: r.daysSinceVisit == null ? '—' : `${r.daysSinceVisit}d ago` }),
      ];
    } else if (state.queueTab === 'holdsList') {
      cols.push('School', 'On hold');
      cell = (r) => [
        h('td', { text: r.school || '—' }),
        h('td', { class: 'num ' + (r.daysOnHold >= 30 ? 'flag' : ''),
          text: r.daysOnHold == null ? '—' : `${r.daysOnHold}d${r.exact ? '' : '*'}` }),
      ];
    } else {
      cols.push('School', 'Seen');
      cell = (r) => [
        h('td', { text: r.school || '—' }),
        h('td', { class: 'num', text: r.daysSinceVisit == null ? '—' : `${r.daysSinceVisit}d ago` }),
      ];
    }

    $('#queueWrap').replaceChildren(h('table', { class: 'data-table queue-table' }, [
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { text: c })))),
      h('tbody', {}, rows.map((r) => h('tr', {}, [
        h('td', { text: r.name || '—' }),
        ...(allScope ? [h('td', { text: r.center || '—' })] : []),
        ...cell(r),
      ]))),
    ]));
    const empty = $('#queueEmpty');
    empty.hidden = rows.length > 0;
    empty.textContent = tab.empty;
    $('#queueWrap').hidden = rows.length === 0;
    if (state.queueTab === 'holdsList' && rows.some((r) => !r.exact)) {
      empty.hidden = false;
      empty.textContent = rows.length ? '* estimated from last visit (not in the Radius Holds report)' : tab.empty;
    }
  }

  // ---------- alerts (sync health, default password) ----------
  function renderAlerts(o) {
    const bar = $('#alertBar');
    const items = [];
    const sync = o.sync || {};
    if (sync.failures >= 2) {
      const since = sync.lastSuccessAt ? new Date(sync.lastSuccessAt).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : 'unknown';
      items.push({ level: 'bad', text: `Radius sync is failing (${sync.failures} in a row). Showing the last good data from ${since}. ${sync.lastError ? 'Error: ' + sync.lastError : ''}` });
    } else if (o.mode === 'live' && o.lastSync && Date.now() - Date.parse(o.lastSync) > 10 * 60 * 1000) {
      items.push({ level: 'warn', text: 'Data may be stale - last successful Radius sync was ' + new Date(o.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.' });
    }
    if (o.defaultPassword) {
      items.push({ level: 'warn', text: 'This dashboard is still on the default password (1234). It shows student names - set a real DASHBOARD_PASSWORD in Vercel (Settings → Environment Variables) and redeploy.' });
    }
    bar.hidden = items.length === 0;
    bar.replaceChildren(...items.map((it) => h('div', { class: 'alert ' + it.level, text: it.text })));
  }

  function renderAll() {
    if (!state.overview) return;
    renderChrome();
    renderCenters();
    renderDetail();
    renderByCenter();
    renderInNow();
    renderTrend();
    renderHours();
    renderRoster();
  }

  // ---------- events ----------
  function setCenter(v) {
    state.center = v;
    $('#centerFilter').value = v;
    refresh(true);
  }

  $('#centerFilter').addEventListener('change', (e) => setCenter(e.target.value));
  $('#rangeFilter').addEventListener('change', (e) => { state.days = Number(e.target.value); refresh(true); });
  $('#rosterSearch').addEventListener('input', (e) => { state.search = e.target.value; renderRoster(); });
  $('#tglSchools').addEventListener('change', applyMapToggles);
  $('#tglZips').addEventListener('change', applyMapToggles);
  $('#queueTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.queue-tab');
    if (!btn) return;
    state.queueTab = btn.dataset.tab;
    if (state.detail) renderQueue(state.detail, !state.center);
  });
  const segBtns = document.querySelectorAll('.seg-btn[data-base]');
  segBtns.forEach((b) => b.classList.toggle('active', b.dataset.base === state.basemap));
  segBtns.forEach((b) => b.addEventListener('click', () => {
    state.basemap = b.dataset.base;
    segBtns.forEach((x) => x.classList.toggle('active', x === b));
    try { localStorage.setItem('mn-basemap', state.basemap); } catch (e) { /* private mode */ }
    if (state.detail) renderMap(state.detail);
  }));

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.table-toggle');
    if (!btn) return;
    const t = document.getElementById(btn.dataset.target);
    t.hidden = !t.hidden;
    btn.textContent = t.hidden ? 'Table' : 'Chart data ✓';
  });

  // theme toggle: light <-> dark, remembered per browser
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mn-theme', next); } catch (e) { /* private mode */ }
    if (state.detail) renderMap(state.detail);
  });
  try {
    const saved = localStorage.getItem('mn-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (e) { /* private mode */ }

  // ---------- lock overlay ----------
  function showLock(message) {
    $('#lock').hidden = false;
    if (message) $('#lockMsg').textContent = message;
    $('#lockPass').focus();
  }
  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#lockPass').value }),
    });
    if (res.ok) {
      $('#lock').hidden = true;
      $('#lockPass').value = '';
      $('#lockMsg').textContent = 'Enter the dashboard password to continue.';
      refresh(true);
    } else {
      let msg = 'Wrong password - try again.';
      try { msg = (await res.json()).error || msg; } catch (e) { /* non-JSON */ }
      $('#lockMsg').textContent = msg;
    }
  });

  // ---------- Radius connect overlay ----------
  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setupErr');
    err.hidden = true;
    const btn = $('#setupGo');
    btn.disabled = true;
    btn.textContent = 'Checking with Radius…';
    try {
      const res = await fetch('/api/radius-setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#setupUser').value, password: $('#setupPass').value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        $('#setup').hidden = true;
        $('#setupPass').value = '';
        state.rosters.clear();
        refresh(true);
      } else {
        err.textContent = body.error || 'That login did not work - try again.';
        err.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
  $('#setupSkip').addEventListener('click', () => {
    $('#setup').hidden = true;
    try { sessionStorage.setItem('mn-setup-skip', '1'); } catch (e) { /* private mode */ }
  });

  // ---------- rail: highlight the section in view ----------
  const navItems = [...document.querySelectorAll('.nav-item[data-nav]')];
  const navSections = navItems.map((a) => document.getElementById(a.dataset.nav)).filter(Boolean);
  let navTick = false;
  function updateNav() {
    navTick = false;
    const line = window.scrollY + window.innerHeight * 0.3;
    let current = navSections[0];
    for (const sec of navSections) if (sec.offsetTop <= line) current = sec;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) current = navSections[navSections.length - 1];
    navItems.forEach((a) => a.classList.toggle('active', current && a.dataset.nav === current.id));
  }
  window.addEventListener('scroll', () => { if (!navTick) { navTick = true; requestAnimationFrame(updateNav); } }, { passive: true });
  window.addEventListener('resize', updateNav);

  // ---------- refresh loop ----------
  let refreshing = false;
  async function refresh(full) {
    if (refreshing) return;
    refreshing = true;
    $('#main').classList.add('refreshing');
    try {
      await loadOverview();
      await Promise.all([
        loadTrends(),
        full || state.rosters.size === 0 ? loadRosters() : Promise.resolve(),
      ]);
      renderAll();
      if (full) refreshDetail(); // heavier; don't block the overview paint
    } catch (e) {
      if (e && e.auth) showLock();
      else if (e && e.status === 503) showLock(e.msg);
      else $('#lastSync').textContent = (e && e.msg) ? e.msg : 'Connection lost - retrying…';
    } finally {
      $('#main').classList.remove('refreshing');
      refreshing = false;
    }
  }

  let detailTimer = null;
  let detailLoading = false;
  function refreshDetail() {
    if (detailLoading) return;
    detailLoading = true;
    clearTimeout(detailTimer);
    loadDetail()
      .then(() => {
        renderDetail();
        // While places are still being located, come back sooner so the map
        // fills in progressively instead of waiting for the 5-minute cycle.
        if (state.detail && state.detail.geocodePending > 0) detailTimer = setTimeout(refreshDetail, 15000);
      })
      .catch((e) => { if (e && e.auth) showLock(); })
      .finally(() => { detailLoading = false; });
  }

  refresh(true);
  setInterval(() => refresh(false), 20000);       // live counters
  setInterval(refreshDetail, 5 * 60000);          // stats + map
  setInterval(() => loadRosters().then(renderRoster).catch(() => {}), 5 * 60000);
})();
