export const PHENO = {
  flower: { label: '花',   color: '#d6457a', fill: 'rgba(214,69,122,0.28)' },
  fruit:  { label: '果',   color: '#d98a1f', fill: 'rgba(217,138,31,0.28)' },
  bud:    { label: '花苞', color: '#9b6bc2', fill: 'rgba(155,107,194,0.25)' },
  none:   { label: '無花果', color: '#8a9690', fill: 'rgba(138,150,144,0.2)' },
};

const INAT_VALUE = { 13: 'flower', 14: 'fruit', 15: 'bud', 21: 'none' };
const PLANT_PHENOLOGY_ATTR = 12;

export function recordKey(r) {
  return r.source === 'inat' ? `inat:${r.id}` : `gbif:${r.key}`;
}

export function parseINatAnnotations(annotations) {
  const out = new Set();
  for (const a of annotations || []) {
    if (a.controlled_attribute_id !== PLANT_PHENOLOGY_ATTR) continue;
    if ((a.vote_score ?? 0) < 0) continue;
    const v = INAT_VALUE[a.controlled_value_id];
    if (v) out.add(v);
  }
  return [...out];
}

// GBIF reproductiveCondition is free text, e.g. "flower budding;fruit ripening"
export function parseReproductiveCondition(str) {
  if (!str) return [];
  const out = new Set();
  for (const raw of String(str).toLowerCase().split(/[;,|/]/)) {
    const t = raw.trim();
    if (!t) continue;
    if (/bud|花苞|花蕾/.test(t)) out.add('bud');
    else if (/flower|bloom|anthesis|花/.test(t)) out.add('flower');
    else if (/fruit|seed|果/.test(t)) out.add('fruit');
    else if (/sterile|vegetative|營養/.test(t)) out.add('none');
  }
  return [...out];
}

// User labels win over source labels
export function effectivePheno(r, annotations) {
  const user = annotations?.get(recordKey(r));
  if (user) return { labels: user, by: 'user' };
  if (r.pheno?.length) return { labels: r.pheno, by: r.source };
  return { labels: [], by: null };
}

export function hasPheno(r, annotations, kind) {
  return effectivePheno(r, annotations).labels.includes(kind);
}
