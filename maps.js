import {EXPOSURE_COLORS, DIRECTION_COLORS, MISSING_TOE,
        exposureFamily, hexRgb, toeColor, gridAt} from './data.js';
import {tr} from './i18n.js';

const OCEAN = [247, 250, 252];

export function exposureRgb(level, family) {
  if (level < 1 || level > 3) return [0, 0, 0, 0];
  if (level === 1) return [...OCEAN, 255];
  if (family < 0) return [0, 0, 0, 0];
  const source = hexRgb(EXPOSURE_COLORS[family]);
  const alpha = [.30, .45, .90][level - 1];
  return source.map((v, k) => Math.round(v * alpha + OCEAN[k] * (1 - alpha))).concat(255);
}

export class GridMap {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.container.prepend(this.canvas);
    this.context = this.canvas.getContext('2d');
    this.raster = document.createElement('canvas');
    this.raster.width = 360;
    this.raster.height = 180;
    this.rasterContext = this.raster.getContext('2d');
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindEvents();
    this.resize();
  }
  get layer() {
    return this.options.kind === 'exposure' ? this.state?.layer : this.options.layer;
  }
  resize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    this.draw();
  }
  update(state, dataset, coastline) {
    this.state = state;
    this.dataset = dataset;
    this.coastline = coastline;
    const key = [dataset.year, this.layer, state.toeMode, state.families.join(',')].join(':');
    if (key !== this.rasterKey) {
      this.paintRaster();
      this.rasterKey = key;
    }
    const label = (this.options.kind === 'exposure' ? tr(state.lang, 'exposureTitle')
      : tr(state.lang, 'toeTitle')) + ', ' + tr(state.lang, this.layer + 'Long')
      + ', ' + dataset.year + '. ' + tr(state.lang, 'keyboardHint');
    this.canvas.setAttribute('aria-label', label);
    this.draw();
  }
  paintRaster() {
    const planes = this.dataset.layers[this.layer];
    const image = this.rasterContext.createImageData(360, 180);
    const data = image.data;
    for (let j = 0; j < 180; j++) {
      for (let i = 0; i < 360; i++) {
        const index = j * 360 + i;
        let color = null;
        if (this.options.kind === 'exposure') {
          const level = planes.exposure[index];
          const family = exposureFamily(planes.exposureType[index]);
          if (level !== 1 && family >= 0 && !this.state.families[family]) continue;
          color = exposureRgb(level, family);
        } else if (planes.toe[index] !== MISSING_TOE && planes.direction[index] > 0
                   && planes.direction[index] <= 9) {
          color = this.state.toeMode === 'year' ? toeColor(planes.toe[index])
            : hexRgb(DIRECTION_COLORS[planes.direction[index]]).concat(255);
        }
        if (!color) continue;
        const offset = ((179 - j) * 360 + (i + 180) % 360) * 4;
        data.set(color, offset);
      }
    }
    this.rasterContext.putImageData(image, 0, 0);
  }
  geometry() {
    const view = this.options.getView();
    const pad = this.options.kind === 'exposure' ? 14 : 4;
    const base = Math.min(Math.max(1, this.width - pad * 2) / 360,
                          Math.max(1, this.height - pad * 2) / 146);
    const scale = base * view.zoom;
    return {scale, originX: this.width / 2 - view.centerLon * scale,
            originY: this.height / 2 + view.centerLat * scale};
  }
  xy(lon, lat, geo) {
    return [geo.originX + lon * geo.scale, geo.originY - lat * geo.scale];
  }
  geographic(x, y) {
    const geo = this.geometry();
    const lon = (x - geo.originX) / geo.scale;
    const lat = (geo.originY - y) / geo.scale;
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
    return {lon, lat};
  }
  pathCoast(context, segment, geo) {
    context.beginPath();
    segment.points.forEach((point, index) => {
      const xy = this.xy(point[0], point[1], geo);
      if (index === 0) context.moveTo(...xy); else context.lineTo(...xy);
    });
    context.closePath();
  }
  draw() {
    if (!this.dataset || !this.width || !this.height) return;
    const ctx = this.context;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();
    const geo = this.geometry();
    ctx.fillStyle = '#f7fafc';
    ctx.fillRect(0, 0, this.width, this.height);

    // Draw land first: finite published coastal cells are not masked out.
    for (const segment of this.coastline.segments) {
      this.pathCoast(ctx, segment, geo);
      ctx.fillStyle = segment.water ? '#f7fafc' : '#d9dfe3';
      ctx.fill();
    }
    const topLeft = this.xy(-180, 90, geo);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.raster, topLeft[0], topLeft[1], 360 * geo.scale, 180 * geo.scale);

    ctx.strokeStyle = '#9aabb83b';
    ctx.lineWidth = .6;
    for (let lon = -180; lon <= 180; lon += 60) {
      const a = this.xy(lon, 90, geo), b = this.xy(lon, -90, geo);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = this.xy(-180, lat, geo), b = this.xy(180, lat, geo);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    // Coast lines provide geographic context without overwriting cell values.
    ctx.strokeStyle = '#82939e99';
    ctx.lineWidth = this.options.kind === 'exposure' ? .55 : .38;
    for (const segment of this.coastline.segments) {
      this.pathCoast(ctx, segment, geo); ctx.stroke();
    }
    if (this.options.kind !== 'exposure') this.drawConfidence(ctx, geo);
    else this.drawAxes(ctx, geo);
    if (this.state.selected) {
      const [x, y] = this.xy(this.state.selected.lon, this.state.selected.lat, geo);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#243b4b'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 10, y); ctx.lineTo(x - 6.5, y);
      ctx.moveTo(x + 6.5, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 6.5);
      ctx.moveTo(x, y + 6.5); ctx.lineTo(x, y + 10); ctx.stroke();
      ctx.fillStyle = '#243b4b'; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  drawConfidence(ctx, geo) {
    const planes = this.dataset.layers[this.layer];
    const zoom = this.options.getView().zoom;
    const stride = zoom < 2 ? 4 : zoom < 4 ? 2 : 1;
    ctx.fillStyle = '#15212ddd';
    for (let j = 0; j < 180; j += stride) {
      for (let i = 0; i < 360; i += stride) {
        const index = j * 360 + i;
        if (planes.significance[index] !== 0 || planes.toe[index] === MISSING_TOE) continue;
        const lon = i < 180 ? i + .5 : i - 359.5;
        const [x, y] = this.xy(lon, j - 89.5, geo);
        if (x < 0 || x > this.width || y < 0 || y > this.height) continue;
        ctx.beginPath(); ctx.arc(x, y, .65, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  drawAxes(ctx, geo) {
    if (this.width < 500) return;
    ctx.font = '11px Arial,sans-serif';
    ctx.fillStyle = '#657884'; ctx.textAlign = 'center';
    for (let lon = -120; lon <= 120; lon += 60) {
      const [x] = this.xy(lon, 0, geo);
      if (x < 40 || x > this.width - 30) continue;
      ctx.fillText(lon === 0 ? '0°' : Math.abs(lon) + '°' + (lon < 0 ? 'W' : 'E'),
                   x, this.height - 10);
    }
    ctx.textAlign = 'right';
    for (const lat of [-60, 0, 60]) {
      const [, y] = this.xy(0, lat, geo);
      if (y < 12 || y > this.height - 25) continue;
      ctx.fillText(lat === 0 ? '0°' : Math.abs(lat) + '°' + (lat < 0 ? 'S' : 'N'), this.width - 8, y - 4);
    }
  }
  pointerPosition(event) {
    const box = this.canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }
  zoom(factor, x = this.width / 2, y = this.height / 2) {
    const view = this.options.getView();
    const point = this.geographic(x, y) || {lon: view.centerLon, lat: view.centerLat};
    const zoom = Math.max(1, Math.min(12, view.zoom * factor));
    const scale = this.geometry().scale * zoom / view.zoom;
    this.options.onViewChange({
      zoom, centerLon: point.lon - (x - this.width / 2) / scale,
      centerLat: point.lat + (y - this.height / 2) / scale,
    });
  }
  bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.drag = {xy: this.pointerPosition(event), view: {...this.options.getView()}, moved: false};
      canvas.setPointerCapture(event.pointerId);
      this.options.onHover(null);
    });
    canvas.addEventListener('pointermove', event => {
      const [x, y] = this.pointerPosition(event);
      if (this.drag) {
        const dx = x - this.drag.xy[0], dy = y - this.drag.xy[1];
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          canvas.classList.add('dragging');
          const scale = this.geometry().scale;
          this.options.onViewChange({
            zoom: this.drag.view.zoom,
            centerLon: this.drag.view.centerLon - dx / scale,
            centerLat: this.drag.view.centerLat + dy / scale,
          });
        }
        return;
      }
      const coordinate = this.geographic(x, y);
      this.options.onHover(coordinate ? {
        ...gridAt(coordinate.lon, coordinate.lat), layer: this.layer,
        kind: this.options.kind, clientX: event.clientX, clientY: event.clientY,
      } : null);
    });
    canvas.addEventListener('pointerup', event => {
      if (!this.drag) return;
      const moved = this.drag.moved;
      this.drag = null; canvas.classList.remove('dragging');
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (moved) return;
      const coordinate = this.geographic(...this.pointerPosition(event));
      if (coordinate) this.options.onSelect(gridAt(coordinate.lon, coordinate.lat), this.layer);
    });
    canvas.addEventListener('pointercancel', () => { this.drag = null; canvas.classList.remove('dragging'); });
    canvas.addEventListener('pointerleave', () => this.options.onHover(null));
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.options.onHover(null);
      this.zoom(Math.exp(-event.deltaY * .0015), ...this.pointerPosition(event));
    }, {passive: false});
    canvas.addEventListener('keydown', event => {
      const view = this.options.getView();
      const next = {...view}, step = 12 / view.zoom;
      if (event.key === 'ArrowLeft') next.centerLon -= step;
      else if (event.key === 'ArrowRight') next.centerLon += step;
      else if (event.key === 'ArrowUp') next.centerLat += step;
      else if (event.key === 'ArrowDown') next.centerLat -= step;
      else if (event.key === '+' || event.key === '=') this.zoom(1.4);
      else if (event.key === '-') this.zoom(1 / 1.4);
      else if (event.key === 'Enter') this.options.onSelect(gridAt(view.centerLon, view.centerLat), this.layer);
      else if (event.key === 'Home') this.options.onViewChange({zoom: 1, centerLon: 0, centerLat: -1});
      else return;
      event.preventDefault();
      if (event.key.startsWith('Arrow')) this.options.onViewChange(next);
    });
  }
}
