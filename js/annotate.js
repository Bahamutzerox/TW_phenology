import { PHENO, recordKey, effectivePheno } from './pheno.js';
import { putAnnotation, deleteAnnotation } from './storage.js';

const CHOICES = [
  { key: '1', labels: ['flower'],          text: '花' },
  { key: '2', labels: ['fruit'],           text: '果' },
  { key: '3', labels: ['flower', 'fruit'], text: '花＋果' },
  { key: '4', labels: ['bud'],             text: '花苞' },
  { key: '0', labels: ['none'],            text: '無花果' },
];

const SOURCE_NAME = { user: '你的標注', inat: 'iNat 社群標注', gbif: '標本欄位' };

function labelText(labels) {
  return labels.map(l => PHENO[l]?.label || l).join('＋');
}

function largePhoto(url) {
  return url.replace(/\/(square|small|medium)\./, '/large.');
}

// Deterministic shuffle so the order is stable between openings
function hashId(r) {
  let h = 2166136261;
  for (const c of recordKey(r)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Round-robin across months so labels cover the whole year; unlabeled first
function buildQueue(records, annotations, onlyMonth) {
  const withPhoto = records.filter(r => r.photo_url && (!onlyMonth || r.month === onlyMonth));
  const byMonth = Array.from({ length: 12 }, () => ({ todo: [], done: [] }));
  for (const r of withPhoto) {
    const b = byMonth[r.month - 1];
    (annotations.has(recordKey(r)) ? b.done : b.todo).push(r);
  }
  const interleave = lists => {
    lists.forEach(l => l.sort((a, b) => hashId(a) - hashId(b)));
    const out = [];
    for (let i = 0; lists.some(l => i < l.length); i++) {
      for (const l of lists) if (i < l.length) out.push(l[i]);
    }
    return out;
  };
  return [...interleave(byMonth.map(b => b.todo)), ...interleave(byMonth.map(b => b.done))];
}

function h(tag, cls, content) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content != null) e.textContent = content;
  return e;
}

