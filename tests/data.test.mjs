import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeYear, gridAt, wrapLongitude, cellValues, exposureFamily,
  toeColor, MISSING_TOE, START_YEAR, END_YEAR, LAYERS} from '../data.js';
import {exposureLabel, confidenceLabel, tr} from '../i18n.js';
import {exposureRgb} from '../maps.js';

const file = await readFile(new URL('../data/grid/2025.bin', import.meta.url));
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const dataset = decodeYear(buffer, 2025);

test('longitude wrapping and geographic lookup match the published grid', () => {
  assert.equal(wrapLongitude(320.5), -39.5);
  assert.deepEqual(gridAt(-39.5, 25.5), {
    i: 320, j: 115, index: 41720, lon: -39.5, lat: 25.5,
  });
  assert.deepEqual(gridAt(320.5, 25.5), gridAt(-39.5, 25.5));
  assert.equal(gridAt(-179.5, 0.5).i, 180);
  assert.equal(gridAt(179.5, 0.5).i, 179);
  assert.equal(gridAt(360, 0).i, 0);
  assert.equal(gridAt(0, -90).j, 0);
  assert.equal(gridAt(0, 90).j, 179);
  assert.throws(() => gridAt(0, 90.1), RangeError);
  assert.throws(() => gridAt(NaN, 0), RangeError);
});

test('real 2025 sample retains values at all three depths', () => {
  const index = gridAt(-39.5, 25.5).index;
  assert.deepEqual(cellValues(dataset, 'epipelagic', index), {
    toe: 1996, direction: 5, significance: 1, exposure: 3, exposureType: 4,
  });
  assert.equal(cellValues(dataset, 'surface', index).toe, 2005);
  assert.equal(cellValues(dataset, 'surface', index).direction, 8);
  assert.equal(cellValues(dataset, 'mesopelagic', index).toe, 1999);
});

test('corrupt, truncated and mismatched annual grids are rejected', () => {
  assert.throws(() => decodeYear(new ArrayBuffer(4)));
  assert.throws(() => decodeYear(buffer.slice(0, 100)));
  assert.throws(() => decodeYear(buffer, 2024));
  const corrupt = buffer.slice(0);
  new Uint8Array(corrupt)[0] = 0;
  assert.throws(() => decodeYear(corrupt, 2025));
  const outOfRange = buffer.slice(0);
  new DataView(outOfRange).setUint16(12, 1989, true);
  assert.throws(() => decodeYear(outOfRange));
  assert.equal(START_YEAR, 1990);
  assert.equal(END_YEAR, 2025);
});

test('missing values retain separate nulls and do not become zero or low grades', () => {
  const planes = dataset.layers.surface;
  const index = planes.toe.findIndex((toe, i) => toe === MISSING_TOE && planes.exposure[i] === 255);
  assert.ok(index >= 0);
  const values = cellValues(dataset, 'surface', index);
  assert.equal(values.toe, null);
  assert.equal(values.exposure, null);
  assert.equal(values.exposureType, null);
});

test('low exposure is hidden and remaining grades show meanings rather than codes', () => {
  assert.deepEqual([1, 2, 3].map(v => exposureLabel('en', v)),
    ['—', 'Medium exposure', 'High exposure']);
  assert.deepEqual([1, 2, 3].map(v => exposureLabel('zh', v)),
    ['—', '中等暴露', '高暴露']);
  assert.equal(exposureLabel('en', null), 'No mapped value');
  assert.equal(confidenceLabel('en', 0), 'Not significant');
  assert.equal(confidenceLabel('en', null), 'Not assessed');
  for (const family of [-1, 0, 1, 2]) assert.deepEqual(exposureRgb(1, family), [247, 250, 252, 255]);
  assert.notDeepEqual(exposureRgb(2, 0), exposureRgb(3, 0));
});

test('netCDF triple categories and exposure families have independent decoders', () => {
  assert.equal(tr('en', 'directions')[8], 'Warming + salinization + deoxygenation');
  assert.equal(tr('en', 'directions')[9], 'Warming + freshening + deoxygenation');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 255].map(exposureFamily), [0, 0, 0, 1, 1, 2, -1]);
});

test('pre-1990 ToE values are retained despite the evaluation slider range', async () => {
  const raw = await readFile(new URL('../data/grid/1990.bin', import.meta.url));
  const early = decodeYear(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), 1990);
  const values = [...early.layers.mesopelagic.toe].filter(v => v !== MISSING_TOE);
  assert.ok(values.some(v => v < 1990));
  assert.deepEqual(toeColor(1986), toeColor(1990));
});

test('area statistics use the chosen domain and preserve set containment for every year', async () => {
  const stats = JSON.parse(await readFile(new URL('../data/statistics.json', import.meta.url), 'utf8'));
  assert.equal(stats.records.length, 36);
  assert.deepEqual(stats.years, Array.from({length: 36}, (_, i) => 1990 + i));
  for (const record of stats.records) for (const layer of LAYERS) {
    const v = record.layers[layer];
    assert.ok(v.TSDO.percent <= Math.min(v.TS.percent, v.TDO.percent) + 1e-10);
    assert.ok(v.TS.percent <= Math.min(v.T.percent, v.S.percent) + 1e-10);
    assert.ok(v.TDO.percent <= Math.min(v.T.percent, v.DO.percent) + 1e-10);
    for (const item of Object.values(v)) {
      assert.ok(item.percent >= 0 && item.percent <= 100);
      assert.ok(Math.abs(item.area_km2 / stats.denominator_area_km2 * 100 - item.percent) < 1e-10);
    }
  }
  const sample = stats.records.at(-1).layers.epipelagic;
  const expected = {T: 47.4554, S: 14.0861, DO: 41.4535, TDO: 26.4514, TS: 12.8667, TSDO: 7.7459};
  for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs(sample[key].percent - value) < .0005);
});
