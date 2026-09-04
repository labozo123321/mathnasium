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
    staffHours: [],
    cohorts: null,      // monthly joined / left / roster / tenure
    pinned: null,       // month key pinned by the finder, e.g. '2026-03'
    finderText: '',
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
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    dollar: '<path d="M12 2v20M17 6.5c-1-1.5-2.5-2-5-2s-4.5 1-4.5 3 1.5 3 4.5 3.5 5 1.5 5 3.5-2 3.5-5 3.5-4.5-1-5.5-2.5"/>',
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
  async function loadCohorts() {
    try {
      const q = state.center ? '?center=' + state.center : '';
      state.cohorts = await apiFetch('/api/cohorts' + q);
    } catch (e) {
      if (e && e.auth) throw e;
      state.cohorts = null;
    }
  }

  async function loadStaffHours() {
    try {
      state.staffHours = (await apiFetch('/api/staff-hours' + (state.center ? '?center=' + state.center : ''))).rows || [];
    } catch (e) {
      if (e && e.auth) throw e;
      state.staffHours = [];
    }
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
          h('span', {
            class: 'ratio ' + (c.ratioLevel || 'idle'),
            title: c.checkedIn && c.staffIn ? `${c.ratio} students per instructor right now` : 'students per instructor right now',
            text: c.staffIn == null ? '—' : !c.checkedIn ? 'quiet' : !c.staffIn ? 'no staff' : `${c.ratio}:1`,
          }),
        ]),
        h('div', { class: 'row' }, [
          h('span', { text: `Today: ${c.visitsToday == null ? '—' : c.visitsToday}` }),
          c.typicalVisits != null
            ? h('span', { class: 'typical', text: `typical ${(c.weekday || '').slice(0, 3)}: ${c.typicalVisits}`, title: 'average for this weekday over the last 8 weeks' })
            : h('span', { class: 'typical', text: 'typical: —', title: 'needs a few weeks of history' }),
        ]),
        sparkSvg(c.byHourToday || {}),
      ]);
      if (c.understaffedToday > 0) card.appendChild(h('div', { class: 'warn-line', text: `${c.understaffedToday} min understaffed today` }));
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

  // ---------- busiest hours by weekday (heatmap from the trend history) ----------
  const HEAT_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hourLabel = (hh) => (hh === 12 ? '12p' : hh > 12 ? (hh - 12) + 'p' : hh + 'a');
  const hourLong = (hh) => (hh === 12 ? '12 PM' : hh > 12 ? (hh - 12) + ' PM' : hh + ' AM');
  function renderHeatmap() {
    const box = $('#heatChart');
    const days = state.trends || [];
    const sum = Array.from({ length: 7 }, () => ({}));
    const nDays = new Array(7).fill(0);
    for (const d of days) {
      const dow = (new Date(d.date + 'T00:00:00').getDay() + 6) % 7; // Mon = 0
      nDays[dow]++;
      for (const [hh, n] of Object.entries(d.byHour || {})) sum[dow][hh] = (sum[dow][hh] || 0) + n;
    }
    const rows = WEEKDAYS.map((_, i) => i).filter((i) => nDays[i] > 0);
    if (!rows.length) {
      box.replaceChildren(h('p', { class: 'muted empty', text: 'Builds up from the daily history - check back after a few days.' }));
      $('#heatTable').replaceChildren();
      $('#heatNote').textContent = '';
      return;
    }
    const avg = (i, hh) => (sum[i][hh] || 0) / nDays[i];
    const max = Math.max(1, ...rows.flatMap((i) => HEAT_HOURS.map((hh) => avg(i, hh))));
    const W = 720; const left = 44; const top = 22; const cw = (W - left - 8) / HEAT_HOURS.length; const ch = 34; const gap = 3;
    const Hgt = top + rows.length * ch + 6;
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Average arrivals by weekday and hour' });
    HEAT_HOURS.forEach((hh, j) => svg.appendChild(h('text', { x: left + j * cw + cw / 2, y: 14, 'text-anchor': 'middle', text: hourLabel(hh) })));
    const now = new Date();
    const nowDow = (now.getDay() + 6) % 7;
    const dark = isDarkTheme(); // dark ramp runs dark -> light, so strong cells need dark ink
    const inkFor = (step) => (dark ? (step >= 3 ? '#131F24' : 'var(--text-primary)') : (step >= 3 ? '#fff' : 'var(--text-primary)'));
    rows.forEach((i, r) => {
      const y = top + r * ch;
      svg.appendChild(h('text', { x: left - 8, y: y + ch / 2 + 4, 'text-anchor': 'end', text: WEEKDAYS[i] }));
      HEAT_HOURS.forEach((hh, j) => {
        const v = avg(i, hh);
        const step = v <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil((v / max) * 5)));
        const x = left + j * cw;
        const fill = step === 0 ? 'var(--surface-2)' : `var(--heat-${step})`;
        const isNow = i === nowDow && hh === now.getHours();
        svg.appendChild(h('rect', {
          x: x + gap / 2, y: y + gap / 2, width: cw - gap, height: ch - gap, rx: 8, fill,
          stroke: isNow ? 'var(--text-primary)' : 'none', 'stroke-width': isNow ? 2.5 : 0,
          onpointermove: (e) => showTip(e, tipRows(`${Math.round(v * 10) / 10} arrivals`, `${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]} ${hourLong(hh)} · average over ${nDays[i]} day${nDays[i] === 1 ? '' : 's'}`)),
          onpointerleave: hideTip,
        }));
        if (v >= 0.5) {
          svg.appendChild(h('text', {
            x: x + cw / 2, y: y + ch / 2 + 4, 'text-anchor': 'middle', class: 'cell-label',
            style: 'fill:' + inkFor(step), text: String(Math.round(v)),
          }));
        }
      });
    });
    box.replaceChildren(svg);
    $('#heatNote').textContent = `average arrivals per hour · last ${days.length} days · outlined = right now`;
    $('#heatTable').replaceChildren(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', { text: 'Day' }), ...HEAT_HOURS.map((hh) => h('th', { text: hourLabel(hh) }))])),
      h('tbody', {}, rows.map((i) => h('tr', {}, [h('td', { text: WEEKDAYS[i] }), ...HEAT_HOURS.map((hh) => h('td', { class: 'num', text: String(Math.round(avg(i, hh) * 10) / 10) }))]))),
    ]));
  }

  // ---------- staffing coverage today (small multiples) ----------
  const RATIO_BAD = 6; // keep in step with dayStats.js
  const isBad = (p) => p.s > 0 && (p.e === 0 || p.s / p.e > RATIO_BAD);
  const fmtClock = (m) => { const hh = Math.floor(m / 60); const mm = m % 60; return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`; };
  function coverageSvg(c, wide) {
    const pts = c.coverage || [];
    const W = wide ? 960 : 320; const Hgt = wide ? 200 : 120; const left = 26; const right = 8; const top = 10; const bottom = 18;
    const iw = W - left - right; const ih = Hgt - top - bottom;
    const T0 = 9 * 60; const T1 = 21 * 60;
    const x = (t) => left + ((t - T0) / (T1 - T0)) * iw;
    const max = Math.max(4, ...pts.map((p) => Math.max(p.s, p.e)));
    const y = (v) => top + ih - (v / max) * ih;
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': `Students and instructors through the day at ${c.name}` });
    for (const hh of [10, 12, 14, 16, 18, 20]) {
      svg.appendChild(h('line', { x1: x(hh * 60), y1: top, x2: x(hh * 60), y2: top + ih, stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: x(hh * 60), y: Hgt - 5, 'text-anchor': 'middle', text: hourLabel(hh) }));
    }
    svg.appendChild(h('text', { x: left - 4, y: top + 4, 'text-anchor': 'end', text: String(max) }));
    svg.appendChild(h('text', { x: left - 4, y: top + ih, 'text-anchor': 'end', text: '0' }));
    if (!pts.length) {
      svg.appendChild(h('text', { x: left + iw / 2, y: top + ih / 2, 'text-anchor': 'middle', text: 'no check-ins yet' }));
      return svg;
    }
    // understaffed bands (merge consecutive bad buckets)
    let start = null;
    const bands = [];
    pts.forEach((p, i) => {
      if (isBad(p) && start == null) start = p.t;
      if ((!isBad(p) || i === pts.length - 1) && start != null) { bands.push([start, isBad(p) ? p.t + 15 : p.t]); start = null; }
    });
    for (const [a, b] of bands) svg.appendChild(h('rect', { x: x(a), y: top, width: Math.max(2, x(b) - x(a)), height: ih, fill: 'rgba(255, 75, 75, 0.22)' }));
    const sPts = pts.map((p) => `${x(p.t)},${y(p.s)}`).join(' ');
    svg.appendChild(h('path', { d: `M${x(pts[0].t)},${y(0)} L${sPts.split(' ').join(' L')} L${x(pts[pts.length - 1].t)},${y(0)} Z`, fill: 'var(--series-1-wash)', stroke: 'none' }));
    svg.appendChild(h('polyline', { points: sPts, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    svg.appendChild(h('polyline', { points: pts.map((p) => `${x(p.t)},${y(p.e)}`).join(' '), fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const peak = pts.reduce((a, p) => (p.s > a.s ? p : a), pts[0]);
    if (peak.s > 0) svg.appendChild(h('text', { x: Math.min(x(peak.t), W - right - 14), y: Math.max(y(peak.s) - 5, 9), 'text-anchor': 'middle', class: 'val-label', text: String(peak.s) }));
    const cross = h('line', { y1: top, y2: top + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    svg.appendChild(cross);
    svg.appendChild(h('rect', {
      x: left, y: top, width: iw, height: ih, fill: 'transparent',
      onpointermove: (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const t = T0 + ((px - left) / iw) * (T1 - T0);
        let best = pts[0];
        for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('visibility', 'visible');
        const ratio = best.e ? `${Math.round((best.s / best.e) * 10) / 10}:1` : (best.s ? 'nobody on the floor' : '—');
        showTip(e, tipRows(`${best.s} students · ${best.e} instructor${best.e === 1 ? '' : 's'}`, `${fmtClock(best.t)} · ${ratio}${isBad(best) ? ' · understaffed' : ''}`));
      },
      onpointerleave: () => { cross.setAttribute('visibility', 'hidden'); hideTip(); },
    }));
    return svg;
  }
  function renderCoverage() {
    const centers = visibleCenters();
    const grid = $('#coverageChart');
    grid.classList.toggle('single', centers.length === 1);
    const any = centers.some((c) => (c.coverage || []).length);
    $('#coverageEmpty').hidden = any;
    grid.replaceChildren(...centers.map((c) => h('div', { class: 'cov' }, [
      h('div', { class: 'cov-head' }, [
        h('span', { class: 'name', text: c.name }),
        h('span', { class: 'muted', text: c.understaffedToday ? `${c.understaffedToday} min understaffed` : 'covered all day' }),
      ]),
      coverageSvg(c, centers.length === 1),
    ])));
  }

  // ---------- new enrollments by month ----------
  function renderMonthly(d) {
    const data = d.monthly || [];
    const box = $('#monthlyChart');
    if (!data.length) { box.replaceChildren(h('p', { class: 'muted empty', text: 'No enrollment data yet.' })); return; }
    const W = 420; const Hgt = 170; const left = 30; const right = 8; const top = 18; const bottom = 24;
    const iw = W - left - right; const ih = Hgt - top - bottom;
    const max = Math.max(1, ...data.map((m) => m.enrolled));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    const bw = Math.min(iw / data.length - 5, 26);
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'New enrollments per month, last 12 months' });
    for (const t of ticks) {
      const yy = top + ih - (t / topVal) * ih;
      svg.appendChild(h('line', { x1: left, y1: yy, x2: W - right, y2: yy, stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: left - 5, y: yy + 3, 'text-anchor': 'end', text: String(t) }));
    }
    const monthName = (k) => new Date(k + '-15T00:00:00').toLocaleString([], { month: 'short' });
    data.forEach((m, i) => {
      const cx = left + i * (iw / data.length) + (iw / data.length) / 2;
      const bh = (m.enrolled / topVal) * ih;
      const current = i === data.length - 1;
      if (m.enrolled > 0) svg.appendChild(h('path', { d: barPath(cx - bw / 2, top + ih - bh, bw, bh, 4, false), fill: current ? 'var(--series-1-wash)' : 'var(--series-1)', stroke: current ? 'var(--series-1)' : 'none', 'stroke-width': current ? 2 : 0 }));
      if (i % 2 === 0 || current) svg.appendChild(h('text', { x: cx, y: Hgt - 7, 'text-anchor': 'middle', text: monthName(m.month) }));
      if (m.enrolled === max || current) svg.appendChild(h('text', { x: cx, y: top + ih - bh - 5, 'text-anchor': 'middle', class: 'val-label', text: String(m.enrolled) }));
      svg.appendChild(h('rect', {
        x: cx - (iw / data.length) / 2, y: top, width: iw / data.length, height: ih, fill: 'transparent',
        onpointermove: (e) => showTip(e, tipRows(`${m.enrolled} enrolled`, `${new Date(m.month + '-15T00:00:00').toLocaleString([], { month: 'long', year: 'numeric' })} · $${m.collected.toLocaleString()} collected at sign-up${current ? ' · month so far' : ''}`)),
        onpointerleave: hideTip,
      }));
    });
    box.replaceChildren(svg);
    $('#monthlyTable').replaceChildren(h('table', {}, [
      h('thead', {}, h('tr', {}, [h('th', { text: 'Month' }), h('th', { text: 'Enrolled' }), h('th', { text: 'Collected at sign-up' })])),
      h('tbody', {}, data.slice().reverse().map((m) => h('tr', {}, [h('td', { text: m.month }), h('td', { class: 'num', text: String(m.enrolled) }), h('td', { class: 'num', text: '$' + m.collected.toLocaleString() })]))),
    ]));
    const r = d.referrals || {};
    $('#monthlyNote').textContent = r.total
      ? `${r.referred} of ${r.total} opportunities in the last 12 months came from a parent referral (${Math.round((r.referred / r.total) * 100)}%). Radius records no other source, so ask staff to fill in the referral field.`
      : '';
  }


  // ---------- growth & retention ----------
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const shortMonth = (key) => MONTH_NAMES[Number(key.slice(5, 7)) - 1].slice(0, 3);
  const monthsOf = () => (state.cohorts && state.cohorts.months) || [];
  const pinnedRow = () => monthsOf().find((m) => m.month === state.pinned) || null;

  // Turn what someone types into a month key. Understands "March 2026",
  // "mar 26", "2026-03", "3/2026", "last month", and the superlatives.
  function resolveMonthQuery(raw) {
    const months = monthsOf();
    if (!months.length) return null;
    const q = String(raw || '').trim().toLowerCase();
    if (!q) return null;
    const pick = (fn, empty) => {
      const pool = months.filter(empty);
      if (!pool.length) return null;
      return pool.reduce(fn).month;
    };
    if (/^(this|current) month$/.test(q)) return months[months.length - 1].month;
    if (/^last month$/.test(q)) return (months[months.length - 2] || months[months.length - 1]).month;
    if (/best|biggest gain|top|grew|growth/.test(q)) return pick((a, b) => (b.net > a.net ? b : a), () => true);
    if (/worst|biggest drop|biggest loss|decline|shrank/.test(q)) return pick((a, b) => (b.net < a.net ? b : a), () => true);
    if (/most joined|busiest|most sign|most new/.test(q)) return pick((a, b) => (b.joined > a.joined ? b : a), () => true);
    if (/most left|most churn|worst churn/.test(q)) return pick((a, b) => (b.left > a.left ? b : a), () => true);
    if (/longest stay|loyal/.test(q)) return pick((a, b) => ((b.medianStay || 0) > (a.medianStay || 0) ? b : a), (m) => m.medianStay != null);
    if (/shortest stay/.test(q)) return pick((a, b) => ((b.medianStay || 0) < (a.medianStay || 0) ? b : a), (m) => m.medianStay != null);

    const iso = /(\d{4})[-/](\d{1,2})/.exec(q);          // 2026-03 or 2026/3
    if (iso) return months.find((m) => m.month === `${iso[1]}-${String(iso[2]).padStart(2, '0')}`)?.month || null;
    const us = /^(\d{1,2})[-/](\d{4})$/.exec(q);          // 3/2026
    if (us) return months.find((m) => m.month === `${us[2]}-${String(us[1]).padStart(2, '0')}`)?.month || null;

    const name = MONTH_NAMES.findIndex((n) => q.startsWith(n.slice(0, 3).toLowerCase()));
    if (name >= 0) {
      const yr = /(\d{4})/.exec(q) || /'?(\d{2})\b/.exec(q);
      const year = yr ? (yr[1].length === 2 ? 2000 + Number(yr[1]) : Number(yr[1])) : null;
      const key = (y) => `${y}-${String(name + 1).padStart(2, '0')}`;
      if (year) return months.find((m) => m.month === key(year))?.month || null;
      // no year given: the most recent month with that name
      for (let i = months.length - 1; i >= 0; i--) if (months[i].month.slice(5) === String(name + 1).padStart(2, '0')) return months[i].month;
    }
    return null;
  }

  function setPinned(monthKey, { fromInput = false } = {}) {
    state.pinned = monthKey || null;
    if (!fromInput) $('#monthSearch').value = monthKey ? monthLabelOf(monthKey) : '';
    $('#finderClear').hidden = !monthKey && !$('#monthSearch').value;
    renderGrowth();
  }
  const monthLabelOf = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

  function renderFinderChips() {
    const months = monthsOf();
    const box = $('#finderChips');
    if (!months.length) { box.replaceChildren(); return; }
    const best = months.reduce((a, b) => (b.net > a.net ? b : a));
    const worst = months.reduce((a, b) => (b.net < a.net ? b : a));
    const busiest = months.reduce((a, b) => (b.joined > a.joined ? b : a));
    const shortcuts = [
      { label: 'This month', key: months[months.length - 1].month, val: null },
      { label: 'Best month', key: best.month, val: `${best.net >= 0 ? '+' : ''}${best.net}` },
      { label: 'Worst month', key: worst.month, val: `${worst.net}` },
      { label: 'Most joined', key: busiest.month, val: `+${busiest.joined}` },
    ];
    box.replaceChildren(...shortcuts.map((sc) => h('button', {
      type: 'button', class: 'chip' + (state.pinned === sc.key ? ' active' : ''),
      onclick: () => setPinned(state.pinned === sc.key ? null : sc.key),
    }, [
      h('span', { text: sc.label }),
      sc.val ? h('span', { class: 'chip-val', text: sc.val }) : null,
    ])));
  }

  function renderPinCard() {
    const card = $('#pinCard');
    const row = pinnedRow();
    if (!row) { card.hidden = true; card.replaceChildren(); return; }
    const months = monthsOf();
    const i = months.indexOf(row);
    const prev = i > 0 ? months[i - 1] : null;
    const delta = (cur, before, invert) => {
      if (before == null || cur == null) return h('div', { class: 'pd flat', text: 'no earlier month' });
      const d = Math.round((cur - before) * 10) / 10;
      const good = invert ? d < 0 : d > 0;
      const cls = d === 0 ? 'flat' : (good ? 'up' : 'down');
      return h('div', { class: 'pd ' + cls, text: `${d > 0 ? '+' : ''}${d} vs ${shortMonth(prev.month)}` });
    };
    const stat = (label, value, deltaEl) => h('div', { class: 'pin-stat' }, [
      h('div', { class: 'pv', text: value }),
      h('div', { class: 'pl', text: label }),
      deltaEl,
    ]);
    card.hidden = false;
    card.replaceChildren(
      h('div', { class: 'pin-head' }, [
        h('h3', { text: row.label }),
        h('span', { class: 'muted', text: state.cohorts.scope }),
        h('span', { class: 'muted', text: row.net >= 0 ? `grew by ${row.net}` : `shrank by ${Math.abs(row.net)}` }),
      ]),
      h('div', { class: 'pin-stats' }, [
        stat('Joined', String(row.joined), delta(row.joined, prev && prev.joined, false)),
        stat('Left', String(row.left), delta(row.left, prev && prev.left, true)),
        stat('Net change', `${row.net >= 0 ? '+' : ''}${row.net}`, delta(row.net, prev && prev.net, false)),
        stat('Active at month end', String(row.active), delta(row.active, prev && prev.active, false)),
        stat('Kept', row.retention == null ? '—' : row.retention + '%', delta(row.retention, prev && prev.retention, false)),
        stat('Median stay', row.medianStay == null ? '—' : row.medianStay + ' mo',
          row.leaverCount ? h('div', { class: 'pd flat', text: `${row.leaverCount} student${row.leaverCount === 1 ? '' : 's'} left` }) : h('div', { class: 'pd flat', text: 'nobody left' })),
      ]),
    );
  }

  // Shared x-scale helpers for the three growth charts.
  function growthGeom(W, Hgt, left, right, top, bottom) {
    const months = monthsOf();
    const iw = W - left - right;
    const step = iw / Math.max(1, months.length);
    return { months, iw, ih: Hgt - top - bottom, step, xMid: (i) => left + i * step + step / 2 };
  }

  function monthTicks(svg, g, left, Hgt) {
    const n = g.months.length;
    const every = n > 30 ? 6 : n > 18 ? 3 : 2;
    g.months.forEach((m, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const label = shortMonth(m.month) + (m.month.slice(5, 7) === '01' || i === 0 ? ` ’${m.month.slice(2, 4)}` : '');
      svg.appendChild(h('text', { x: g.xMid(i), y: Hgt - 6, 'text-anchor': 'middle', text: label }));
    });
  }

  // Pin marker drawn behind the marks on every chart.
  function pinBand(svg, g, top, ih) {
    if (!state.pinned) return;
    const i = g.months.findIndex((m) => m.month === state.pinned);
    if (i < 0) return;
    svg.appendChild(h('rect', { class: 'pin-band', x: g.xMid(i) - g.step / 2, y: top, width: g.step, height: ih, rx: 6 }));
    svg.appendChild(h('line', { class: 'pin-rule', x1: g.xMid(i), y1: top, x2: g.xMid(i), y2: top + ih }));
  }

  function hitAreas(svg, g, top, ih, tipFor) {
    g.months.forEach((m, i) => {
      svg.appendChild(h('rect', {
        x: g.xMid(i) - g.step / 2, y: top, width: g.step, height: ih, fill: 'transparent', style: 'cursor:pointer',
        onpointermove: (e) => showTip(e, tipFor(m)),
        onpointerleave: hideTip,
        onclick: () => setPinned(state.pinned === m.month ? null : m.month),
      }));
    });
  }

  // 1) Joined above the axis, left below it, net as a dashed line.
  function renderFlowChart() {
    const box = $('#flowChart');
    const W = 960; const Hgt = 300; const left = 40; const right = 14; const top = 16; const bottom = 24;
    const g = growthGeom(W, Hgt, left, right, top, bottom);
    if (!g.months.length) { box.replaceChildren(); return; }
    const max = Math.max(1, ...g.months.map((m) => Math.max(m.joined, m.left)));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    const midY = top + g.ih / 2;
    const y = (v) => midY - (v / topVal) * (g.ih / 2);
    const bw = Math.min(g.step - 6, 26);
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Students who joined and left each month' });
    pinBand(svg, g, top, g.ih);
    for (const t of ticks) {
      if (t === 0) continue;
      for (const sign of [1, -1]) {
        svg.appendChild(h('line', { x1: left, y1: y(t * sign), x2: W - right, y2: y(t * sign), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      }
      svg.appendChild(h('text', { x: left - 6, y: y(t) + 3, 'text-anchor': 'end', text: String(t) }));
      svg.appendChild(h('text', { x: left - 6, y: y(-t) + 3, 'text-anchor': 'end', text: String(t) }));
    }
    svg.appendChild(h('line', { class: 'zero-rule', x1: left, y1: midY, x2: W - right, y2: midY }));
    g.months.forEach((m, i) => {
      const cx = g.xMid(i);
      if (m.joined > 0) {
        const bh = (m.joined / topVal) * (g.ih / 2);
        svg.appendChild(h('path', { d: barPath(cx - bw / 2, midY - bh, bw, bh, 4, false), fill: 'var(--joined)' }));
      }
      if (m.left > 0) {
        const bh = (m.left / topVal) * (g.ih / 2);
        // grows downward from the zero line: same path, flipped
        svg.appendChild(h('path', {
          d: barPath(cx - bw / 2, midY, bw, bh, 4, false),
          fill: 'var(--leftc)', transform: `rotate(180 ${cx} ${midY + bh / 2})`,
        }));
      }
    });
    const netPts = g.months.map((m, i) => `${g.xMid(i)},${y(m.net)}`).join(' ');
    svg.appendChild(h('polyline', {
      points: netPts, fill: 'none', stroke: 'var(--text-secondary)', 'stroke-width': 2,
      'stroke-dasharray': '5 4', 'stroke-linejoin': 'round',
    }));
    g.months.forEach((m, i) => svg.appendChild(h('circle', {
      cx: g.xMid(i), cy: y(m.net), r: 3.5, fill: 'var(--surface)', stroke: 'var(--text-secondary)', 'stroke-width': 2,
    })));
    monthTicks(svg, g, left, Hgt);
    hitAreas(svg, g, top, g.ih, (m) => tipRows(
      `${m.joined} joined · ${m.left} left`,
      `${m.label} · net ${m.net >= 0 ? '+' : ''}${m.net} · ${m.active} active at month end`,
    ));
    box.replaceChildren(svg);

    $('#flowTable').replaceChildren(h('table', {}, [
      h('thead', {}, h('tr', {}, ['Month', 'Joined', 'Left', 'Net', 'Active', 'Kept', 'Median stay'].map((t) => h('th', { text: t })))),
      h('tbody', {}, g.months.slice().reverse().map((m) => h('tr', {}, [
        h('td', { text: m.label }),
        h('td', { class: 'num', text: String(m.joined) }),
        h('td', { class: 'num', text: String(m.left) }),
        h('td', { class: 'num', text: `${m.net >= 0 ? '+' : ''}${m.net}` }),
        h('td', { class: 'num', text: String(m.active) }),
        h('td', { class: 'num', text: m.retention == null ? '—' : m.retention + '%' }),
        h('td', { class: 'num', text: m.medianStay == null ? '—' : m.medianStay + ' mo' }),
      ]))),
    ]));
  }

  // 2) Roster headcount at each month end.
  function renderRosterChart() {
    const box = $('#rosterChart');
    const W = 460; const Hgt = 200; const left = 38; const right = 12; const top = 14; const bottom = 24;
    const g = growthGeom(W, Hgt, left, right, top, bottom);
    if (!g.months.length) { box.replaceChildren(); return; }
    const vals = g.months.map((m) => m.active);
    const max = Math.max(1, ...vals);
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    const y = (v) => top + g.ih - (v / topVal) * g.ih;
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Active students at the end of each month' });
    pinBand(svg, g, top, g.ih);
    for (const t of ticks) {
      svg.appendChild(h('line', { x1: left, y1: y(t), x2: W - right, y2: y(t), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: left - 5, y: y(t) + 3, 'text-anchor': 'end', text: t.toLocaleString() }));
    }
    const pts = g.months.map((m, i) => `${g.xMid(i)},${y(m.active)}`).join(' ');
    svg.appendChild(h('path', {
      d: `M${g.xMid(0)},${y(0)} L${pts.split(' ').join(' L')} L${g.xMid(g.months.length - 1)},${y(0)} Z`,
      fill: 'var(--series-1-wash)', stroke: 'none',
    }));
    svg.appendChild(h('polyline', { points: pts, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const last = g.months[g.months.length - 1];
    svg.appendChild(h('circle', { cx: g.xMid(g.months.length - 1), cy: y(last.active), r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.appendChild(h('text', { x: g.xMid(g.months.length - 1) - 6, y: Math.max(y(last.active) - 8, 12), 'text-anchor': 'end', class: 'val-label', text: String(last.active) }));
    monthTicks(svg, g, left, Hgt);
    hitAreas(svg, g, top, g.ih, (m) => tipRows(`${m.active} active students`, `${m.label} · ${m.joined} joined, ${m.left} left`));
    box.replaceChildren(svg);
    const first = g.months[0];
    const change = last.active - first.active;
    $('#rosterNote').textContent = `${change >= 0 ? '+' : ''}${change} since ${first.label}`;
  }

  // 3) Median length of stay of the students who left, with the middle half shaded.
  function renderStayChart() {
    const box = $('#stayChart');
    const W = 460; const Hgt = 200; const left = 38; const right = 12; const top = 14; const bottom = 24;
    const g = growthGeom(W, Hgt, left, right, top, bottom);
    const withStay = g.months.filter((m) => m.medianStay != null);
    if (!withStay.length) {
      box.replaceChildren(h('p', { class: 'muted empty', text: 'Nobody has left in this window, so there is no length of stay to plot.' }));
      $('#stayNote').textContent = '';
      return;
    }
    const max = Math.max(1, ...g.months.map((m) => m.p75Stay || m.medianStay || 0));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
    const y = (v) => top + g.ih - (v / topVal) * g.ih;
    const svg = h('svg', { viewBox: `0 0 ${W} ${Hgt}`, role: 'img', 'aria-label': 'Median length of stay of students who left each month' });
    pinBand(svg, g, top, g.ih);
    for (const t of ticks) {
      svg.appendChild(h('line', { x1: left, y1: y(t), x2: W - right, y2: y(t), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
      svg.appendChild(h('text', { x: left - 5, y: y(t) + 3, 'text-anchor': 'end', text: String(t) }));
    }
    // the interquartile band, drawn only across runs of consecutive months
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const up = run.map((r) => `${g.xMid(r.i)},${y(r.m.p75Stay)}`);
        const down = run.slice().reverse().map((r) => `${g.xMid(r.i)},${y(r.m.p25Stay)}`);
        svg.appendChild(h('path', { d: `M${up.join(' L')} L${down.join(' L')} Z`, fill: 'var(--stay)', opacity: 0.18, stroke: 'none' }));
      }
      run = [];
    };
    g.months.forEach((m, i) => {
      if (m.p25Stay != null && m.p75Stay != null) run.push({ i, m }); else flush();
    });
    flush();
    // median line, broken where a month had no leavers
    let seg = [];
    const flushLine = () => {
      if (seg.length >= 2) svg.appendChild(h('polyline', { points: seg.join(' '), fill: 'none', stroke: 'var(--stay)', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
      else if (seg.length === 1) { const [x, yy] = seg[0].split(','); svg.appendChild(h('circle', { cx: x, cy: yy, r: 3, fill: 'var(--stay)' })); }
      seg = [];
    };
    g.months.forEach((m, i) => {
      if (m.medianStay == null) flushLine(); else seg.push(`${g.xMid(i)},${y(m.medianStay)}`);
    });
    flushLine();
    monthTicks(svg, g, left, Hgt);
    hitAreas(svg, g, top, g.ih, (m) => (m.medianStay == null
      ? tipRows('nobody left', m.label)
      : tipRows(`${m.medianStay} months`, `${m.label} · median of ${m.leaverCount} who left · middle half ${m.p25Stay}–${m.p75Stay} mo`)));
    box.replaceChildren(svg);
    const all = withStay.map((m) => m.medianStay);
    const first3 = all.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, all.length);
    const last3 = all.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, all.length);
    const dir = last3 > first3 + 0.5 ? 'rising' : last3 < first3 - 0.5 ? 'falling' : 'steady';
    $('#stayNote').textContent = `Students who left recently had stayed a median of ${all[all.length - 1]} months. The trend is ${dir}.`;
  }

  function renderGrowth() {
    const c = state.cohorts;
    const empty = $('#growthEmpty');
    const grid = document.querySelector('.growth-grid');
    if (!c || !c.months || !c.months.length) {
      empty.hidden = false;
      empty.textContent = c && c.unavailable
        ? 'Radius did not return the enrollment history this time - it will retry shortly.'
        : 'Loading the enrollment history…';
      grid.hidden = true;
      $('#pinCard').hidden = true;
      return;
    }
    empty.hidden = true;
    grid.hidden = false;
    if (state.pinned && !pinnedRow()) state.pinned = null; // scope changed under us
    $('#growthTitle').textContent = 'Growth & retention';
    renderFinderChips();
    renderPinCard();
    renderFlowChart();
    renderRosterChart();
    renderStayChart();
  }

  $('#monthSearch').addEventListener('input', (e) => {
    const key = resolveMonthQuery(e.target.value);
    state.finderText = e.target.value;
    $('#finderClear').hidden = !e.target.value;
    setPinned(key, { fromInput: true });
  });
  $('#monthSearch').addEventListener('keydown', (e) => {
    const months = monthsOf();
    if (!months.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const i = months.findIndex((m) => m.month === state.pinned);
      if (i < 0) return;
      const next = months[i + (e.key === 'ArrowRight' ? 1 : -1)];
      if (next) { e.preventDefault(); setPinned(next.month); }
    } else if (e.key === 'Escape') {
      e.target.value = '';
      setPinned(null);
    }
  });
  $('#finderClear').addEventListener('click', () => {
    $('#monthSearch').value = '';
    setPinned(null);
    $('#monthSearch').focus();
  });

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
    const last7 = sumOv((c) => c.last7Visits);
    const typical = centers.some((c) => c.typicalVisits != null) ? sumOv((c) => c.typicalVisits) : null;
    const weekday = (centers[0] && centers[0].weekday) || '';
    const vps = d.active && last7 ? Math.round((last7 / d.active) * 10) / 10 : null;
    const todayDelta = typical && visitsToday != null ? Math.round(((visitsToday - typical) / typical) * 100) : null;

    const pct = (a, b) => (a != null && b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : null);
    const activePct = pct(d.active, d.enrolled);
    const holdPct = pct(d.holds, d.enrolled);
    const nowPct = pct(inNow, visitsToday);
    const tiles = [
      { tone: 't-blue', icon: 'users', label: 'Enrolled', value: d.enrolled, sub: 'students enrolled now' },
      { tone: 't-green', icon: 'bolt', label: 'Active', value: d.active,
        sub: (activePct == null ? 'attended in last 30 days' : `${activePct}% of enrolled`) + (vps != null ? ` · ${vps} visits/student/wk` : ''), bar: activePct },
      { tone: 't-orange', icon: 'pause', label: 'On hold', value: d.holds,
        sub: holdPct == null ? 'frozen memberships' : `${holdPct}% of enrolled frozen`, bar: holdPct },
      { tone: 't-red', icon: 'flame', label: 'Visits today', value: visitsToday ?? '—',
        sub: typical != null ? `typical ${weekday.slice(0, 3)}: ${typical} · ${inNow ?? '—'} in now` : `${inNow ?? '—'} in session now`,
        delta: todayDelta, bar: typical ? Math.min(100, Math.round(((visitsToday || 0) / typical) * 100)) : nowPct },
      { tone: 't-navy', icon: 'dollar', label: 'Monthly recurring', value: d.expectedMonthly != null ? '$' + Math.round(d.expectedMonthly).toLocaleString() : '—',
        sub: (d.expectedMonthly ? `$${Math.round(d.expectedMonthly / Math.max(1, (d.enrollmentCount || d.enrolled || 0) - (d.packageStudents || 0)))} per member` : 'from active memberships')
          + (d.packageStudents ? ` · ${d.packageStudents} on packages` : '') },
      { tone: 't-purple', icon: 'clock', label: 'Avg stay', value: fmtMonths(d.avgTenureMonths), sub: 'running average since sign-up' },
    ];
    $('#detailKpis').replaceChildren(...tiles.map((t) => h('div', { class: 'tile ' + t.tone }, [
      h('div', { class: 'tile-icon' }, icon(t.icon)),
      h('div', { class: 'tile-body' }, [
        h('div', { class: 'value' + (String(t.value ?? '').length > 6 ? ' long' : ''), text: String(t.value ?? '—') }),
        h('div', { class: 'label', text: t.label }),
        h('div', { class: 'sub' }, [
          document.createTextNode(t.sub),
          t.delta == null ? null : h('span', { class: 'delta ' + (t.delta >= 0 ? 'up' : 'down'), text: `${t.delta >= 0 ? '+' : ''}${t.delta}%`, title: 'today vs a typical ' + weekday }),
        ]),
        t.bar == null ? null : h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': String(t.bar), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t.label },
          h('span', { style: `width:${t.bar}%` })),
      ]),
    ])));

    renderQueue(d, allScope);
    renderPipeline(d, allScope);
    renderMonthly(d);
    renderStaff();

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

  // ---------- enrollment pipeline ----------
  function renderPipeline(d, allScope) {
    const p = d.pipeline || {};
    const money = (n) => '$' + Math.round(n || 0).toLocaleString();
    $('#pipelineStats').replaceChildren(...[
      ['New leads', p.newLeads ?? 0, 't-blue', 'opened in the last 30 days'],
      ['Open leads', p.openTotal ?? 0, 't-orange', `${p.inProgress ?? 0} in progress · ${p.stale90 ?? 0} older than 90 days`],
      ['Enrolled this month', p.enrolledThisMonth ?? 0, 't-green', `${p.enrolledLastMonth ?? 0} last month`],
      ['Collected at sign-up', money(p.collectedThisMonth), 't-navy', `this month · ${money(p.collectedLastMonth)} last month`],
    ].map(([label, value, tone, sub]) => h('div', { class: 'pstat ' + tone }, [
      h('div', { class: 'pvalue', text: String(value) }),
      h('div', { class: 'plabel', text: label }),
      h('div', { class: 'psub', text: sub }),
    ])));
    $('#pipelineNote').textContent = allScope ? 'all centers' : '';
    const wrap = $('#pipelineWrap');
    const rows = allScope ? (d.byCenter || []) : [];
    wrap.hidden = rows.length === 0;
    $('#pipelineTable tbody').replaceChildren(...rows.map((c) => h('tr', {}, [
      h('td', { text: c.name }),
      h('td', { class: 'num', text: String(c.newLeads ?? 0) }),
      h('td', { class: 'num', text: String(c.openTotal ?? 0) }),
      h('td', { class: 'num', text: String(c.enrolledThisMonth ?? 0) }),
      h('td', { class: 'num', text: String(c.expiring ?? 0) }),
      h('td', { class: 'num', text: money(c.expectedMonthly) }),
    ])));
  }

  // ---------- instructor hours ----------
  function renderStaff() {
    const rows = state.staffHours || [];
    const hrs = (m) => (Math.round((m / 60) * 10) / 10).toFixed(1);
    $('#staffTable tbody').replaceChildren(...rows.slice(0, 60).map((r) => h('tr', {}, [
      h('td', { text: r.name }),
      h('td', { text: r.center }),
      h('td', { class: 'num', text: hrs(r.minutes) }),
      h('td', { class: 'num', text: String(r.days) }),
      h('td', { class: 'num', text: r.todayMinutes ? hrs(r.todayMinutes) : '—' }),
    ])));
    $('#staffEmpty').hidden = rows.length > 0;
    $('#staffTable').hidden = rows.length === 0;
    const total = rows.reduce((a, r) => a + r.minutes, 0);
    $('#staffNote').textContent = rows.length ? `${hrs(total)} h across ${rows.length} instructor${rows.length === 1 ? '' : 's'}` : '';
  }

  // ---------- needs-attention queue ----------
  const QUEUE_TABS = [
    { key: 'runningOut', label: 'Running out', icon: 'hourglass', hint: '2 or fewer sessions left on their plan',
      empty: 'Nobody is about to run out of sessions.' },
    { key: 'holdsList', label: 'On hold', icon: 'pause', hint: 'longest holds first - 30+ days is a renewal risk',
      empty: 'No students on hold.' },
    { key: 'belowAverage', label: 'Dropped', icon: 'down', hint: 'longer since their last visit than this center\'s average',
      empty: "Everyone's attendance is on track." },
    { key: 'expiring', label: 'Expiring', icon: 'calendar', hint: 'memberships that end within 30 days',
      empty: 'No memberships end in the next 30 days.' },
  ];

  function renderQueue(d, allScope) {
    const lists = { runningOut: d.runningOut || [], holdsList: d.holdsList || [], belowAverage: d.belowAverage || [], expiring: d.expiring || [] };
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
    } else if (state.queueTab === 'expiring') {
      cols.push('Plan', 'Ends', 'Left');
      cell = (r) => [
        h('td', {}, [h('span', { text: r.plan || '—' }), r.recurring ? h('span', { class: 'pill', text: 'auto-renews' }) : null]),
        h('td', { class: 'num ' + (r.daysLeft <= 7 ? 'flag' : ''), text: r.daysLeft === 0 ? 'today' : `${r.daysLeft}d`, title: r.endDate }),
        h('td', { class: 'num', text: r.sessionsLeft == null ? '—' : String(r.sessionsLeft) }),
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

  // Download the current queue tab as CSV (built from the rendered table).
  $('#queueExport').addEventListener('click', () => {
    const table = $('#queueWrap table');
    if (!table) return;
    const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
    const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const scope = state.center ? (state.detail && state.detail.name) || 'center' : 'all-centers';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${state.queueTab}-${scope}-${new Date().toISOString().slice(0, 10)}.csv`.replace(/\s+/g, '-').toLowerCase();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

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
    renderHeatmap();
    renderCoverage();
    renderGrowth();
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
    // The enrollment history behind the growth charts takes ~30s to fetch on a
    // cold cache, so it loads on its own and paints when it arrives rather
    // than holding up the tiles, queue and map.
    loadCohorts().then(renderGrowth).catch((e) => { if (e && e.auth) showLock(); });
    Promise.all([loadDetail(), loadStaffHours()])
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
