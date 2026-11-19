import { searchTaxa, fetchINatObservations, matchGBIFTaxon, fetchGBIFSpecimens } from './api.js';
import { renderTimeline, renderMonthDetail } from './timeline.js';
import { renderMap } from './map.js';
import {
  saveSearch, listSearches, deleteSearch, listAnnotations, listNotes, putNote, deleteNote,
  noteKey, taxonKey, markDeleted,
} from './storage.js';
import { normalizeInatRecords, groupByTaxon, monthlyProfile, renderMemo, countInMonth } from './memo.js';
import { PHENO, effectivePheno, hasPheno } from './pheno.js';
import { openAnnotator } from './annotate.js';
import { exportBackup, importBackup } from './backup.js';
import { initSync } from './sync.js';

const RECORDS_PER_PAGE = 60;
const KDE_BANDWIDTH    = 10;

const state = {
  currentTaxon: null,
  inatRecords:  [],
  gbifRecords:  [],
  allRecords:   [],
  recordOffset: 0,
  mapReady:     false,
  view:         'grid',
  memoMonth:    0,
  memoMode:     'all',
  curveMode:    'source',
  detailMonth:  0,
  annotations:  new Map(),   // recordKey → labels
  notes:        new Map(),   // noteKey(taxon name) → note
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const searchInput  = $('search-input');
const searchBtn    = $('search-btn');
const acList       = $('autocomplete-list');
const taxonPhoto   = $('taxon-photo');
const taxonSci     = $('taxon-scientific');
const taxonCommon  = $('taxon-common');
const progressSec  = $('progress-section');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const statsRow     = $('stats-row');
const timelineEl   = $('timeline-container');
const timelineHint = $('timeline-hint');
const annotateBtn  = $('annotate-btn');
const mapContainer = $('map-container');
const recordsList  = $('records-list');
const monthFilter  = $('month-filter');
const typeFilter   = $('type-filter');
const monthDetailWrap  = $('month-detail-wrap');
const monthDetailLabel = $('month-detail-label');
const monthDetailChart = $('month-detail-chart');
const saveBar          = $('save-bar');
const saveBtn      = $('save-btn');
const saveStatus   = $('save-status');
const dashboard    = $('dashboard');
const introState   = $('intro-state');
const savedBtn     = $('saved-btn');
const memoView     = $('memo-view');
const memoList     = $('memo-list');
const memoMonths   = $('memo-months');
const memoCount    = $('memo-count');
const memoSummary  = $('memo-summary');
const memoCloseBtn = $('memo-close-btn');

// ── Utilities ─────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── Autocomplete ──────────────────────────────────────────────────────────────
const onSearchInput = debounce(async () => {
  const q = searchInput.value.trim();
  if (q.length < 2) { hideAC(); return; }
  try { showAC(await searchTaxa(q)); } catch { hideAC(); }
}, 320);

function showAC(taxa) {
  acList.innerHTML = '';
  if (!taxa.length) { hideAC(); return; }
  for (const t of taxa.slice(0, 8)) {
    const li = document.createElement('li');
    if (t.photo_url) {
      const img = Object.assign(document.createElement('img'), { src: t.photo_url, className: 'taxon-thumb', alt: '' });
      li.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'taxon-thumb-ph';
      li.appendChild(ph);
    }
    const info = document.createElement('div');
    info.className = 'ac-info';
    const sci = document.createElement('div');
    sci.className = 'ac-sci';
    sci.textContent = t.name;
    info.appendChild(sci);
    if (t.common_name) {
      const common = document.createElement('div');
      common.className = 'ac-common';
      common.textContent = t.common_name;
      info.appendChild(common);
    }
    li.appendChild(info);
    li.addEventListener('click', () => { searchInput.value = t.name; hideAC(); runSearch(t); });
    acList.appendChild(li);
  }
  acList.hidden = false;
}

function hideAC() { acList.hidden = true; acList.innerHTML = ''; }

// ── Main search flow ───────────────────────────────────────────────────────────
async function runSearch(taxon) {
  const useINat   = $('toggle-inat').checked;
  const useGBIF   = $('toggle-gbif').checked;
  const useTaiwan = $('toggle-taiwan').checked;
  if (!useINat && !useGBIF) { alert('請至少選擇一個資料來源'); return; }

  state.currentTaxon = taxon;
  state.inatRecords  = [];
  state.gbifRecords  = [];
  state.mapReady     = false;

  setTaxonCard(taxon);

  // Progress
  saveBar.hidden = true;
  progressSec.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = '開始查詢...';

  const totalSteps = (useINat ? 1 : 0) + (useGBIF ? 1 : 0);
  let done = 0;
  function tick(msg) {
    done++;
    progressFill.style.width = `${done / totalSteps * 100}%`;
    progressText.textContent = msg;
  }

  try {
    await Promise.all([
      useINat
        ? fetchINatObservations(taxon.id, null, { taiwan: useTaiwan })
            .then(data => { state.inatRecords = data; tick('iNaturalist 觀察記錄已載入'); })
        : Promise.resolve(),
      useGBIF
        ? matchGBIFTaxon(taxon.name).then(async match => {
            if (match) {
              taxon.gbif_key    = match.usageKey;
              state.gbifRecords = await fetchGBIFSpecimens(match.usageKey, undefined, { taiwan: useTaiwan });
            }
            tick('GBIF 標本資料已載入');
          })
        : Promise.resolve(),
    ]);

    progressSec.hidden = true;
    buildAllRecords();
    refreshUI();

  } catch (err) {
    progressSec.hidden = true;
    console.error('Search error:', err);
    alert('查詢發生錯誤：' + err.message);
  }
}

function setTaxonCard(taxon) {
  taxonSci.textContent    = taxon.name;
  taxonCommon.textContent = taxon.common_name
    || (taxon.matched_term && taxon.matched_term !== taxon.name ? taxon.matched_term : '');
  if (taxon.photo_url) {
    taxonPhoto.src    = taxon.photo_url.replace('square', 'medium');
    taxonPhoto.hidden = false;
  } else {
    taxonPhoto.hidden = true;
  }
}

function buildAllRecords() {
  const records = [...state.inatRecords, ...state.gbifRecords];
  records.sort((a, b) => a.month - b.month || (b.year || 0) - (a.year || 0));
  state.allRecords  = records;
  state.recordOffset = 0;
}

function refreshUI() {
  // Hide intro, show dashboard
  introState.hidden = true;
  dashboard.hidden  = false;
  memoView.hidden   = true;
  savedBtn.classList.remove('active');

  // Stats
  statsRow.innerHTML = [
    `<span class="stat-chip inat">iNat ${state.inatRecords.length} 筆</span>`,
    `<span class="stat-chip specimen">標本 ${state.gbifRecords.length} 筆</span>`,
  ].join('');

  // Hide month detail on new search
  state.detailMonth = 0;
  monthDetailWrap.hidden = true;

  monthFilter.value = '0';
  typeFilter.value  = 'all';
  drawTimeline();
  showNoteEditor();

  // Map (always render; re-render on new search)
  renderMap('map-container', state.inatRecords, state.gbifRecords);
  state.mapReady = true;

  renderRecordsList();

  // Save
  saveBtn.disabled       = false;
  saveStatus.textContent = '';
  saveBar.hidden = false;
}

// ── Timeline click handler ────────────────────────────────────────────────────
const MONTH_ZH = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

function timelineSeries() {
  const type = typeFilter.value;
  const inat = type === 'gbif' ? [] : state.inatRecords;
  const gbif = type === 'inat' ? [] : state.gbifRecords;
  if (state.curveMode === 'source') {
    return [
      { label: 'iNaturalist', color: '#52b788', fill: 'rgba(82,183,136,0.45)', records: inat },
      { label: 'GBIF 標本',   color: '#4361ee', fill: 'rgba(67,97,238,0.3)',   records: gbif },
    ];
  }
  const all = [...inat, ...gbif];
  const series = ['flower', 'fruit', 'bud']
    .map(k => ({ kind: k, ...PHENO[k], records: all.filter(r => hasPheno(r, state.annotations, k)) }));
  return series.filter(s => s.kind !== 'bud' || s.records.length);
}

function drawTimeline() {
  renderTimeline(timelineEl, timelineSeries(), handleTimelineClick, { bandwidth: KDE_BANDWIDTH });

  if (state.curveMode === 'source') {
    timelineHint.textContent = '點擊月份可過濾下方記錄，並放大該月日期分布';
    return;
  }
  const all = [...state.inatRecords, ...state.gbifRecords];
  let judged = 0, mine = 0;
  for (const r of all) {
    const e = effectivePheno(r, state.annotations);
    if (e.labels.length) judged++;
    if (e.by === 'user') mine++;
  }
  timelineHint.textContent = judged
    ? `已判定花果 ${judged} / ${all.length} 筆（你標注 ${mine} 筆，其餘來自 iNat 社群標注與標本欄位）`
    : '尚無花果資料。按下方「標注花果」開始判定照片。';
}

function drawMonthDetail() {
  const month = state.detailMonth;
  if (!month) return;
  const series = timelineSeries();
  const parts = series.map(s => `${s.label} ${s.records.filter(r => r.month === month).length} 筆`);
  monthDetailLabel.textContent = `${MONTH_ZH[month - 1]}  ·  ${parts.join('  /  ')}`;
  renderMonthDetail(monthDetailChart, series, month);
  monthDetailWrap.hidden = false;
}

function handleTimelineClick(month) {
  monthFilter.value  = String(month);
  state.recordOffset = 0;
  renderRecordsList();
  state.detailMonth = month;
  drawMonthDetail();
  monthDetailWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function startAnnotating() {
  if (!state.currentTaxon) return;
  openAnnotator({
    records:     [...state.inatRecords, ...state.gbifRecords],
    annotations: state.annotations,
    taxonName:   state.currentTaxon.name,
    onlyMonth:   parseInt(monthFilter.value) || 0,
    onClose: changed => {
      if (!changed) return;
      drawTimeline();
      drawMonthDetail();
      renderRecordsList();
    },
  });
}

// ── Records ───────────────────────────────────────────────────────────────────
function renderRecordsList() {
  const month    = parseInt(monthFilter.value) || 0;
  const type     = typeFilter.value;
  const filtered = state.allRecords.filter(r => {
    if (month > 0 && r.month !== month) return false;
    if (type !== 'all' && r.source !== type) return false;
    return true;
  });

  recordsList.innerHTML = '';
  if (!filtered.length) {
    recordsList.innerHTML = '<div class="empty-state">沒有符合條件的記錄</div>';
    return;
  }

  const page = filtered.slice(0, state.recordOffset + RECORDS_PER_PAGE);

  if (state.view === 'grid') {
    const grid = document.createElement('div');
    grid.className = 'records-grid';
    page.forEach(r => grid.appendChild(createGridItem(r)));
    recordsList.appendChild(grid);
  } else {
    page.forEach(r => recordsList.appendChild(createRecordCard(r)));
  }

  if (page.length < filtered.length) {
    const btn = document.createElement('button');
    btn.className = 'load-more-btn';
    btn.textContent = `載入更多（已顯示 ${page.length} / ${filtered.length} 筆）`;
    btn.onclick = () => { state.recordOffset += RECORDS_PER_PAGE; renderRecordsList(); };
    recordsList.appendChild(btn);
  } else {
    const info = document.createElement('p');
    info.style.cssText = 'text-align:center;padding:10px 0 6px;font-size:.75rem;color:var(--text-muted)';
    info.textContent = `共 ${filtered.length} 筆記錄`;
    recordsList.appendChild(info);
  }
}

function createGridItem(r) {
  const a = document.createElement('a');
  a.className = 'grid-item';
  a.href      = r.url;
  a.target    = '_blank';
  a.rel       = 'noopener noreferrer';

  if (r.photo_url) {
    const img = document.createElement('img');
    img.src    = r.photo_url;
    img.alt    = '';
    img.loading = 'lazy';
    a.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = `grid-ph ${r.source === 'inat' ? 'grid-ph-inat' : 'grid-ph-gbif'}`;
    ph.textContent = r.source === 'inat' ? 'iNat' : 'GBIF';
    a.appendChild(ph);
  }

  const chips = phenoChips(r);
  if (chips) a.appendChild(chips);

  const overlay = document.createElement('div');
  overlay.className = 'grid-overlay';
  const dateStr = r.observed_on
    ? r.observed_on.slice(0, 7)
    : r.year ? `${r.year}-${String(r.month).padStart(2,'0')}` : `${r.month}月`;
  overlay.appendChild(span('grid-date', dateStr));
  const loc = r.place || r.institution || '';
  if (loc) overlay.appendChild(span('grid-loc', loc));
  a.appendChild(overlay);
  return a;
}

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

function phenoChips(r) {
  const { labels, by } = effectivePheno(r, state.annotations);
  if (!labels.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'pheno-chips';
  for (const l of labels) {
    const c = span(`pheno-chip pheno-${l}${by === 'user' ? ' by-user' : ''}`, PHENO[l].label);
    c.title = by === 'user' ? '你的標注' : by === 'inat' ? 'iNat 社群標注' : '標本欄位';
    wrap.appendChild(c);
  }
  return wrap;
}

function createRecordCard(r) {
  const [cls, text] = r.source === 'inat' ? ['badge-inat', 'iNat'] : ['badge-specimen', '標本'];
  const dateStr = r.observed_on || (r.year ? `${r.year}-${String(r.month).padStart(2,'0')}` : `${r.month}月`);
  const loc     = r.place || r.institution || r.dataset || '';
  const card    = document.createElement('div');
  card.className = 'record-card';
  card.appendChild(span(`record-badge ${cls}`, text));
  const info = document.createElement('div');
  info.className = 'record-info';
  const date = document.createElement('div');
  date.className = 'record-date';
  date.textContent = dateStr;
  info.appendChild(date);
  if (loc) {
    const l = document.createElement('div');
    l.className = 'record-location';
    l.textContent = loc;
    info.appendChild(l);
  }
  card.appendChild(info);
  const chips = phenoChips(r);
  if (chips) card.appendChild(chips);
  const link = document.createElement('a');
  link.className = 'record-link';
  link.href = r.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '查看';
  card.appendChild(link);
  return card;
}

// ── Collection memo ───────────────────────────────────────────────────────────
let memoItems = [];

function openMemo() {
  introState.hidden = true;
  dashboard.hidden  = true;
  memoView.hidden   = false;
  savedBtn.classList.add('active');
  showBackupStatus();
  loadMemo();
}

function closeMemo() {
  memoView.hidden = true;
  savedBtn.classList.remove('active');
  if (state.currentTaxon) dashboard.hidden = false;
  else introState.hidden = false;
}

async function loadMemo() {
  memoList.innerHTML = '<div class="empty-state" style="opacity:.5">讀取中...</div>';
  flushNote();
  await notesReady;
  try {
    memoItems = groupByTaxon(await listSearches());
  } catch {
    memoList.innerHTML = '<div class="empty-state">無法讀取備忘錄</div>';
    return;
  }
  drawMemo();
}

function drawMemo() {
  const month = state.memoMonth;
  memoCount.textContent = memoItems.length ? `共 ${memoItems.length} 種` : '';

  memoMonths.innerHTML = '';
  for (let m = 0; m <= 12; m++) {
    const b = document.createElement('button');
    b.className = 'memo-month-btn' + (m === month ? ' active' : '');
    b.textContent = m === 0 ? '全部' : `${m}月`;
    b.addEventListener('click', () => { state.memoMonth = m; drawMemo(); });
    memoMonths.appendChild(b);
  }

  if (!memoItems.length) {
    memoSummary.textContent = '';
    memoList.innerHTML = '<div class="empty-state">備忘錄還是空的<br><small>查詢物種後點「加入備忘錄」，之後可在這裡一次比較各物種的花果期</small></div>';
    return;
  }

  const mode = state.memoMode;
  const TARGET_COLOR = { flower: PHENO.flower.color, fruit: PHENO.fruit.color, both: '#b05a4a' };
  const items = memoItems.map(it => {
    const note = state.notes.get(noteKey(it.entry.taxon_name));
    const target = note?.target || '';
    const m = mode === 'target' ? (target || 'all') : mode;
    return {
      ...it,
      note,
      profile: monthlyProfile(it.entry, m, state.annotations),
      color: mode === 'target' && target ? TARGET_COLOR[target] : null,
    };
  });
  const what = mode === 'flower' ? '「花」記錄' : mode === 'fruit' ? '「果」記錄'
    : mode === 'target' ? '採集目標記錄' : '記錄';
  memoList.style.setProperty('--memo-color', mode === 'all' || mode === 'target' ? 'var(--brand)' : PHENO[mode].color);

  const noTarget = items.filter(it => !it.note?.target).length;
  memoSummary.textContent = month
    ? `${month}月有 ${countInMonth(items, month)} 種處於${what}高峰（已依該月${what}量排序，偏少的物種淡化顯示）`
    : `色塊深淺為各物種每月${what}量（以該物種最多的月份為最深）。`
      + (mode === 'all' ? '選擇月份可排序。'
        : mode === 'target' ? `每個物種依筆記中設定的採集目標計算${noTarget ? `，${noTarget} 種未設定目標，以全部記錄計` : ''}。`
        : '花果判定包含你的標注、iNat 社群標注與標本欄位。');

  renderMemo(memoList, items, {
    month,
    onLoad: loadSaved,
    onDelete: async (entry, ids) => {
      if (!confirm(`從備忘錄刪除 ${entry.taxon_name}？`)) return;
      for (const id of ids) await deleteSearch(id);
      await markDeleted('search', taxonKey(entry.taxon_name));
      loadMemo();
    },
  });
}

function loadSaved(saved) {
  state.currentTaxon = {
    id: saved.taxon_id_inat, name: saved.taxon_name,
    common_name: saved.taxon_common, photo_url: saved.taxon_photo, gbif_key: saved.taxon_key_gbif,
  };
  setTaxonCard(state.currentTaxon);
  state.inatRecords = normalizeInatRecords(saved.inat_records);
  state.gbifRecords = saved.gbif_records || [];
  state.mapReady    = false;
  searchInput.value = saved.taxon_name;
  buildAllRecords();
  refreshUI();
  saveBar.hidden = true;
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function handleSave() {
  saveBtn.disabled       = true;
  saveStatus.textContent = '儲存中...';
  try {
    const taxon = state.currentTaxon;
    const existing = (await listSearches()).filter(s => s.taxon_name === taxon.name);
    await saveSearch({
      id: existing[0]?.id,
      search_date: new Date().toISOString(),
      taxon_name: taxon.name, taxon_common: taxon.common_name || '',
      taxon_id_inat: taxon.id, taxon_key_gbif: taxon.gbif_key || null,
      taxon_photo: taxon.photo_url || null,
      inat_records: state.inatRecords, gbif_records: state.gbifRecords,
      meta: { total_inat: state.inatRecords.length, total_gbif: state.gbifRecords.length },
    });
    for (const s of existing.slice(1)) await deleteSearch(s.id);
    saveStatus.textContent = existing.length ? '已更新備忘錄' : '已加入備忘錄';
  } catch (err) {
    saveStatus.textContent = '儲存失敗';
    saveBtn.disabled = false;
    console.error(err);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────
searchInput.addEventListener('input', onSearchInput);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideAC(); return; }
  if (e.key === 'Enter') {
    hideAC();
    const q = searchInput.value.trim();
    if (q) searchTaxa(q).then(r => r.length ? runSearch(r[0]) : alert('找不到相符的物種'));
  }
});
searchBtn.addEventListener('click', () => {
  hideAC();
  const q = searchInput.value.trim();
  if (q) searchTaxa(q).then(r => r.length ? runSearch(r[0]) : alert('找不到相符的物種'));
});
document.addEventListener('click', e => { if (!e.target.closest('.search-box')) hideAC(); });

monthFilter.addEventListener('change', () => {
  state.recordOffset = 0;
  renderRecordsList();
  if (monthFilter.value === '0') hideMonthDetail();
});
typeFilter.addEventListener('change',  () => {
  state.recordOffset = 0;
  renderRecordsList();
  drawTimeline();
  drawMonthDetail();
});

function bindSeg(id, onPick) {
  const seg = $(id);
  seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    onPick(b.dataset.mode);
  }));
}
bindSeg('curve-mode', mode => { state.curveMode = mode; drawTimeline(); drawMonthDetail(); });
bindSeg('memo-mode',  mode => { state.memoMode = mode; drawMemo(); });
annotateBtn.addEventListener('click', startAnnotating);

