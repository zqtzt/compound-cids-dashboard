import {LAYERS, SERIES, SERIES_LABELS, SERIES_COLORS, DEPTH_COLORS,
        START_YEAR, END_YEAR} from './data.js';
import {tr} from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
export function escapeHtml(value) {
  const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
  return String(value).replace(/[&<>"']/g, character => entities[character]);
}
function element(tag, attributes = {}, text = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== null) node.textContent = text;
  return node;
}
function append(parent, tag, attributes, text) {
  const node = element(tag, attributes, text); parent.append(node); return node;
}
export function placeTooltip(node, clientX, clientY) {
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - box.width - 8, clientX + 15));
  const top = Math.max(8, Math.min(window.innerHeight - box.height - 8, clientY + 15));
  node.style.left = left + 'px'; node.style.top = top + 'px';
}

class BaseChart {
  constructor(container, options) {
    this.container = container; this.options = options;
    this.tooltip = document.getElementById('chartTooltip');
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(container);
    container.addEventListener('pointerleave', () => this.hideTooltip());
  }
  update(state, statistics) { this.state = state; this.statistics = statistics; this.draw(); }
  setup() {
    if (!this.state || this.container.clientWidth < 10) return false;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    this.width = width; this.height = height;
    const bottomMargin = this.options.rotateLabels && width < 400 ? 45 : 29;
    this.plot = {left: width < 400 ? 39 : 48, right: width - 14, top: 21, bottom: height - bottomMargin};
    this.container.replaceChildren();
    this.svg = element('svg', {class: 'chart-svg', viewBox: '0 0 ' + width + ' ' + height,
      role: 'img', 'aria-label': this.container.getAttribute('aria-label')});
    this.container.append(this.svg);
    const {left, right, top, bottom} = this.plot;
    for (let value = 0; value <= 100; value += 20) {
      const y = bottom - value / 100 * (bottom - top);
      append(this.svg, 'line', {x1: left, y1: y, x2: right, y2: y, class: 'tick-line'});
      append(this.svg, 'text', {x: left - 8, y: y + 3, 'text-anchor': 'end'}, value);
    }
    append(this.svg, 'line', {x1: left, y1: bottom, x2: right, y2: bottom, class: 'axis-line'});
    append(this.svg, 'text', {x: left, y: 10, class: 'axis-label'}, tr(this.state.lang, 'areaAxis'));
    return true;
  }
  hideTooltip() {
    this.tooltip.hidden = true;
    if (this.hoverLine) this.hoverLine.setAttribute('visibility', 'hidden');
  }
  empty() {
    append(this.svg, 'text', {x: this.width / 2, y: this.height / 2,
      'text-anchor': 'middle'}, tr(this.state.lang, 'noSeries'));
  }
}

export class TimeSeriesChart extends BaseChart {
  constructor(container, options) {
    super(container, options);
    container.tabIndex = 0;
    container.addEventListener('pointermove', event => this.hover(event));
    container.addEventListener('click', event => {
      const year = this.yearAt(event);
      if (year !== null) this.options.onYearClick(year);
    });
    container.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !this.state) return;
      event.preventDefault();
      const year = event.key === 'Home' ? START_YEAR : event.key === 'End' ? END_YEAR
        : Math.max(START_YEAR, Math.min(END_YEAR, this.state.year + (event.key === 'ArrowLeft' ? -1 : 1)));
      this.options.onYearClick(year);
    });
  }
  x(year) {
    return this.plot.left + (year - START_YEAR) / (END_YEAR - START_YEAR)
      * (this.plot.right - this.plot.left);
  }
  y(value) { return this.plot.bottom - value / 100 * (this.plot.bottom - this.plot.top); }
  draw() {
    if (!this.setup()) return;
    const ticks = this.width >= 550 ? [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]
      : [1990, 2000, 2010, 2020, 2025];
    for (const year of ticks) append(this.svg, 'text', {
      x: this.x(year), y: this.plot.bottom + 18,
      'text-anchor': year === START_YEAR ? 'start' : year === END_YEAR ? 'end' : 'middle',
    }, year);
    const clipId = 'time-plot-clip';
    const defs = append(this.svg, 'defs', {});
    append(append(defs, 'clipPath', {id: clipId}), 'rect', {
      x: this.plot.left - 2, y: this.plot.top - 2,
      width: this.plot.right - this.plot.left + 4, height: this.plot.bottom - this.plot.top + 4,
    });
    const lines = append(this.svg, 'g', {'clip-path': 'url(#' + clipId + ')'});
    let visible = 0;
    SERIES.forEach((key, index) => {
      if (!this.state.series[index]) return;
      visible++;
      const points = this.statistics.records.map(record => [
        this.x(record.year), this.y(record.layers[this.state.layer][key].percent),
      ]);
      const path = points.map((point, i) => (i ? 'L' : 'M') + point.join(',')).join(' ');
      append(lines, 'path', {d: path, class: 'series-path',
        stroke: SERIES_COLORS[index], 'stroke-width': index < 3 ? 1.8 : index === 5 ? 2.8 : 2.4});
    });
    if (!visible) this.empty();
    const x = this.x(this.state.year);
    append(this.svg, 'line', {x1: x, x2: x, y1: this.plot.top, y2: this.plot.bottom,
      class: 'current-line'});
    const labelX = Math.max(this.plot.left + 22, Math.min(this.plot.right - 20, x));
    append(this.svg, 'rect', {x: labelX - 20, y: this.plot.top - 5, width: 40, height: 15,
      rx: 3, fill: '#1d4248'});
    append(this.svg, 'text', {x: labelX, y: this.plot.top + 6,
      'text-anchor': 'middle', class: 'year-label'}, this.state.year);
    const record = this.statistics.records[this.state.year - START_YEAR];
    SERIES.forEach((key, index) => {
      if (!this.state.series[index]) return;
      append(this.svg, 'circle', {cx: x, cy: this.y(record.layers[this.state.layer][key].percent),
        r: 2.3, fill: SERIES_COLORS[index], stroke: '#0d2030', 'stroke-width': 1});
    });
    this.hoverLine = append(this.svg, 'line', {y1: this.plot.top, y2: this.plot.bottom,
      x1: x, x2: x, visibility: 'hidden', class: 'hover-line'});
  }
  yearAt(event) {
    if (!this.plot) return null;
    const box = this.container.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (x < this.plot.left - 3 || x > this.plot.right + 3
        || y < this.plot.top || y > this.plot.bottom + 10) return null;
    return Math.max(START_YEAR, Math.min(END_YEAR, Math.round(START_YEAR
      + (x - this.plot.left) / (this.plot.right - this.plot.left) * (END_YEAR - START_YEAR))));
  }
  hover(event) {
    const year = this.yearAt(event);
    if (year === null || !this.state) { this.hideTooltip(); return; }
    this.hoverLine.setAttribute('x1', this.x(year));
    this.hoverLine.setAttribute('x2', this.x(year));
    this.hoverLine.setAttribute('visibility', 'visible');
    const record = this.statistics.records[year - START_YEAR].layers[this.state.layer];
    let html = '<div class="tooltip-title">' + year + ' · '
      + escapeHtml(tr(this.state.lang, this.state.layer)) + '</div>';
    SERIES.forEach((key, index) => {
      if (!this.state.series[index]) return;
      html += '<div class="tooltip-row"><span><i class="tooltip-dot" style="background:'
        + SERIES_COLORS[index] + '"></i>' + SERIES_LABELS[index] + '</span><strong>'
        + record[key].percent.toFixed(2) + '%</strong></div>';
    });
    this.tooltip.innerHTML = html;
    placeTooltip(this.tooltip, event.clientX, event.clientY);
  }
}

