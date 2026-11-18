let _map = null;
let _markers = null;

export function initMap(containerId) {
  if (_map) { _map.remove(); _map = null; }

  _map = L.map(containerId).setView([23.5, 121], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(_map);
  _markers = L.layerGroup().addTo(_map);
}

export function renderMap(containerId, inatRecords, gbifRecords) {
  if (!_map) initMap(containerId);
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
    marker.bindPopup(_inatPopup(r), { maxWidth: 240 });
    _markers.addLayer(marker);
    bounds.push([r.lat, r.lng]);
  }

  for (const r of gbifSample) {
    if (!r.lat || !r.lng) continue;
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 5, color: '#4361ee', fillColor: '#4361ee', fillOpacity: 0.65, weight: 1,
    });
    marker.bindPopup(_gbifPopup(r), { maxWidth: 240 });
    _markers.addLayer(marker);
    bounds.push([r.lat, r.lng]);
  }

  if (bounds.length > 0) {
    _map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
  }
  setTimeout(() => _map.invalidateSize(), 150);
}

export function invalidateMap() {
  if (_map) setTimeout(() => _map.invalidateSize(), 150);
}

function _inatPopup(r) {
  return `
    <div style="line-height:1.5">
      <b style="color:#e76f51">iNaturalist</b><br>
      📅 ${r.observed_on || '—'}<br>
      📍 ${r.place || '—'}<br>
      <a href="${r.url}" target="_blank" rel="noopener" style="color:#2d6a4f">查看原始記錄 ↗</a>
    </div>`;
}

function _gbifPopup(r) {
  const date = r.year ? `${r.year}-${String(r.month).padStart(2, '0')}` : `${r.month}月`;
  return `
    <div style="line-height:1.5">
      <b style="color:#4361ee">GBIF 標本</b><br>
      📅 ${date}<br>
      🏛️ ${r.institution || r.dataset || '—'}<br>
      👤 ${r.recorded_by || '—'}<br>
      <a href="${r.url}" target="_blank" rel="noopener" style="color:#2d6a4f">查看原始記錄 ↗</a>
    </div>`;
}

function _sample(arr, n) {
  if (arr.length <= n) return arr;
  const result = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) result.push(arr[Math.floor(i * step)]);
  return result;
}