function hideMonthDetail() {
  state.detailMonth = 0;
  monthDetailWrap.hidden = true;
}
saveBtn.addEventListener('click', handleSave);

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.view         = btn.dataset.view;
    state.recordOffset = 0;
    renderRecordsList();
  });
});

savedBtn.addEventListener('click', () => (memoView.hidden ? openMemo() : closeMemo()));
memoCloseBtn.addEventListener('click', closeMemo);

$('month-detail-close').addEventListener('click', hideMonthDetail);

async function reloadAnnotations() {
  try {
    const list = await listAnnotations();
    state.annotations.clear();
    for (const a of list) state.annotations.set(a.key, a.labels);
  } catch (err) {
    console.warn('Could not load annotations:', err);
  }
}
reloadAnnotations();

// ── Notes ─────────────────────────────────────────────────────────────────────
const noteText   = $('note-text');
const noteStatus = $('note-status');
const noteSeg    = $('note-target');
let noteTarget = '';
let noteTimer  = null;
let noteTaxon  = null;   // species the editor is showing, may lag state.currentTaxon

async function reloadNotes() {
  try {
    const list = await listNotes();
    state.notes.clear();
    for (const n of list) state.notes.set(n.key, n);
  } catch (err) {
    console.warn('Could not load notes:', err);
  }
}
const notesReady = reloadNotes();

