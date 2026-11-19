import { parseINatAnnotations, parseReproductiveCondition } from './pheno.js';

const INAT_BASE = 'https://api.inaturalist.org/v1';
const GBIF_BASE = 'https://api.gbif.org/v1';

const PHENOLOGY = { FLOWERING: 13, FRUITING: 14, BUDDING: 15 };

export async function searchTaxa(query) {
  const url = `${INAT_BASE}/taxa?q=${encodeURIComponent(query)}&rank=species,subspecies,variety,genus&per_page=10&order_by=observations_count&locale=zh-TW`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iNat taxa search failed: ${res.status}`);
  const data = await res.json();
  const results = data.results.map(t => ({
    id: t.id,
    name: t.name,
    rank: t.rank,
    common_name: /[㐀-鿿]/.test(t.matched_term) ? t.matched_term : (t.preferred_common_name || ''),
    matched_term: t.matched_term || '',
    photo_url: t.default_photo?.square_url || null,
    observations_count: t.observations_count || 0,
  }));

  // For CJK queries, also search GBIF vernacular names as fallback
  if (/[㐀-鿿]/.test(query)) {
    try {
      const extra = await _searchViaGBIFVernacular(query, results);
      const seen = new Set(results.map(r => r.name.toLowerCase()));
      for (const r of extra) {
        if (!seen.has(r.name.toLowerCase())) {
          results.unshift(r); // put relevant Chinese matches first
          seen.add(r.name.toLowerCase());
        }
      }
    } catch (e) { /* ignore */ }
  }

  return results.slice(0, 8);
}

async function _searchViaGBIFVernacular(query, existing) {
  const res = await fetch(`${GBIF_BASE}/species/search?q=${encodeURIComponent(query)}&limit=8`);
  if (!res.ok) return [];
  const data = await res.json();

  const candidates = data.results
    .filter(sp => sp.canonicalName && sp.rank === 'SPECIES')
    .slice(0, 4);

  const lookups = candidates.map(async sp => {
    const r = await fetch(`${INAT_BASE}/taxa?q=${encodeURIComponent(sp.canonicalName)}&rank=species&per_page=3&order_by=observations_count`);
    if (!r.ok) return null;
    const d = await r.json();
    const match = d.results.find(t => t.name.toLowerCase() === sp.canonicalName.toLowerCase());
    if (!match) return null;
    return {
      id: match.id,
      name: match.name,
      rank: match.rank,
      common_name: /[㐀-鿿]/.test(match.preferred_common_name || '') ? match.preferred_common_name : query,
      matched_term: query,
      photo_url: match.default_photo?.square_url || null,
      observations_count: match.observations_count || 0,
    };
  });

  return (await Promise.all(lookups)).filter(Boolean);
}

const TAIWAN_PLACE_ID = 7887;

export async function fetchINatPhenology(taxonId, onProgress, { taiwan = false } = {}) {
  const types = [
    { key: 'flowering', value_id: PHENOLOGY.FLOWERING },
    { key: 'fruiting',  value_id: PHENOLOGY.FRUITING  },
    { key: 'budding',   value_id: PHENOLOGY.BUDDING   },
  ];
  const results = { flowering: [], fruiting: [], budding: [] };

  for (const type of types) {
    try {
      results[type.key] = await _fetchINatPages(taxonId, type.value_id, type.key, taiwan);
    } catch (e) {
      console.warn(`iNat ${type.key} fetch failed:`, e);
    }
    if (onProgress) onProgress(type.key);
  }
  return results;
}

async function _fetchINatPages(taxonId, termValueId, typeKey, taiwan) {
  const records = [];
  const MAX_PAGES = 5;
  const placeParam = taiwan ? `&place_id=${TAIWAN_PLACE_ID}` : '';

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${INAT_BASE}/observations?taxon_id=${taxonId}&term_id=12&term_value_id=${termValueId}${placeParam}&per_page=200&page=${page}&order_by=observed_on`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();

    for (const obs of data.results) {
      const month = obs.observed_on_details?.month;
      if (!month) continue;
      const coords = _parseINatCoords(obs);
      records.push({
        id: obs.id,
        type: typeKey,
        observed_on: obs.observed_on || '',
        month,
        year: obs.observed_on_details?.year || null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        place: obs.place_guess || '',
        quality: obs.quality_grade || '',
        source: 'inat',
        url: `https://www.inaturalist.org/observations/${obs.id}`,
      });
    }

    if (data.results.length < 200) break;
    if (records.length >= data.total_results) break;
  }
  return records;
}

function _parseINatCoords(obs) {
  if (obs.obscured) return null;
  if (obs.geojson?.coordinates) {
    return { lat: obs.geojson.coordinates[1], lng: obs.geojson.coordinates[0] };
  }
  if (obs.location) {
    const [lat, lng] = obs.location.split(',').map(Number);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }
  return null;
}

export async function fetchINatObservations(taxonId, onProgress, { taiwan = false } = {}) {
  const records = [];
  const MAX_PAGES = 5;
  const placeParam = taiwan ? `&place_id=${TAIWAN_PLACE_ID}` : '';

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${INAT_BASE}/observations?taxon_id=${taxonId}${placeParam}&per_page=200&page=${page}&order_by=observed_on`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();

    for (const obs of data.results) {
      const month = obs.observed_on_details?.month;
      if (!month) continue;
      const day = obs.observed_on_details?.day || 15;
      const coords = _parseINatCoords(obs);
      records.push({
        id: obs.id,
        type: 'inat',
        observed_on: obs.observed_on || '',
        month,
        day,
        year: obs.observed_on_details?.year || null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        place: obs.place_guess || '',
        quality: obs.quality_grade || '',
        source: 'inat',
        url: `https://www.inaturalist.org/observations/${obs.id}`,
        photo_url: obs.photos?.[0]?.url?.replace('square', 'medium') || null,
        pheno: parseINatAnnotations(obs.annotations),
      });
    }

    if (onProgress) onProgress(page);
    if (data.results.length < 200) break;
    if (records.length >= data.total_results) break;
  }
  return records;
}

export async function matchGBIFTaxon(name) {
  const url = `${GBIF_BASE}/species/match?name=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.matchType === 'NONE' || !data.usageKey) return null;
  return { usageKey: data.usageKey, species: data.species || data.canonicalName || name };
}

export async function fetchGBIFSpecimens(taxonKey, onProgress, { taiwan = false } = {}) {
  const records = [];
  const MAX_PAGES = 3;
  const countryParam = taiwan ? '&country=TW' : '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * 300;
    const url = `${GBIF_BASE}/occurrence/search?taxonKey=${taxonKey}&basisOfRecord=PRESERVED_SPECIMEN&hasCoordinate=true${countryParam}&limit=300&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();

    for (const occ of data.results) {
      if (!occ.month || occ.decimalLatitude == null || occ.decimalLongitude == null) continue;
      records.push({
        key: occ.key,
        type: 'specimen',
        month: occ.month,
        day: occ.day || null,
        year: occ.year || null,
        lat: occ.decimalLatitude,
        lng: occ.decimalLongitude,
        institution: occ.institutionCode || '',
        dataset: occ.datasetName || '',
        recorded_by: occ.recordedBy || '',
        country: occ.countryCode || '',
        source: 'gbif',
        photo_url: occ.media?.find(m => m.type === 'StillImage')?.identifier || null,
        pheno: parseReproductiveCondition(occ.reproductiveCondition),
        url: `https://www.gbif.org/occurrence/${occ.key}`,
      });
    }

    if (onProgress) onProgress();
    if (data.endOfRecords) break;
  }
  return records;
}
