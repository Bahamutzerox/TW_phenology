import { hasPheno, groupInfo } from './pheno.js';

const PEAK_THRESHOLD = 0.5;
const DIM_THRESHOLD  = 0.25;

export function normalizeInatRecords(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  // Legacy format: { flowering, fruiting, budding }
  const seen = new Set();
  const out = [];
  for (const type of ['flowering', 'fruiting', 'budding']) {
    for (const r of (raw[type] || [])) {
      if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
  }
  return out;
}

// mode: 'all' | 'flower' | 'fruit' | 'both' (flower or fruit)
export function monthlyProfile(entry, mode = 'all', annotations = new Map()) {
  const counts = new Array(12).fill(0);
  const all = [...normalizeInatRecords(entry.inat_records), ...(entry.gbif_records || [])];
  const recs = mode === 'all' ? all
    : mode === 'both' ? all.filter(r => hasPheno(r, annotations, 'flower') || hasPheno(r, annotations, 'fruit'))
    : all.filter(r => hasPheno(r, annotations, mode));
  for (const r of recs) {
    if (r.month >= 1 && r.month <= 12) counts[r.month - 1]++;
  }
  const max = Math.max(...counts);
  return { counts, levels: counts.map(c => (max ? c / max : 0)), total: recs.length };
}

export function peakRanges(levels, threshold = PEAK_THRESHOLD) {
  const on = levels.map(v => v >= threshold);
  if (!on.some(Boolean)) return '';
  if (on.every(Boolean)) return '全年';
  // Start scanning right after an "off" month so ranges spanning Dec→Jan stay joined
  const start = on.indexOf(false);
  const ranges = [];
  let cur = null;
  for (let k = 1; k <= 12; k++) {
    const i = (start + k) % 12;
    if (on[i]) { if (cur) cur[1] = i; else cur = [i, i]; }
    else if (cur) { ranges.push(cur); cur = null; }
  }
  if (cur) ranges.push(cur);
  return ranges.map(([a, b]) => (a === b ? `${a + 1}月` : `${a + 1}–${b + 1}月`)).join('、');
}

// searches must be sorted newest first; keeps the newest entry per taxon
export function groupByTaxon(searches) {
  const map = new Map();
  for (const s of searches) {
    const key = (s.taxon_name || '').toLowerCase();
    if (map.has(key)) map.get(key).ids.push(s.id);
    else map.set(key, { entry: s, ids: [s.id] });
  }
  return [...map.values()];
}

function div(cls, text) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}


// items: [{ entry, ids, profile, note }]
export function renderMemo(container, items, { month = 0, onLoad, onDelete } = {}) {
  container.innerHTML = '';
  const thisMonth = new Date().getMonth() + 1;

  const sorted = [...items].sort((a, b) => {
    if (month) {
      const d = b.profile.levels[month - 1] - a.profile.levels[month - 1];
      if (d) return d;
    }
    return a.entry.taxon_name.localeCompare(b.entry.taxon_name);
  });

  // Header row with month labels aligned to the cells
  const head = div('memo-row memo-row-head');
  head.appendChild(div('memo-name-head', '物種'));
  const headCells = div('memo-cells');
  for (let m = 1; m <= 12; m++) {
    const c = div('memo-month-label', String(m));
    if (m === month) c.classList.add('active');
    if (m === thisMonth) c.classList.add('now');
    headCells.appendChild(c);
  }
  head.appendChild(headCells);
  head.appendChild(div('memo-peak-head', '盛期'));
  head.appendChild(div(''));
  container.appendChild(head);

  for (const item of sorted) {
    const { entry, profile, ids, note } = item;
    const lv = month ? profile.levels[month - 1] : 1;
    const row = div('memo-row');
    if (month && lv < DIM_THRESHOLD) row.classList.add('dim');
    if (item.color) row.style.setProperty('--memo-color', item.color);

    const name = document.createElement('button');
    name.className = 'memo-name';
    name.title = '載入此物種';
    const sci = div('memo-sci', entry.taxon_name);
    if (note?.target) {
      const t = document.createElement('span');
      t.className = `memo-target t-${note.target}`;
      t.textContent = groupInfo(entry.taxon_group).badge[note.target];
      sci.appendChild(t);
    }
    name.appendChild(sci);
    const common = [entry.taxon_common, entry.taxon_group && entry.taxon_group !== 'angio' ? groupInfo(entry.taxon_group).name : '']
      .filter(Boolean).join(' · ');
    if (common) name.appendChild(div('memo-common', common));
    if (note?.pins?.length) name.appendChild(div('memo-pins', `已存 ${note.pins.length} 筆記錄`));
    if (note?.text) {
      const n = div('memo-note', note.text.replace(/\s+/g, ' '));
      n.title = note.text;
      name.appendChild(n);
    }
    name.addEventListener('click', () => onLoad?.(entry));
    row.appendChild(name);

    const cells = div('memo-cells');
    profile.levels.forEach((v, i) => {
      const c = div('memo-cell');
      c.style.setProperty('--lv', v.toFixed(3));
      if (i + 1 === month) c.classList.add('active');
      c.title = `${i + 1}月 · ${profile.counts[i]} 筆`;
      cells.appendChild(c);
    });
    row.appendChild(cells);

    row.appendChild(div('memo-peak', profile.total ? (peakRanges(profile.levels) || '—') : '尚無資料'));

    const del = document.createElement('button');
    del.className = 'memo-del';
    del.textContent = '刪除';
    del.addEventListener('click', () => onDelete?.(entry, ids));
    row.appendChild(del);

    container.appendChild(row);
  }
}

export function countInMonth(items, month) {
  return items.filter(it => it.profile.levels[month - 1] >= PEAK_THRESHOLD).length;
}