function setSeg(seg, mode) {
  seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}

async function showNoteEditor() {
  flushNote();
  await notesReady;
  noteTaxon = state.currentTaxon?.name || null;
  const note = state.notes.get(noteKey(noteTaxon));
  noteTarget = note?.target || '';
  noteText.value = note?.text || '';
  setSeg(noteSeg, noteTarget);
  noteStatus.textContent = note ? `更新於 ${new Date(note.updated).toLocaleDateString('zh-TW')}` : '';
}

async function saveNote() {
  noteTimer = null;
  const taxon = noteTaxon;
  const text = noteText.value.trim();
  const target = noteTarget;
  if (!taxon) return;
  const key = noteKey(taxon);
  try {
    if (!text && !target) {
      state.notes.delete(key);
      await deleteNote(key);
      await markDeleted('note', key);
      noteStatus.textContent = '';
      return;
    }
    const note = { key, taxon, target, text, updated: new Date().toISOString() };
    state.notes.set(key, note);
    await putNote(note);
    noteStatus.textContent = '已儲存';
  } catch (err) {
    console.error(err);
    noteStatus.textContent = '儲存失敗';
  }
}

// Save pending edits before the editor switches to another species
function flushNote() {
  if (noteTimer) { clearTimeout(noteTimer); saveNote(); }
}

