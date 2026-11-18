const DOY_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const TOTAL_DAYS = 365;

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
  for (let i = 1; i < xs.length; i++) {
    d += ` L ${xScale(xs[i])},${yScale(ys[i])}`;
  }
  d += ` L ${xScale(xs[xs.length - 1])},${baseY} Z`;
  return d;
}

export function renderTimeline(container, inatRecords, gbifRecords, onMonthClick, { bandwidth = 20, compareBandwidth = null } = {}) {
  container.innerHTML = '';

  const inatDoys = inatRecords.map(r => toDoy(r.month, r.day));
  const gbifDoys  = gbifRecords.map(r => toDoy(r.month, r.day));

  // Evaluate at every 2 days (183 points) for a smooth curve
  const xs = Array.from({ length: 183 }, (_, i) => i * 2 + 1);

  const inatK = gaussKDE(inatDoys, bandwidth, xs);
  const gbifK  = gaussKDE(gbifDoys,  bandwidth, xs);

  const inatN = normalize(inatK);
  const gbifN  = normalize(gbifK);

  const inatCompN = compareBandwidth
    ? normalize(gaussKDE(inatDoys, compareBandwidth, xs))
    : null;

  const W = 820, H = 200;
  const PAD = { top: 32, right: 15, bottom: 44, left: 15 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const xScale = x => PAD.left + (x - 1) / (TOTAL_DAYS - 1) * chartW;
  const yScale = v => PAD.top + chartH - v * chartH;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.style.display = 'block';

  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // ── Month grid lines & click regions ────────────────────────────────────────
  for (let m = 0; m < 12; m++) {
    const doy  = DOY_START[m] + 1;
    const nextDoy = m < 11 ? DOY_START[m + 1] + 1 : TOTAL_DAYS;
    const x    = xScale(doy);
    const nextX = xScale(nextDoy);
    const midX = (x + nextX) / 2;

    svg.appendChild(el('line', {
      x1: x, y1: PAD.top, x2: x, y2: PAD.top + chartH,
      stroke: '#ddd', 'stroke-width': '1',
    }));

    // Month label
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', midX); lbl.setAttribute('y', PAD.top + chartH + 20);
    lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('font-size', '11');
    lbl.setAttribute('fill', '#888');
    lbl.textContent = MONTH_NAMES[m];
    svg.appendChild(lbl);

    // Invisible click region
    const hit = el('rect', {
      x, y: PAD.top, width: nextX - x, height: chartH,
      fill: 'transparent', cursor: 'pointer',
    });
    hit.addEventListener('mouseenter', () => hit.setAttribute('fill', 'rgba(0,0,0,0.04)'));
    hit.addEventListener('mouseleave', () => hit.setAttribute('fill', 'transparent'));
    if (onMonthClick) hit.addEventListener('click', () => onMonthClick(m + 1));
    svg.appendChild(hit);
  }

  // ── Density curves ───────────────────────────────────────────────────────────
  if (gbifDoys.length) {
    const path = el('path', {
      d: buildAreaPath(xs, gbifN, xScale, yScale),
      fill: 'rgba(67,97,238,0.3)',
      stroke: '#4361ee',
      'stroke-width': '1.5',
      'stroke-linejoin': 'round',
      'pointer-events': 'none',
    });
    svg.appendChild(path);
  }

  if (inatDoys.length) {
    const path = el('path', {
      d: buildAreaPath(xs, inatN, xScale, yScale),
      fill: 'rgba(82,183,136,0.45)',
      stroke: '#52b788',
      'stroke-width': '1.5',
      'stroke-linejoin': 'round',
      'pointer-events': 'none',
    });
    svg.appendChild(path);
  }

  // Compare curve (dashed, no fill)
  if (inatCompN && inatDoys.length) {
    const compPath = el('path', {
      d: buildAreaPath(xs, inatCompN, xScale, yScale),
      fill: 'none',
      stroke: '#e76f51',
      'stroke-width': '2',
      'stroke-linejoin': 'round',
      'stroke-dasharray': '5,3',
      'pointer-events': 'none',
    });
    svg.appendChild(compPath);
  }

  // ── Baseline ─────────────────────────────────────────────────────────────────
  svg.appendChild(el('line', {
    x1: PAD.left, y1: PAD.top + chartH,
    x2: PAD.left + chartW, y2: PAD.top + chartH,
    stroke: '#ccc', 'stroke-width': '1',
  }));

  // ── Legend ───────────────────────────────────────────────────────────────────
  const legendItems = [];
  if (inatDoys.length) legendItems.push({ fill: 'rgba(82,183,136,0.45)', stroke: '#52b788', dash: null, label: `iNaturalist  ${inatDoys.length} 筆` });
  if (inatCompN && inatDoys.length) legendItems.push({ fill: 'none', stroke: '#e76f51', dash: '5,3', label: `iNat  帶寬${compareBandwidth}天` });
  if (gbifDoys.length)  legendItems.push({ fill: 'rgba(67,97,238,0.3)',  stroke: '#4361ee', dash: null, label: `GBIF 標本  ${gbifDoys.length} 筆` });

  legendItems.forEach((item, i) => {
    const lx = PAD.left + i * 180;
    if (item.dash) {
      svg.appendChild(el('line', {
        x1: lx, y1: 13, x2: lx + 14, y2: 13,
        stroke: item.stroke, 'stroke-width': '2', 'stroke-dasharray': item.dash,
      }));
    } else {
      svg.appendChild(el('rect', {
        x: lx, y: 8, width: 14, height: 10, rx: '2',
        fill: item.fill, stroke: item.stroke, 'stroke-width': '1',
      }));
    }
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', lx + 18); lbl.setAttribute('y', 18);
    lbl.setAttribute('font-size', '11'); lbl.setAttribute('fill', '#555');
    lbl.textContent = item.label;
    svg.appendChild(lbl);
  });

  container.appendChild(svg);
}

const MONTH_ZH_D = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];