export class BarChart extends BaseChart {
  constructor(container, options) {
    super(container, {...options, rotateLabels: true});
    container.addEventListener('pointermove', event => this.hover(event));
  }
  draw() {
    if (!this.setup()) return;
    this.active = SERIES.map((key, index) => ({key, index})).filter(item => this.state.series[item.index]);
    if (!this.active.length) { this.empty(); return; }
    this.groupWidth = (this.plot.right - this.plot.left) / this.active.length;
    const record = this.statistics.records[this.state.year - START_YEAR];
    const barWidth = Math.min(17, this.groupWidth * .19);
    this.active.forEach((item, groupIndex) => {
      const center = this.plot.left + this.groupWidth * (groupIndex + .5);
      const labelY = this.plot.bottom + (this.width < 400 ? 14 : 19);
      const labelX = center + (this.width < 400 ? 4 : 0);
      append(this.svg, 'text', {x: labelX, y: labelY,
        'text-anchor': this.width < 400 ? 'end' : 'middle',
        transform: this.width < 400 ? 'rotate(-35 ' + labelX + ' ' + labelY + ')' : '',
        style: 'font-size:10px'}, SERIES_LABELS[item.index].replaceAll(' ', ''));
      LAYERS.forEach((layer, depthIndex) => {
        const value = record.layers[layer][item.key].percent;
        const height = (this.plot.bottom - this.plot.top) * value / 100;
        const x = center + (depthIndex - 1) * (barWidth + 2) - barWidth / 2;
        append(this.svg, 'rect', {x, y: this.plot.bottom - height,
          width: barWidth, height, rx: 1, fill: DEPTH_COLORS[depthIndex],
          opacity: layer === this.state.layer ? 1 : .68});
      });
    });
  }
  hover(event) {
    if (!this.state || !this.active?.length || !this.plot) return;
    const box = this.container.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    if (x < this.plot.left || x > this.plot.right || y < this.plot.top || y > this.plot.bottom) {
      this.hideTooltip(); return;
    }
    const group = Math.min(this.active.length - 1, Math.floor((x - this.plot.left) / this.groupWidth));
    const item = this.active[group];
    const record = this.statistics.records[this.state.year - START_YEAR];
    let html = '<div class="tooltip-title">' + this.state.year + ' · '
      + SERIES_LABELS[item.index] + '</div>';
    LAYERS.forEach((layer, index) => {
      html += '<div class="tooltip-row"><span><i class="tooltip-dot" style="background:'
        + DEPTH_COLORS[index] + '"></i>' + escapeHtml(tr(this.state.lang, layer))
        + '</span><strong>' + record.layers[layer][item.key].percent.toFixed(2)
        + '%</strong></div>';
    });
    this.tooltip.innerHTML = html;
    placeTooltip(this.tooltip, event.clientX, event.clientY);
  }
}
