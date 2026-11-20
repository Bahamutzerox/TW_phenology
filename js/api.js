import { parseINatAnnotations, parseReproductiveCondition, plantGroup } from './pheno.js';

const INAT_BASE = 'https://api.inaturalist.org/v1';
const GBIF_BASE = 'https://api.gbif.org/v1';

// Infraspecific taxa up to kingdom (e.g. 秋海棠科, 單子葉植物綱, 被子植物)
const SEARCH_RANKS = 'variety,subspecies,species,hybrid,section,subgenus,genus,subtribe,tribe,subfamily,family,superfamily,suborder,order,superorder,subclass,class,subphylum,phylum,kingdom';

export async function searchTaxa(query) {
  // autocomplete ranks exact name matches first; /taxa?order_by=observations_count buried
  // rare species (e.g. 山芫荽) under popular taxa. taxon_id 47126 = Plantae.
  const url = `${INAT_BASE}/taxa/autocomplete?q=${encodeURIComponent(query)}&taxon_id=47126&rank=${SEARCH_RANKS}&per_page=10&locale=zh-TW`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iNat taxa search failed: ${res.status}`);
  const data = await res.json();
  const results = data.results.map(t => ({
    id: t.id,
    name: t.name,
    rank: t.rank,
    // Prefer iNat's zh-TW name; matched_term can be a simplified-Chinese synonym
    common_name: /[㐀-鿿]/.test(t.preferred_common_name || '') ? t.preferred_common_name
      : /[㐀-鿿]/.test(t.matched_term || '') ? t.matched_term : (t.preferred_common_name || ''),
    matched_term: t.matched_term || '',
    // The name the user typed, when iNat files it under another name (昭和草 → 野茼蒿, 單子葉植物綱 → 百合綱)
    alias: _norm(t.matched_term).startsWith(_norm(query)) && /[㐀-鿿]/.test(query) && !_sameName(t.matched_term, t.preferred_common_name) ? t.matched_term : '',
    photo_url: t.default_photo?.square_url || null,
    observations_count: t.observations_count || 0,
    group: plantGroup(t.ancestor_ids, t.id),
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

const _norm = s => (s || '').trim().toLowerCase().replace(/台/g, '臺');
function _sameName(a, b) { return !!a && !!b && _norm(a) === _norm(b); }

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
      group: plantGroup(match.ancestor_ids, match.id),
    };
  });

  return (await Promise.all(lookups)).filter(Boolean);
}

const TAIWAN_PLACE_ID = 7887;

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

// iNat clades with no single GBIF backbone node: GBIF keys that together cover them
const GBIF_EQUIVALENT = {
  Angiospermae: [220, 196],   // Magnoliopsida + Liliopsida
};

export async function matchGBIFTaxon(name, rank) {
  if (GBIF_EQUIVALENT[name]) return { usageKey: GBIF_EQUIVALENT[name], species: name };
  const want = rank && rank !== 'hybrid' ? rank.toUpperCase() : '';   // GBIF files hybrids as SPECIES
  const rankParam = want ? `&rank=${want}` : '';
  const url = `${GBIF_BASE}/species/match?name=${encodeURIComponent(name)}&kingdom=Plantae${rankParam}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  // HIGHERRANK means GBIF only knows a parent taxon: its specimens would be the wrong taxon
  if (data.matchType === 'NONE' || data.matchType === 'HIGHERRANK' || !data.usageKey) return null;
  // Higher ranks differ between iNat and GBIF (e.g. a section matched to a genus): skip rather than show the wrong taxon
  if (want && data.rank !== want) return null;
  return { usageKey: data.acceptedUsageKey || data.usageKey, species: data.species || data.canonicalName || name };
}

export async function fetchGBIFSpecimens(taxonKey, onProgress, { taiwan = false } = {}) {
  const records = [];
  const MAX_PAGES = 3;
  const countryParam = taiwan ? '&country=TW' : '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * 300;
    const url = `${GBIF_BASE}/occurrence/search?taxonKey=${[].concat(taxonKey).join('&taxonKey=')}&basisOfRecord=PRESERVED_SPECIMEN&hasCoordinate=true${countryParam}&limit=300&offset=${offset}`;
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

// Plant group for taxa saved before groups existed: Map(id -> group)
export async function fetchTaxonGroups(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const res = await fetch(`${INAT_BASE}/taxa/${ids.slice(i, i + 30).join(',')}`);
    if (!res.ok) continue;
    for (const t of (await res.json()).results) out.set(t.id, plantGroup(t.ancestor_ids, t.id));
  }
  return out;
}
