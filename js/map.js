let _map = null;
let _markers = null;
let _resizeObserver = null;

export function initMap(containerId) {
  if (_map) { _map.remove(); _map = null; }

  const el = document.getElementById(containerId);
  _map = L.map(el).setView([23.5, 121], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(_map);
  _markers = L.layerGroup().addTo(_map);

  // Layout changes (phone rotation, hidden → shown) otherwise leave grey untiled areas
  _resizeObserver?.disconnect();
  _resizeObserver = new ResizeObserver(() => _map?.invalidateSize());
  _resizeObserver.observe(el);
}

export function renderMap(containerId, inatRecords, gbifRecords) {
  if (!_map) initMap(containerId);
  _map.invalidateSize();
  _markers.clearLayers();

  const bounds = [];
  const inatSample = inatRecords.length > 800 ? _sample(inatRecords, 800) : inatRecords;
  const gbifSample = gbifRecords.length > 500 ? _sample(gbifRecords, 500) : gbifRecords;

  const seen = new Set();
  for (const r of inatSample) {
    if (!r.lat || !r.lng || seen.has(r.id)) continue;
    seen.add(r.id);
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 5, color: '#e76f51', fillColor: '#e76f51', fillOpacity: 0.65, weight: 1,
    });
    marker.bindPopup(() => _popup('iNaturalist', '#e76f51', [
      ['日期', r.observed_on || '—'],
      ['地點', r.place || '—'],
    ], r.url), { maxWidth: 240 });
    _markers.addLayer(marker);
    bounds.push([r.lat, r.lng]);
  }

  for (const r of gbifSample) {
    if (!r.lat || !r.lng) continue;
    const date = r.year ? `${r.year}-${String(r.month).padStart(2, '0')}` : `${r.month}月`;
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 5, color: '#4361ee', fillColor: '#4361ee', fillOpacity: 0.65, weight: 1,
    });
    marker.bindPopup(() => _popup('GBIF 標本', '#4361ee', [
      ['日期', date],
      ['典藏', r.institution || r.dataset || '—'],
      ['採集者', r.recorded_by || '—'],
    ], r.url), { maxWidth: 240 });
    _markers.addLayer(marker);
    bounds.push([r.lat, r.lng]);
  }

  // Always focus on Taiwan: records abroad (non-endemic species, wrong
  // specimen coordinates) stay on the map but never drive the zoom
  const inTW = bounds.filter(_inTaiwan);
  if (inTW.length > 0) _map.fitBounds(inTW, { padding: [20, 20], maxZoom: 12 });
  else _map.fitBounds(TAIWAN_BOUNDS);
}

export function invalidateMap() {
  if (_map) setTimeout(() => _map.invalidateSize(), 150);
}

function _popup(title, color, rows, url) {
  const box = document.createElement('div');
  box.style.lineHeight = '1.55';
  const t = document.createElement('b');
  t.style.color = color;
  t.textContent = title;
  box.appendChild(t);
  for (const [k, v] of rows) {
    const line = document.createElement('div');
    const key = document.createElement('span');
    key.style.color = '#6b8070';
    key.textContent = `${k}　`;
    line.append(key, v);
    box.appendChild(line);
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.color = '#2d6a4f';
  a.textContent = '查看原始記錄';
  box.appendChild(a);
  return box;
}

const TAIWAN_BOUNDS = [[21.85, 119.3], [25.35, 122.05]];

// Taiwan, Penghu, Kinmen, Matsu, Pratas, Lanyu
function _inTaiwan([lat, lng]) {
  return lat >= 20.5 && lat <= 26.5 && lng >= 116.5 && lng <= 123;
}

function _sample(arr, n) {
  if (arr.length <= n) return arr;
  const result = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) result.push(arr[Math.floor(i * step)]);
  return result;
}