noteText.addEventListener('input', () => {
  noteStatus.textContent = '編輯中…';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => saveNote(), 600);
});
noteText.addEventListener('blur', flushNote);
noteSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  noteTarget = b.dataset.mode;
  setSeg(noteSeg, noteTarget);
  clearTimeout(noteTimer);
  saveNote();
}));

// ── Backup ────────────────────────────────────────────────────────────────────
const LAST_EXPORT_KEY = 'tw-phenology:last-export';
const backupStatus = $('backup-status');
const importFile   = $('import-file');

function showBackupStatus() {
  let last = null;
  try { last = localStorage.getItem(LAST_EXPORT_KEY); } catch {}
  backupStatus.classList.toggle('warn', !last);
  backupStatus.textContent = last
    ? `上次匯出 ${new Date(last).toLocaleDateString('zh-TW')}`
    : '尚未匯出備份';
}

$('export-btn').addEventListener('click', async () => {
  try {
    const r = await exportBackup();
    if (!r) return;
    try { localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString()); } catch {}
    showBackupStatus();
  } catch (err) {
    console.error(err);
    alert('匯出失敗：' + err.message);
  }
});

$('import-btn').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const r = await importBackup(file);
    await reloadAnnotations();
    await reloadNotes();
    if (state.currentTaxon) showNoteEditor();
    await loadMemo();
    if (state.currentTaxon) { drawTimeline(); drawMonthDetail(); renderRecordsList(); }
    alert(`匯入完成\n新增物種 ${r.added} 種、更新 ${r.updated} 種、本機已是最新 ${r.skipped} 種\n匯入或更新標注 ${r.annotations} 筆、筆記 ${r.notes} 則${r.deleted ? `\n依匯入檔的刪除紀錄移除 ${r.deleted} 項` : ''}`);
  } catch (err) {
    alert('匯入失敗：' + err.message);
  }
});

