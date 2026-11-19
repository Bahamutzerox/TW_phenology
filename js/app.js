import { searchTaxa, fetchINatObservations, matchGBIFTaxon, fetchGBIFSpecimens } from './api.js';
import { renderTimeline, renderMonthDetail } from './timeline.js';
import { renderMap } from './map.js';
import { saveSearch, listSearches, deleteSearch } from './storage.js';
import { normalizeInatRecords, groupByTaxon, renderMemo, countInMonth } from './memo.js';

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
    info.innerHTML = `<div class="ac-sci">${t.name}</div>${t.common_name ? `<div class="ac-common">${t.common_name}</div>` : ''}`;
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
  monthDetailWrap.hidden = true;

  // Timeline
  renderTimeline(timelineEl, state.inatRecords, state.gbifRecords, handleTimelineClick, { bandwidth: KDE_BANDWIDTH });

  // Map (always render; re-render on new search)
  renderMap('map-container', state.inatRecords, state.gbifRecords);
  state.mapReady = true;

  // Records
  monthFilter.value = '0';
  typeFilter.value  = 'all';
  renderRecordsList();

  // Save
  saveBtn.disabled       = false;
  saveStatus.textContent = '';
  saveBar.hidden = false;
}

// ── Timeline click handler ────────────────────────────────────────────────────
const MONTH_ZH = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

function handleTimelineClick(month) {
  monthFilter.value  = String(month);
  typeFilter.value   = 'all';
  state.recordOffset = 0;
  renderRecordsList();

  // Month detail Manhattan plot
  const inatFil = state.inatRecords.filter(r => r.month === month);
  const gbifFil = state.gbifRecords.filter(r => r.month === month);
  monthDetailLabel.textContent =
    `${MONTH_ZH[month - 1]}  ·  iNat ${inatFil.length} 筆  /  GBIF ${gbifFil.length} 筆`;
  renderMonthDetail(monthDetailChart, state.inatRecords, state.gbifRecords, month);
  monthDetailWrap.hidden = false;
  monthDetailWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  const overlay = document.createElement('div');
  overlay.className = 'grid-overlay';
  const dateStr = r.observed_on
    ? r.observed_on.slice(0, 7)
    : r.year ? `${r.year}-${String(r.month).padStart(2,'0')}` : `${r.month}月`;
  const loc = r.place || r.institution || '';
  overlay.innerHTML = `<span class="grid-date">${dateStr}</span>${loc ? `<span class="grid-loc">${loc}</span>` : ''}`;
  a.appendChild(overlay);
  return a;
}

function createRecordCard(r) {
  const [cls, text] = r.source === 'inat'
    ? ['badge-inat', 'iNat']
    : ['badge-specimen', '標本'];
  const dateStr = r.observed_on || (r.year ? `${r.year}-${String(r.month).padStart(2,'0')}` : `${r.month}月`);
  const loc     = r.place || r.institution || r.dataset || '';
  const card    = document.createElement('div');
  card.className = 'record-card';
  card.innerHTML = `
    <span class="record-badge ${cls}">${text}</span>
    <div class="record-info">
      <div class="record-date">${dateStr}</div>
      ${loc ? `<div class="record-location">${loc}</div>` : ''}
    </div>
    <a class="record-link" href="${r.url}" target="_blank" rel="noopener noreferrer">查看</a>`;
  return card;
}

// ── Collection memo ───────────────────────────────────────────────────────────
let memoItems = [];

function openMemo() {
  introState.hidden = true;
  dashboard.hidden  = true;
  memoView.hidden   = false;
  savedBtn.classList.add('active');
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

  memoSummary.textContent = month
    ? `${month}月有 ${countInMonth(memoItems, month)} 種處於記錄高峰（已依該月記錄量排序，記錄偏少的物種淡化顯示）`
    : '色塊深淺為各物種每月記錄量（以該物種最多的月份為最深）。選擇月份可排序。';

  renderMemo(memoList, memoItems, {
    month,
    onLoad: loadSaved,
    onDelete: async (entry, ids) => {
      if (!confirm(`從備忘錄刪除 ${entry.taxon_name}？`)) return;
      for (const id of ids) await deleteSearch(id);
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
  if (monthFilter.value === '0') monthDetailWrap.hidden = true;
});
typeFilter.addEventListener('change',  () => {
  state.recordOffset = 0;
  renderRecordsList();
  const type = typeFilter.value;
  const inat = type === 'gbif' ? [] : state.inatRecords;
  const gbif = type === 'inat' ? [] : state.gbifRecords;
  renderTimeline(timelineEl, inat, gbif, handleTimelineClick, { bandwidth: KDE_BANDWIDTH });
});
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

$('month-detail-close').addEventListener('click', () => { monthDetailWrap.hidden = true; });

// ── PWA ───────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  const swUrl = new URL('../sw.js', import.meta.url).href;
  navigator.serviceWorker.register(swUrl).catch(() => {});
}