export function openAnnotator({ records, annotations, taxonName, onlyMonth = 0, onClose }) {
  const queue = buildQueue(records, annotations, onlyMonth);
  let idx = 0;
  let changed = false;

  const overlay = h('div', 'ann-overlay');
  const dialog = h('div', 'ann-dialog');
  overlay.appendChild(dialog);

  const top = h('div', 'ann-top');
  const title = h('div', 'ann-title');
  title.append('標注花果  ');
  title.appendChild(h('i', null, taxonName));
  if (onlyMonth) title.append(`  ·  ${onlyMonth}月`);
  const progress = h('div', 'ann-progress');
  const closeBtn = h('button', 'ann-close', '完成 (Esc)');
  top.append(title, progress, closeBtn);

  const body = h('div', 'ann-body');
  const photoWrap = h('div', 'ann-photo-wrap');
  const img = h('img', 'ann-photo');
  img.alt = '';
  photoWrap.appendChild(img);

  const side = h('aside', 'ann-side');
  const meta = h('div', 'ann-meta');
  const current = h('div', 'ann-current');
  const buttons = h('div', 'ann-buttons');
  for (const c of CHOICES) {
    const b = h('button', 'ann-choice');
    b.dataset.key = c.key;
    b.appendChild(h('span', 'ann-key', c.key));
    b.append(c.text);
    b.addEventListener('click', () => label(c.labels));
    buttons.appendChild(b);
  }
  const nav = h('div', 'ann-nav');
  const prevBtn = h('button', null, '← 上一張');
  const nextBtn = h('button', null, '略過 →');
  const clearBtn = h('button', 'ann-clear', '清除標注 (Del)');
  prevBtn.addEventListener('click', () => go(idx - 1));
  nextBtn.addEventListener('click', () => go(idx + 1));
  clearBtn.addEventListener('click', clear);
  nav.append(prevBtn, nextBtn, clearBtn);

  const coverTitle = h('div', 'ann-cover-title', '各月已標注（點月份跳到該月）');
  const cover = h('div', 'ann-cover');
  side.append(meta, current, buttons, nav, coverTitle, cover);
  body.append(photoWrap, side);
  dialog.append(top, body);

  function userCount() {
    return records.filter(r => annotations.has(recordKey(r))).length;
  }

  function drawCoverage() {
    cover.innerHTML = '';
    const done = new Array(12).fill(0);
    const total = new Array(12).fill(0);
    for (const r of records) {
      if (!r.photo_url) continue;
      total[r.month - 1]++;
      if (annotations.has(recordKey(r))) done[r.month - 1]++;
    }
    for (let m = 1; m <= 12; m++) {
      const c = h('button', 'ann-cover-cell');
      if (queue[idx]?.month === m) c.classList.add('active');
      c.disabled = !total[m - 1];
      c.appendChild(h('span', 'ann-cover-m', `${m}月`));
      c.appendChild(h('span', 'ann-cover-n', String(done[m - 1])));
      c.title = `${m}月：已標注 ${done[m - 1]} / ${total[m - 1]} 張`;
      c.addEventListener('click', () => {
        const next = queue.findIndex(r => r.month === m && !annotations.has(recordKey(r)));
        const any = queue.findIndex(r => r.month === m);
        if (next >= 0 || any >= 0) go(next >= 0 ? next : any);
      });
      cover.appendChild(c);
    }
  }

  function show() {
    progress.textContent = `已標注 ${userCount()} 筆  ·  第 ${Math.min(idx + 1, queue.length)} / ${queue.length} 張`;
    drawCoverage();
    if (!queue.length) {
      img.removeAttribute('src');
      meta.textContent = onlyMonth ? `${onlyMonth}月沒有附照片的記錄。` : '這個物種沒有附照片的記錄。';
      current.textContent = '';
      return;
    }
    if (idx >= queue.length) {
      img.removeAttribute('src');
      meta.textContent = '這一輪看完了。可以按「完成」回到時間軸，或點月份繼續補標。';
      current.textContent = '';
      return;
    }
    const r = queue[idx];
    img.src = largePhoto(r.photo_url);
    for (const n of queue.slice(idx + 1, idx + 3)) new Image().src = largePhoto(n.photo_url);

    meta.innerHTML = '';
    const date = r.observed_on || (r.year ? `${r.year}-${String(r.month).padStart(2, '0')}` : `${r.month}月`);
    meta.appendChild(h('div', 'ann-date', date));
    const loc = r.place || r.institution || r.dataset || '';
    if (loc) meta.appendChild(h('div', 'ann-loc', loc));
    const link = h('a', 'ann-link', r.source === 'inat' ? '在 iNaturalist 開啟' : '在 GBIF 開啟');
    link.href = r.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    meta.appendChild(link);

    const eff = effectivePheno(r, annotations);
    current.innerHTML = '';
    current.appendChild(h('span', 'ann-current-k', '目前判定'));
    current.appendChild(h('span', 'ann-current-v', eff.labels.length ? labelText(eff.labels) : '未判定'));
    if (eff.by) current.appendChild(h('span', 'ann-current-by', SOURCE_NAME[eff.by]));
    if (eff.by === 'user' && r.pheno?.length) {
      current.appendChild(h('span', 'ann-current-by', `（來源資料：${labelText(r.pheno)}）`));
    }

    const userLabels = annotations.get(recordKey(r));
    for (const b of buttons.children) {
      const c = CHOICES.find(x => x.key === b.dataset.key);
      b.classList.toggle('selected', !!userLabels && c.labels.join() === userLabels.join());
    }
    prevBtn.disabled = idx === 0;
  }

  function go(i) {
    idx = Math.max(0, Math.min(i, queue.length));
    show();
  }

  async function label(labels) {
    const r = queue[idx];
    if (!r) return;
    const key = recordKey(r);
    annotations.set(key, labels);
    changed = true;
    go(idx + 1);
    await putAnnotation({ key, taxon: taxonName, labels });
  }

  async function clear() {
    const r = queue[idx];
    if (!r) return;
    const key = recordKey(r);
    if (!annotations.has(key)) return;
    annotations.delete(key);
    changed = true;
    show();
    await deleteAnnotation(key);
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const c = CHOICES.find(x => x.key === e.key);
    if (c) { e.preventDefault(); label(c.labels); return; }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clear(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = '';
    onClose?.(changed);
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  show();
}
