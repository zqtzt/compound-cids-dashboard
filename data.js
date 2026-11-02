export const LAYERS = ['surface', 'epipelagic', 'mesopelagic'];
export const SERIES = ['T', 'S', 'DO', 'TDO', 'TS', 'TSDO'];
export const SERIES_LABELS = ['T', 'S', 'DO', 'T + DO', 'T + S', 'T + S + DO'];
export const SERIES_COLORS = ['#b54d3c', '#386b9f', '#80649e', '#839547', '#2d8d96', '#24292e'];
export const DEPTH_COLORS = ['#b3cbdc', '#6c98b6', '#245d82'];
export const EXPOSURE_COLORS = ['#3c7c68', '#527f9c', '#b46745'];
export const DIRECTION_COLORS = [
  '#f7fafc', '#c96e4b', '#b39639', '#5692b6', '#81709b',
  '#c59b72', '#69a6a1', '#b97995', '#9aa55f', '#6c7ca3',
];
export const TOE_COLORS = ['#e5eef5', '#bfd4e4', '#8fb2cc', '#5487ad', '#245d82'];
const TOE_STOPS = TOE_COLORS.map(hexRgb);
export const MISSING_TOE = 65535;
export const MISSING_CATEGORY = 255;
export const START_YEAR = 1990;
export const END_YEAR = 2025;

export function wrapLongitude(lon) {
  return ((Number(lon) + 180) % 360 + 360) % 360 - 180;
}

export function gridAt(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError('Invalid geographic coordinate');
  }
  const east = ((lon % 360) + 360) % 360;
  const i = Math.min(359, Math.floor(east));
  const j = Math.max(0, Math.min(179, Math.floor(lat + 90)));
  return {i, j, index: j * 360 + i, lon: wrapLongitude(i + 0.5), lat: j - 89.5};
}

export function exposureFamily(type) {
  if (type >= 1 && type <= 3) return 0;
  if (type === 4 || type === 5) return 1;
  if (type === 6) return 2;
  return -1;
}

export function decodeYear(buffer, expectedYear) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) {
    throw new Error('Incomplete annual grid');
  }
  const header = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'CCID'
      || header.getUint16(4, true) !== 1
      || header.getUint16(6, true) !== 180
      || header.getUint16(8, true) !== 360
      || header.getUint16(10, true) !== 3
      || (expectedYear !== undefined && header.getUint16(12, true) !== expectedYear)
      || buffer.byteLength !== 16 + 64800 * 6 * 3) {
    throw new Error('Invalid annual grid header or length');
  }
  const year = header.getUint16(12, true);
  if (year < START_YEAR || year > END_YEAR) throw new Error('Unsupported evaluation year');
  const endian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  let offset = 16;
  const layers = {};
  for (const name of LAYERS) {
    let toe;
    if (endian) toe = new Uint16Array(buffer, offset, 64800);
    else {
      toe = new Uint16Array(64800);
      for (let k = 0; k < toe.length; k++) toe[k] = header.getUint16(offset + k * 2, true);
    }
    offset += 64800 * 2;
    const layer = {toe};
    for (const field of ['direction', 'significance', 'exposure', 'exposureType']) {
      layer[field] = new Uint8Array(buffer, offset, 64800);
      offset += 64800;
    }
    layers[name] = layer;
  }
  return {year, layers};
}

export function cellValues(dataset, layer, index) {
  const planes = dataset.layers[layer];
  return Object.fromEntries(Object.entries(planes).map(([key, values]) => [
    key, values[index] === (key === 'toe' ? MISSING_TOE : MISSING_CATEGORY)
      ? null : values[index],
  ]));
}

async function fetchResource(path, format) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error('Could not load ' + path + ' (HTTP ' + response.status + ')');
  return format === 'json' ? response.json() : response.arrayBuffer();
}

export class DatasetStore {
  constructor() {
    this.cache = new Map();
    this.pending = new Map();
  }
  async initialize() {
    const [manifest, statistics, coastline, domain] = await Promise.all([
      fetchResource('data/manifest.json', 'json'),
      fetchResource('data/statistics.json', 'json'),
      fetchResource('data/coastline.json', 'json'),
      fetchResource('data/domain.bin', 'buffer'),
    ]);
    if (manifest.start_year !== START_YEAR || manifest.end_year !== END_YEAR
        || domain.byteLength !== 64800 || statistics.records.length !== 36) {
      throw new Error('Inconsistent dataset manifest');
    }
    this.manifest = manifest;
    this.statistics = statistics;
    this.coastline = coastline;
    this.domain = new Uint8Array(domain);
    return this;
  }
  async year(year) {
    if (!Number.isInteger(year) || year < START_YEAR || year > END_YEAR) {
      throw new RangeError('Evaluation year must be 1990–2025');
    }
    if (this.cache.has(year)) {
      const data = this.cache.get(year);
      this.cache.delete(year);
      this.cache.set(year, data);
      return data;
    }
    if (this.pending.has(year)) return this.pending.get(year);
    const request = fetchResource('data/grid/' + year + '.bin', 'buffer')
      .then(buffer => {
        const data = decodeYear(buffer, year);
        this.cache.set(year, data);
        while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
        return data;
      }).finally(() => this.pending.delete(year));
    this.pending.set(year, request);
    return request;
  }
  prefetch(year) {
    if (year >= START_YEAR && year <= END_YEAR) this.year(year).catch(() => {});
  }
  annualRecord(year) {
    return this.statistics.records[year - START_YEAR];
  }
}

export function toeColor(year) {
  if (!Number.isFinite(year) || year === MISSING_TOE) return [0, 0, 0, 0];
  // Fixed scale: dates before the slider range use the <=1990 colour.
  const stops = TOE_STOPS;
  const t = Math.max(0, Math.min(1, (year - 1990) / 35)) * 4;
  const k = Math.min(3, Math.floor(t));
  const f = t - k;
  return stops[k].map((v, j) => Math.round(v * (1 - f) + stops[k + 1][j] * f)).concat(255);
}

export function hexRgb(hex) {
  return [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
}