// ── Google Drive sync ─────────────────────────────────────────────────────────
async function refreshAfterMerge() {
  await reloadAnnotations();
  await reloadNotes();
  if (!memoView.hidden) await loadMemo();
  if (state.currentTaxon) {
    drawTimeline();
    drawMonthDetail();
    renderRecordsList();
    // Don't clobber a note the user is typing
    if (!noteTimer && document.activeElement !== noteText) showNoteEditor();
  }
}

function fmtSyncTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-TW');
}

const sync = initSync({ onMerged: refreshAfterMerge });
if (sync) {
  const syncBtn     = $('sync-btn');
  const syncInfo    = $('sync-info');
  const syncNowBtn  = $('sync-now-btn');
  const signOutBtn  = $('sync-signout-btn');
  syncBtn.hidden = false;
  $('sync-panel').hidden = false;

  sync.subscribe(s => {
    const pendingChanges = s.dirty && s.state !== 'syncing';
    const [label, cls] =
      s.state === 'syncing'   ? ['同步中…', 's-syncing']
      : s.state === 'error'   ? ['同步失敗', 's-error']
      : s.state === 'signed-out' ? ['同步', '']
      : s.state === 'need-auth'  ? [pendingChanges ? '待同步' : '點此同步', 's-pending']
      : pendingChanges ? ['待同步', 's-pending'] : ['已同步', 's-ok'];
    syncBtn.textContent = label;
    syncBtn.className = `saved-btn sync-btn ${cls}`;
    syncBtn.title = s.account ? `Google 帳號：${s.account.email}` : '登入 Google 以在裝置間同步';

    syncInfo.textContent = s.account
      ? `${s.account.email}${s.lastSync ? ` · 上次同步 ${fmtSyncTime(s.lastSync)}` : ''}`
      : '登入 Google 後，備忘錄、花果標注與筆記會在你的各個裝置之間同步。資料存在你自己的雲端硬碟。';
    if (s.state === 'error' && s.error) {
      const e = document.createElement('span');
      e.className = 'sync-error';
      e.textContent = `  ${s.error}`;
      syncInfo.appendChild(e);
    }
    syncNowBtn.textContent = s.account ? '立即同步' : '登入 Google 並同步';
    syncNowBtn.disabled = s.state === 'syncing';
    signOutBtn.hidden = !s.account;
  });

  syncBtn.addEventListener('click', () => { flushNote(); sync.sync(); });
  syncNowBtn.addEventListener('click', () => { flushNote(); sync.sync(); });
  signOutBtn.addEventListener('click', () => {
    if (confirm('登出 Google 同步？本機的資料會保留，只是不再自動同步。')) sync.signOut();
  });
}

// ── PWA ───────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  const swUrl = new URL('../sw.js', import.meta.url).href;
  navigator.serviceWorker.register(swUrl).catch(() => {});
}
