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
      const bh = v ? Math.max((v / max) * (H - 6), 2) : 1;
      const x = i * (W / HOURS.length) + (W / HOURS.length - bw) / 2;
      svg.appendChild(h('path', {
        d: barPath(x, H - bh, bw, bh, 2, false),
        fill: hh === nowH ? 'var(--series-1)' : 'var(--de-emphasis)',
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
          h('span', { class: 'dot' + ((c.checkedIn || c.staffIn) ? ' on' : ''), title: (c.checkedIn || c.staffIn) ? 'Open - people are checked in' : 'Quiet' }),
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
    const W = 560; const Hgt = 220; const left = 36; const right = 16; const top = 12; const bottom = 26;
    const iw = W - left - right; const ih = Hgt - top - bottom;
    const box = $('#trendChart');
    if (!data.length) {
      box.replaceChildren(h('p', { class: 'muted empty', text: 'History builds up while the app runs - check back tomorrow.' }));
      $('#trendTable').replaceChildren();
      return;
    }
    const max = Math.max(1, ...data.map((d) => d.visits));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
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
    const W = 560; const Hgt = 220; const left = 36; const right = 12; const top = 12; const bottom = 26;
    const iw = W - left - right; const ih = Hgt - top - bottom;
    const max = Math.max(1, ...HOURS.map((hh) => byHour[hh] || 0));
    const ticks = niceTicks(max);
    const topVal = ticks[ticks.length - 1];
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

    const tiles = [
      { label: 'Enrolled students', value: d.enrolled, sub: 'currently enrolled' },
      { label: 'Active students', value: d.active, sub: 'attended in last 30 days' },
      { label: 'On hold', value: d.holds, sub: 'frozen memberships' },
      { label: 'Attendance today', value: visitsToday ?? '—', sub: `${inNow ?? '—'} in session now` },
      { label: 'Avg length of stay', value: fmtMonths(d.avgTenureMonths), sub: 'running average since sign-up' },
    ];
    $('#detailKpis').replaceChildren(...tiles.map((t) => h('div', { class: 'tile' }, [
      h('div', { class: 'label', text: t.label }),
      h('div', { class: 'value', text: String(t.value ?? '—') }),
      h('div', { class: 'sub', text: t.sub }),
    ])));

    renderQueue(d, allScope);

    // top schools
    const schools = d.schools || [];
    $('#schoolsTable tbody').replaceChildren(...schools.slice(0, 60).map((s) => h('tr', {}, [
      h('td', { text: s.name }),
      h('td', { class: 'num', text: String(s.count) }),
    ])));

    const pending = $('#mapPending');
    if (d.geocodePending > 0) {
      pending.hidden = false;
      pending.textContent = `Locating ${d.geocodePending} more place(s) on the map — they'll appear in a moment.`;
    } else pending.hidden = true;

    renderMap(d);
  }

  function circleRadius(count, max, base, span) {
    return base + span * Math.sqrt(count / Math.max(max, 1));
  }

  const TILES = {
    streets: {
      light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
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

  // Radial gradients injected into Leaflet's overlay SVG so markers render as
  // shaded, dimensional beads rather than flat discs.
  function ensureGradientDefs() {
    const svg = (state.renderer && state.renderer._container)
      || document.querySelector('#map .leaflet-overlay-pane svg');
    if (!svg || svg.querySelector('#mn-grad-school')) return;
    const NS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(NS, 'defs');
    const grad = (id, cx, cy, r, stops) => {
      const g = document.createElementNS(NS, 'radialGradient');
      g.setAttribute('id', id); g.setAttribute('cx', cx); g.setAttribute('cy', cy); g.setAttribute('r', r);
      for (const [off, col, op] of stops) {
        const st = document.createElementNS(NS, 'stop');
        st.setAttribute('offset', off); st.setAttribute('stop-color', col);
        if (op != null) st.setAttribute('stop-opacity', op);
        g.appendChild(st);
      }
      defs.appendChild(g);
    };
    grad('mn-grad-school', '35%', '30%', '72%', [['0%', '#FFA294'], ['40%', '#EF3E33'], ['100%', '#7E0C09']]);
    grad('mn-grad-zip', '50%', '50%', '50%', [['0%', '#12A9C4', 0.62], ['62%', '#0C90A8', 0.2], ['100%', '#0C90A8', 0.03]]);
    svg.insertBefore(defs, svg.firstChild);
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

  // On-map key: colour meaning plus a graduated size scale read off the data.
  function buildMapKey(d) {
    const el = state.mapKeyEl;
    if (!el) return;
    const maxSchool = Math.max(1, ...(d.schools || []).map((s) => s.count));
    const steps = [...new Set([1, Math.max(2, Math.round(maxSchool / 2)), maxSchool])]
      .filter((n) => n > 0).sort((a, b) => a - b);
    const sizes = steps.map((n) => {
      const r = circleRadius(n, maxSchool, 7, 22);
      return h('div', { class: 'key-size' }, [
        h('i', { style: `width:${Math.round(r * 2)}px;height:${Math.round(r * 2)}px` }),
        h('span', { text: String(n) }),
      ]);
    });
    el.replaceChildren(
      h('div', { class: 'key-title', text: 'Map key' }),
      h('div', { class: 'key-row' }, [h('span', { class: 'key-swatch school' }), h('span', { text: 'School' })]),
      h('div', { class: 'key-row' }, [h('span', { class: 'key-swatch zip' }), h('span', { text: 'Neighborhood (ZIP)' })]),
      h('div', { class: 'key-sizes' }, sizes),
      h('div', { class: 'key-title', style: 'margin:8px 0 0', text: 'circle size = students' }),
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

    const s2 = cssVar('--series-2', '#0C90A8');
    const surface = cssVar('--surface', '#ffffff');
    const dark = isDarkTheme();

    if (!state.map) {
      // an initial view makes the map 'loaded' so layers (and the SVG renderer) attach synchronously
      state.map = L.map('map', { scrollWheelZoom: false, center: [39.5, -98.35], zoom: 4 });
      state.renderer = L.svg({ padding: 0.5 }).addTo(state.map);
      ensureGradientDefs();
      state.layers = { schools: L.layerGroup(), zips: L.layerGroup() };
      L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(state.map);
      const key = L.control({ position: 'bottomright' });
      key.onAdd = () => {
        const el = L.DomUtil.create('div', 'map-key');
        L.DomEvent.disableClickPropagation(el);
        state.mapKeyEl = el;
        return el;
      };
      key.addTo(state.map);
    }

    applyBasemap(dark);
    state.map.invalidateSize();
    state.layers.schools.clearLayers();
    state.layers.zips.clearLayers();

    const pts = [];

    // Neighborhoods: soft teal domes with a dashed edge, drawn beneath.
    const maxZip = Math.max(1, ...(d.zips || []).map((z) => z.count));
    for (const z of d.zips || []) {
      if (z.lat == null || z.lng == null) continue;
      pts.push([z.lat, z.lng]);
      L.circleMarker([z.lat, z.lng], {
        radius: circleRadius(z.count, maxZip, 12, 34), className: 'mn-zip', renderer: state.renderer,
        color: s2, weight: 1.5, dashArray: '4 3', opacity: 0.9,
        fillColor: 'url(#mn-grad-zip)', fillOpacity: 1,
      }).bindTooltip(
        `<b>ZIP ${escapeHtml(z.zip)}</b><br>${z.count} student${z.count === 1 ? '' : 's'} live near here`,
        { direction: 'top', sticky: true },
      ).addTo(state.layers.zips);
    }

    // Schools: shaded red beads with a surface ring and a drop shadow.
    const maxSchool = Math.max(1, ...(d.schools || []).map((s) => s.count));
    for (const s of d.schools || []) {
      if (s.lat == null || s.lng == null) continue;
      pts.push([s.lat, s.lng]);
      L.circleMarker([s.lat, s.lng], {
        radius: circleRadius(s.count, maxSchool, 7, 22), className: 'mn-school', renderer: state.renderer,
        color: surface, weight: 2.5, opacity: 1,
        fillColor: 'url(#mn-grad-school)', fillOpacity: 1,
      }).bindTooltip(
        `<b>${escapeHtml(s.name)}</b><br>${s.count} student${s.count === 1 ? '' : 's'}`,
        { direction: 'top', sticky: true },
      ).addTo(state.layers.schools);
    }

    applyMapToggles();      // adds the layer groups (creates the SVG renderer)
    ensureGradientDefs();   // now the SVG exists - install the gradients
    buildMapKey(d);
    if (pts.length) state.map.fitBounds(pts, { padding: [36, 36], maxZoom: 13 });
    ensureGradientDefs(); // belt-and-braces: renderer container exists for sure now
  }

  function applyMapToggles() {
    if (!state.map || !state.layers) return;
    const wantS = $('#tglSchools').checked;
    const wantZ = $('#tglZips').checked;
    toggleLayer(state.layers.zips, wantZ);   // draw density under schools
    toggleLayer(state.layers.schools, wantS);
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
    { key: 'runningOut', label: 'Running out', hint: '2 or fewer sessions left on their plan',
      empty: 'Nobody is about to run out of sessions.' },
    { key: 'holdsList', label: 'On hold', hint: 'longest holds first - 30+ days is a renewal risk',
      empty: 'No students on hold.' },
    { key: 'belowAverage', label: 'Attendance dropped', hint: 'longer since their last visit than this center\'s average',
      empty: "Everyone's attendance is on track." },
  ];

  function renderQueue(d, allScope) {
    const lists = { runningOut: d.runningOut || [], holdsList: d.holdsList || [], belowAverage: d.belowAverage || [] };
    if (!lists[state.queueTab]) state.queueTab = 'runningOut';

    $('#queueTabs').replaceChildren(...QUEUE_TABS.map((t) => h('button', {
      type: 'button', role: 'tab', class: 'queue-tab' + (state.queueTab === t.key ? ' active' : ''),
      'aria-selected': String(state.queueTab === t.key), title: t.hint, 'data-tab': t.key,
    }, [
      h('span', { text: t.label }),
      h('span', { class: 'count', text: String(lists[t.key].length) }),
    ])));

    const tab = QUEUE_TABS.find((t) => t.key === state.queueTab);
    const rows = lists[state.queueTab];
    const cols = ['Student', ...(allScope ? ['Center'] : [])];
    let cell;
    if (state.queueTab === 'runningOut') {
      cols.push('Plan', 'Left', 'Last seen');
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
      cols.push('School', 'Last seen');
      cell = (r) => [
        h('td', { text: r.school || '—' }),
        h('td', { class: 'num', text: r.daysSinceVisit == null ? '—' : `${r.daysSinceVisit}d ago` }),
      ];
    }

    $('#queueWrap').replaceChildren(h('table', { class: 'data-table' }, [
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
