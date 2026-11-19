export const PHENO = {
  flower: { label: '花',   color: '#d6457a', fill: 'rgba(214,69,122,0.28)' },
  fruit:  { label: '果',   color: '#d98a1f', fill: 'rgba(217,138,31,0.28)' },
  bud:    { label: '花苞', color: '#9b6bc2', fill: 'rgba(155,107,194,0.25)' },
  none:   { label: '無花果', color: '#8a9690', fill: 'rgba(138,150,144,0.2)' },
};

// ── Plant groups ─────────────────────────────────────────────────────────────
// Labels are stored as the same four slots for every group (so charts, memo and
// sync stay unchanged); only the wording differs. Spore plants use
// flower = immature sporangia, fruit = mature sporangia (spores ready).
const SPORE = { flower: '未熟孢子囊', fruit: '成熟孢子囊', bud: '孢子囊芽', none: '無孢子囊' };
export const GROUPS = {
  angio: {
    name: '被子植物', short: '花果',
    labels: { flower: '花', fruit: '果', bud: '花苞', none: '無花果' },
    choices: [['1', ['flower']], ['2', ['fruit']], ['3', ['flower', 'fruit']], ['4', ['bud']], ['0', ['none']]],
    target: { flower: '花', fruit: '果', both: '花與果' },
    badge:  { flower: '採花', fruit: '採果', both: '花果' },
  },
  gymno: {
    name: '裸子植物', short: '毬花毬果',
    labels: { flower: '毬花', fruit: '毬果／種子', bud: '毬花芽', none: '無毬花毬果' },
    choices: [['1', ['flower']], ['2', ['fruit']], ['3', ['flower', 'fruit']], ['4', ['bud']], ['0', ['none']]],
    target: { flower: '毬花', fruit: '毬果／種子', both: '兩者' },
    badge:  { flower: '採毬花', fruit: '採種子', both: '毬花毬果' },
  },
  fern: {
    name: '蕨類', short: '孢子囊',
    labels: SPORE,
    choices: [['1', ['flower']], ['2', ['fruit']], ['3', ['flower', 'fruit']], ['0', ['none']]],
    target: { flower: '未熟孢子囊', fruit: '成熟孢子囊', both: '兩者' },
    badge:  { flower: '未熟孢子囊', fruit: '採孢子', both: '孢子囊' },
  },
  lyco: null,   // filled below: same as fern, different name
  bryo: {
    name: '苔蘚', short: '孢蒴',
    labels: { flower: '未熟孢蒴', fruit: '成熟孢蒴', bud: '孢蒴芽', none: '無孢子體' },
    choices: [['1', ['flower']], ['2', ['fruit']], ['3', ['flower', 'fruit']], ['0', ['none']]],
    target: { flower: '未熟孢蒴', fruit: '成熟孢蒴', both: '兩者' },
    badge:  { flower: '未熟孢蒴', fruit: '採孢蒴', both: '孢蒴' },
  },
};
GROUPS.lyco = { ...GROUPS.fern, name: '石松類' };

// iNaturalist taxon ids
const GROUP_ANCESTORS = [
  ['angio', [47125]],                          // Angiospermae
  ['gymno', [136329, 136336, 151882, 151883]], // Pinopsida, Cycadopsida, Ginkgoopsida, Gnetopsida
  ['fern',  [121943]],                         // Polypodiopsida
  ['lyco',  [47623]],                          // Lycopodiopsida
  ['bryo',  [311249, 64615, 56327]],           // mosses, liverworts, hornworts
];

export function plantGroup(ancestorIds, selfId) {
  const ids = new Set([...(ancestorIds || []), selfId]);
  for (const [g, list] of GROUP_ANCESTORS) if (list.some(id => ids.has(id))) return g;
  return '';
}

// Unknown group falls back to flowering-plant wording
export function groupInfo(group) {
  return GROUPS[group] || GROUPS.angio;
}

export function phenoLabel(kind, group) {
  return groupInfo(group).labels[kind] || PHENO[kind]?.label || kind;
}

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
    else if (/sporang|sori\b|sorus|spore|孢子/.test(t)) out.add('fruit');
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