export function renderMonthDetail(container, inatRecords, gbifRecords, month) {
  const dim = DAYS_IN_MONTH[month - 1];

  const inatFil = inatRecords.filter(r => r.month === month);
  const gbifFil = gbifRecords.filter(r => r.month === month && r.day != null);

  const inatByDay = new Array(dim + 2).fill(0);
  const gbifByDay = new Array(dim + 2).fill(0);
  for (const r of inatFil) { const d = r.day; if (d >= 1 && d <= dim) inatByDay[d]++; }
  for (const r of gbifFil) { if (r.day >= 1 && r.day <= dim) gbifByDay[r.day]++; }

  const maxCount = Math.max(...inatByDay.slice(1, dim + 1), ...gbifByDay.slice(1, dim + 1), 1);

  const W = 760, H = 130;
  const PAD = { top: 20, right: 15, bottom: 28, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const xStep  = chartW / dim;
  const xPos   = day   => PAD.left + (day - 0.5) * xStep;
  const yPos   = count => PAD.top + chartH * (1 - count / maxCount);
  const baseY  = PAD.top + chartH;

  const ns  = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.style.display = 'block';

  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // Y-axis grid lines
  const tickStep = Math.max(1, Math.ceil(maxCount / 4));
  for (let t = tickStep; t <= maxCount; t += tickStep) {
    const y = yPos(t);
    svg.appendChild(el('line', { x1: PAD.left, y1: y, x2: PAD.left + chartW, y2: y, stroke: '#eee', 'stroke-width': '1' }));
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', PAD.left - 5); lbl.setAttribute('y', y + 3.5);
    lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('font-size', '10'); lbl.setAttribute('fill', '#bbb');
    lbl.textContent = t;
    svg.appendChild(lbl);
  }

  // Stems + dots (Manhattan plot)
  const OFF = xStep > 10 ? 2.5 : 1;
  for (let d = 1; d <= dim; d++) {
    const x = xPos(d);
    if (inatByDay[d]) {
      const y = yPos(inatByDay[d]);
      const g = document.createElementNS(ns, 'g');
      g.appendChild(el('line', { x1: x - OFF, y1: baseY, x2: x - OFF, y2: y + 3, stroke: '#52b788', 'stroke-width': '2' }));
      const dot = el('circle', { cx: x - OFF, cy: y, r: '3.5', fill: '#52b788' });
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${d}日 iNat: ${inatByDay[d]} 筆`;
      dot.appendChild(title);
      g.appendChild(dot);
      svg.appendChild(g);
    }
    if (gbifByDay[d]) {
      const y = yPos(gbifByDay[d]);
      const g = document.createElementNS(ns, 'g');
      g.appendChild(el('line', { x1: x + OFF, y1: baseY, x2: x + OFF, y2: y + 3, stroke: '#4361ee', 'stroke-width': '2' }));
      const dot = el('circle', { cx: x + OFF, cy: y, r: '3.5', fill: '#4361ee' });
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${d}日 GBIF: ${gbifByDay[d]} 筆`;
      dot.appendChild(title);
      g.appendChild(dot);
      svg.appendChild(g);
    }
  }

  // Baseline
  svg.appendChild(el('line', { x1: PAD.left, y1: baseY, x2: PAD.left + chartW, y2: baseY, stroke: '#ccc', 'stroke-width': '1' }));

  // X-axis labels (every 5 days)
  for (let d = 1; d <= dim; d += 5) {
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', xPos(d)); lbl.setAttribute('y', baseY + 14);
    lbl.setAttribute('text-anchor', 'middle'); lbl.setAttribute('font-size', '10'); lbl.setAttribute('fill', '#aaa');
    lbl.textContent = `${d}`;
    svg.appendChild(lbl);
  }

  container.innerHTML = '';
  container.appendChild(svg);
}
