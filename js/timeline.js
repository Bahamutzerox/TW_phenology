const DOY_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];
const TOTAL_DAYS = 365;
const NS = 'http://www.w3.org/2000/svg';

function toDoy(month, day) {
  return Math.min(TOTAL_DAYS, DOY_START[Math.min(month, 12) - 1] + (day || 15));
}

function gaussKDE(doys, bandwidth, xs) {
  if (!doys.length) return xs.map(() => 0);
  return xs.map(x => {
    let sum = 0;
    for (const v of doys) {
      const d = Math.min(Math.abs(x - v), TOTAL_DAYS - Math.abs(x - v));
      sum += Math.exp(-0.5 * (d / bandwidth) ** 2);
    }
    return sum;
  });
}

function normalize(arr) {
  const max = Math.max(...arr, 1e-10);
  return arr.map(v => v / max);
}

function buildAreaPath(xs, ys, xScale, yScale) {
  const baseY = yScale(0);
  let d = `M ${xScale(xs[0])},${baseY} L ${xScale(xs[0])},${yScale(ys[0])}`;
  for (let i = 1; i < xs.length; i++) d += ` L ${xScale(xs[i])},${yScale(ys[i])}`;
  return d + ` L ${xScale(xs[xs.length - 1])},${baseY} Z`;
}

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function text(x, y, content, attrs = {}) {
  const t = el('text', { x, y, 'font-size': '11', fill: '#888', ...attrs });
  t.textContent = content;
  return t;
}

function newSvg(W, H) {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  svg.style.display = 'block';
  return svg;
}

// series: [{ label, color, fill, records }]; drawn last-to-first so the first series sits on top
export function renderTimeline(container, series, onMonthClick, { bandwidth = 10 } = {}) {
  container.innerHTML = '';
  const xs = Array.from({ length: 183 }, (_, i) => i * 2 + 1);

  const W = 820, H = 200;
  const PAD = { top: 32, right: 15, bottom: 44, left: 15 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const xScale = x => PAD.left + (x - 1) / (TOTAL_DAYS - 1) * chartW;
  const yScale = v => PAD.top + chartH - v * chartH;
  const svg = newSvg(W, H);

  for (let m = 0; m < 12; m++) {
    const x = xScale(DOY_START[m] + 1);
    const nextX = xScale(m < 11 ? DOY_START[m + 1] + 1 : TOTAL_DAYS);
    svg.appendChild(el('line', { x1: x, y1: PAD.top, x2: x, y2: PAD.top + chartH, stroke: '#ddd', 'stroke-width': '1' }));
    svg.appendChild(text((x + nextX) / 2, PAD.top + chartH + 20, MONTH_NAMES[m], { 'text-anchor': 'middle' }));
    const hit = el('rect', { x, y: PAD.top, width: nextX - x, height: chartH, fill: 'transparent', cursor: 'pointer' });
    hit.addEventListener('mouseenter', () => hit.setAttribute('fill', 'rgba(0,0,0,0.04)'));
    hit.addEventListener('mouseleave', () => hit.setAttribute('fill', 'transparent'));
    if (onMonthClick) hit.addEventListener('click', () => onMonthClick(m + 1));
    svg.appendChild(hit);
  }

  for (const s of [...series].reverse()) {
    if (!s.records.length) continue;
    const ys = normalize(gaussKDE(s.records.map(r => toDoy(r.month, r.day)), bandwidth, xs));
    svg.appendChild(el('path', {
      d: buildAreaPath(xs, ys, xScale, yScale),
      fill: s.fill, stroke: s.color, 'stroke-width': '1.5', 'stroke-linejoin': 'round',
      'pointer-events': 'none',
    }));
  }

  svg.appendChild(el('line', {
    x1: PAD.left, y1: PAD.top + chartH, x2: PAD.left + chartW, y2: PAD.top + chartH, stroke: '#ccc', 'stroke-width': '1',
  }));

  series.filter(s => s.records.length).forEach((s, i) => {
    const lx = PAD.left + i * 150;
    svg.appendChild(el('rect', { x: lx, y: 8, width: 14, height: 10, rx: '2', fill: s.fill, stroke: s.color, 'stroke-width': '1' }));
    svg.appendChild(text(lx + 18, 18, `${s.label}  ${s.records.length} 筆`, { fill: '#555' }));
  });

  container.appendChild(svg);
}

export function renderMonthDetail(container, series, month) {
  const dim = DAYS_IN_MONTH[month - 1];
  const counts = series.map(s => {
    const c = new Array(dim + 1).fill(0);
    for (const r of s.records) {
      if (r.month === month && r.day >= 1 && r.day <= dim) c[r.day]++;
    }
    return c;
  });
  const maxCount = Math.max(1, ...counts.flatMap(c => c.slice(1)));

  const W = 760, H = 130;
  const PAD = { top: 20, right: 15, bottom: 28, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const xStep = chartW / dim;
  const xPos = day => PAD.left + (day - 0.5) * xStep;
  const yPos = n => PAD.top + chartH * (1 - n / maxCount);
  const baseY = PAD.top + chartH;
  const svg = newSvg(W, H);

  const tickStep = Math.max(1, Math.ceil(maxCount / 4));
  for (let t = tickStep; t <= maxCount; t += tickStep) {
    const y = yPos(t);
    svg.appendChild(el('line', { x1: PAD.left, y1: y, x2: PAD.left + chartW, y2: y, stroke: '#eee', 'stroke-width': '1' }));
    svg.appendChild(text(PAD.left - 5, y + 3.5, String(t), { 'text-anchor': 'end', 'font-size': '10', fill: '#bbb' }));
  }

  const gap = xStep > 10 ? 5 : 2;
  series.forEach((s, si) => {
    const off = (si - (series.length - 1) / 2) * gap;
    for (let d = 1; d <= dim; d++) {
      const n = counts[si][d];
      if (!n) continue;
      const x = xPos(d) + off;
      const y = yPos(n);
      svg.appendChild(el('line', { x1: x, y1: baseY, x2: x, y2: y + 3, stroke: s.color, 'stroke-width': '2' }));
      const dot = el('circle', { cx: x, cy: y, r: '3.5', fill: s.color });
      const title = el('title', {});
      title.textContent = `${d}日 ${s.label}: ${n} 筆`;
      dot.appendChild(title);
      svg.appendChild(dot);
    }
  });

  svg.appendChild(el('line', { x1: PAD.left, y1: baseY, x2: PAD.left + chartW, y2: baseY, stroke: '#ccc', 'stroke-width': '1' }));
  for (let d = 1; d <= dim; d += 5) {
    svg.appendChild(text(xPos(d), baseY + 14, String(d), { 'text-anchor': 'middle', 'font-size': '10', fill: '#aaa' }));
  }

  container.innerHTML = '';
  container.appendChild(svg);
}
