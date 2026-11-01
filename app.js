import {DatasetStore, LAYERS, SERIES, SERIES_LABELS, SERIES_COLORS, DEPTH_COLORS,
        DIRECTION_COLORS, START_YEAR, END_YEAR, gridAt, cellValues} from './data.js';
import {tr, formatCoordinate, exposureLabel, confidenceLabel} from './i18n.js';
import {GridMap, exposureRgb} from './maps.js';
import {TimeSeriesChart, BarChart, escapeHtml, placeTooltip} from './charts.js';

const $ = id => document.getElementById(id);
const store = new DatasetStore();
const initial = readLocation();
const state = {
  year: initial.year, layer: initial.layer, lang: initial.lang, toeMode: initial.mode,
  families: [true, true, true], series: [true, true, true, true, true, true],
  selected: initial.selected, playing: false,
};
let dataset = null, loadTicket = 0, playbackTimer = null, toastTimer = null;
let view = {zoom: 1, centerLon: 0, centerLat: -1};
let legendLanguage = null, toeLegendKey = null;
const mapTooltip = $('mapTooltip');

const mapOptions = {
  getView: () => view,
  onSelect: selectCell,
  onHover: hoverCell,
  onViewChange: changeView,
};
const maps = [
  new GridMap($('exposureMap'), {...mapOptions, kind: 'exposure'}),
  ...LAYERS.map((layer, index) => new GridMap(
    $([ 'toeSurface', 'toeEpipelagic', 'toeMesopelagic' ][index]),
    {...mapOptions, kind: 'toe', layer},
  )),
];
const timeChart = new TimeSeriesChart($('timeseriesChart'), {onYearClick: year => changeYear(year)});
const barChart = new BarChart($('barChart'), {});

function preferredLanguage() {
  try {
    const lang = localStorage.getItem('compound-cids-language');
    return ['en', 'zh'].includes(lang) ? lang : 'en';
  } catch { return 'en'; }
}

function readLocation() {
  const params = new URLSearchParams(location.hash.slice(1));
  const requestedYear = Number(params.get('year'));
  let lang = params.has('lang') ? params.get('lang') : preferredLanguage();
  if (!['en', 'zh'].includes(lang)) lang = 'en';
  let selected = null;
  if (params.has('lon') && params.has('lat')) {
    try { selected = gridAt(Number(params.get('lon')), Number(params.get('lat'))); } catch {}
  }
  return {
    year: Number.isInteger(requestedYear) && requestedYear >= START_YEAR && requestedYear <= END_YEAR
      ? requestedYear : END_YEAR,
    layer: LAYERS.includes(params.get('depth')) ? params.get('depth') : 'epipelagic',
    mode: params.get('mode') === 'direction' ? 'direction' : 'year',
    lang, selected,
  };
}

function viewLocation({explicitLanguage = false} = {}) {
  const params = new URLSearchParams();
  if (state.year !== END_YEAR) params.set('year', String(state.year));
  if (state.layer !== 'epipelagic') params.set('depth', state.layer);
  if (state.toeMode !== 'year') params.set('mode', state.toeMode);
  if (state.lang !== 'en' || state.lang !== preferredLanguage() || explicitLanguage) {
    params.set('lang', state.lang);
  }
  if (state.selected) {
    params.set('lat', state.selected.lat.toFixed(1));
    params.set('lon', state.selected.lon.toFixed(1));
  }
  const fragment = params.toString();
  return location.origin + location.pathname + location.search + (fragment ? '#' + fragment : '');
}

function writeLocation() {
  history.replaceState(null, '', viewLocation());
}

function applyLanguage() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = state.lang === 'zh' ? '海洋复合状态 · CID 互动大屏' : 'Compound Ocean State · CIDs Explorer';
  document.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = tr(state.lang, node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(node => {
    const text = tr(state.lang, node.dataset.i18nAria);
    node.setAttribute('aria-label', text);
    node.title = text;
  });
  $('enLabel').classList.toggle('active-language', state.lang === 'en');
  $('zhLabel').classList.toggle('active-language', state.lang === 'zh');
  $('yearSelect').setAttribute('aria-label', tr(state.lang, 'selectedYear'));
  $('detailCard').setAttribute('aria-label', tr(state.lang, 'selectedLocation'));
  $('timeseriesChart').setAttribute('aria-label', tr(state.lang, 'statsTitle') + ', 1990–2025');
  $('barChart').setAttribute('aria-label', tr(state.lang, 'barTitle'));
  $('statusText').setAttribute('aria-live', 'polite');
}

function renderLegends() {
  if (legendLanguage !== state.lang) {
    const familyNames = ['single', 'double', 'triple'];
    let html = '<div class="family-legend">';
    familyNames.forEach((key, family) => {
      html += '<button class="family-toggle" type="button" data-family="' + family
        + '" aria-pressed="true"><span class="family-toggle-label"><span class="family-check">✓</span>'
        + escapeHtml(tr(state.lang, key)) + '</span><span class="family-gradient" aria-hidden="true">';
      [2, 3].forEach(level => {
        html += '<i style="background:rgb(' + exposureRgb(level, family).slice(0, 3).join(',') + ')"></i>';
      });
      html += '</span></button>';
    });
    html += '</div><div class="grade-labels">';
    ['medium', 'high'].forEach((key, index) => {
      html += '<span><i class="grade-dot" style="opacity:' + [.65, 1][index]
        + '"></i>' + escapeHtml(tr(state.lang, key)) + '</span>';
    });
    html += '</div>';
    $('exposureLegend').innerHTML = html;
    $('seriesLegend').innerHTML = SERIES.map((key, index) =>
      '<button class="series-button" type="button" data-series="' + index
      + '" aria-pressed="true" title="' + escapeHtml(tr(state.lang, 'indicatorNames')[index])
      + '" style="--series-color:' + SERIES_COLORS[index] + '"><span class="series-line"></span>'
      + SERIES_LABELS[index] + '</button>').join('');
    $('depthLegend').innerHTML = LAYERS.map((layer, index) =>
      '<span><i style="background:' + DEPTH_COLORS[index] + '"></i>'
      + escapeHtml(tr(state.lang, layer)) + '</span>').join('');
    legendLanguage = state.lang;
  }
  document.querySelectorAll('[data-family]').forEach(node => {
    const selected = state.families[Number(node.dataset.family)];
    node.setAttribute('aria-pressed', String(selected));
    node.querySelector('.family-check').textContent = selected ? '✓' : '';
  });
  document.querySelectorAll('[data-series]').forEach(node =>
    node.setAttribute('aria-pressed', String(state.series[Number(node.dataset.series)])));
  const key = state.lang + ':' + state.toeMode;
  if (toeLegendKey !== key) {
    if (state.toeMode === 'year') {
      $('toeLegend').innerHTML = '<div class="toe-gradient"></div><div class="toe-legend-labels">'
        + '<span>≤1990</span><span>' + escapeHtml(tr(state.lang, 'toeYear'))
        + '</span><span>2025</span></div>';
    } else {
      $('toeLegend').innerHTML = '<div class="direction-legend">' + DIRECTION_COLORS.slice(1)
        .map((color, index) => '<span title="' + escapeHtml(tr(state.lang, 'directions')[index + 1])
          + '"><i style="background:' + color + '"></i>'
          + tr(state.lang, 'directionShort')[index + 1] + '</span>').join('') + '</div>';
    }
    toeLegendKey = key;
  }
}

function renderControls() {
  $('headerYear').textContent = state.year;
  document.querySelectorAll('.current-year').forEach(node => { node.textContent = state.year; });
  $('yearSlider').value = state.year;
  $('yearSlider').setAttribute('aria-valuetext', String(state.year));
  $('yearSlider').style.setProperty('--range-progress',
    (state.year - START_YEAR) / (END_YEAR - START_YEAR) * 100 + '%');
  $('yearSelect').value = state.year;
  $('previousButton').disabled = state.year === START_YEAR;
  $('nextButton').disabled = state.year === END_YEAR;
  $('playButton').setAttribute('aria-pressed', String(state.playing));
  $('playButton').setAttribute('aria-label', tr(state.lang, state.playing ? 'pause' : 'play'));
  $('playButton').title = tr(state.lang, state.playing ? 'pause' : 'play');
  $('playButton').querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
  document.querySelectorAll('[data-layer]').forEach(node =>
    node.setAttribute('aria-pressed', String(node.dataset.layer === state.layer)));
  document.querySelectorAll('[data-mode]').forEach(node =>
    node.setAttribute('aria-pressed', String(node.dataset.mode === state.toeMode)));
  $('chartDepth').textContent = tr(state.lang, state.layer);
}

function render() {
  renderControls();
  if (!dataset) return;
  renderLegends();
  maps.forEach(map => map.update(state, dataset, store.coastline));
  timeChart.update(state, store.statistics);
  barChart.update(state, store.statistics);
  renderDetail();
  $('statusText').textContent = tr(state.lang, 'ready');
}

async function changeYear(input, {fromPlayback = false} = {}) {
  if (!fromPlayback) stopPlayback();
  const year = Number(input);
  if (!Number.isInteger(year) || year < START_YEAR || year > END_YEAR) return false;
  const ticket = ++loadTicket;
  if (dataset && year === state.year) {
    $('exposurePanel').setAttribute('aria-busy', 'false'); render(); return true;
  }
  $('statusText').textContent = tr(state.lang, 'loadingYear') + ' ' + year + '…';
  $('exposurePanel').setAttribute('aria-busy', 'true');
  try {
    const loaded = await store.year(year);
    if (ticket !== loadTicket) return false;
    dataset = loaded; state.year = year;
    render(); writeLocation();
    store.prefetch(year + 1); store.prefetch(year - 1);
    return true;
  } catch (error) {
    if (ticket !== loadTicket) return false;
    stopPlayback(); render();
    $('statusText').textContent = tr(state.lang, 'loadError');
    showToast(tr(state.lang, 'loadError'));
    console.error(error);
    return false;
  } finally {
    if (ticket === loadTicket) $('exposurePanel').setAttribute('aria-busy', 'false');
  }
}

function stopPlayback() {
  state.playing = false;
  clearTimeout(playbackTimer);
  renderControls();
}
async function playbackStep() {
  if (!state.playing) return;
  const next = state.year === END_YEAR ? START_YEAR : state.year + 1;
  const success = await changeYear(next, {fromPlayback: true});
  if (!state.playing || !success) return;
  if (state.year === END_YEAR) { stopPlayback(); return; }
  playbackTimer = setTimeout(playbackStep, 1000);
}

function changeView(next) {
  const zoom = Math.max(1, Math.min(12, next.zoom));
  const maxLon = Math.max(0, 180 - 180 / zoom);
  const maxLat = 90 - 73 / zoom;
  view = {
    zoom, centerLon: Math.max(-maxLon, Math.min(maxLon, next.centerLon)),
    centerLat: Math.max(-maxLat, Math.min(maxLat, next.centerLat)),
  };
  maps.forEach(map => map.draw());
}

function selectCell(point, layer = state.layer, moveView = false) {
  if (!dataset) return;
  state.selected = point; state.layer = layer;
  $('detailCard').hidden = false;
  mapTooltip.hidden = true;
  if (moveView) changeView({zoom: Math.max(2, view.zoom), centerLon: point.lon, centerLat: point.lat});
  render(); writeLocation();
}
function closeDetail() {
  state.selected = null;
  $('detailCard').hidden = true;
  maps.forEach(map => map.draw());
  $('mapCoordinate').textContent = '';
  writeLocation();
}

function renderDetail() {
  if (!state.selected || !dataset) return;
  const point = state.selected, value = cellValues(dataset, state.layer, point.index);
  const coord = formatCoordinate(point.lon, point.lat);
  $('mapCoordinate').textContent = coord;
  const direction = tr(state.lang, 'directions')[value.direction ?? 0];
  const toe = value.toe === null ? tr(state.lang, 'noToe') : value.toe;
  const type = value.exposure === 1 ? '—' : value.exposureType === null ? tr(state.lang, 'notAssigned')
    : tr(state.lang, 'families')[value.exposureType];
  let html = '<h3 class="detail-coordinate">' + coord + '</h3><p class="detail-subtitle">'
    + tr(state.lang, state.layer + 'Long') + ' · ' + tr(state.lang, 'selectedYear')
    + ' ' + state.year + '</p><div class="detail-major"><div><span class="detail-label">'
    + tr(state.lang, 'toeYear') + '</span><strong class="'
    + (value.toe === null ? 'detail-value' : 'detail-toe') + '" data-detail="toe">'
    + escapeHtml(toe) + '</strong></div><div><span class="detail-label">'
    + tr(state.lang, 'exposure') + '</span><strong class="detail-value" data-detail="exposure">'
    + exposureLabel(state.lang, value.exposure) + '</strong></div></div>'
    + '<div class="detail-direction" data-detail="direction">' + escapeHtml(direction) + '</div>'
    + '<div class="detail-secondary"><div><span class="detail-label">' + tr(state.lang, 'confidence')
    + '</span><span class="detail-value ' + (value.significance === 1 ? 'passed' : 'not-passed')
    + '" data-detail="confidence">' + confidenceLabel(state.lang, value.significance)
    + '</span></div><div><span class="detail-label">' + tr(state.lang, 'family')
    + '</span><span class="detail-value">' + escapeHtml(type) + '</span></div></div>'
    + '<h4 class="detail-table-title">' + tr(state.lang, 'threeLayers') + '</h4>'
    + '<table class="detail-table"><thead><tr><th scope="col">' + tr(state.lang, 'depth') + '</th>';
  LAYERS.forEach(layer => {
    html += '<th scope="col"' + (layer === state.layer ? ' class="active-depth"' : '') + '>'
      + tr(state.lang, layer) + '</th>';
  });
  html += '</tr></thead><tbody>';
  const allValues = LAYERS.map(layer => cellValues(dataset, layer, point.index));
  const rows = [
    ['toeYear', v => v.toe === null ? '—' : v.toe],
    ['direction', v => tr(state.lang, 'directionShort')[v.direction ?? 0]],
    ['confidence', v => confidenceLabel(state.lang, v.significance)],
    ['exposure', v => exposureLabel(state.lang, v.exposure)],
    ['family', v => v.exposure === 1 ? '—' : v.exposureType === null ? tr(state.lang, 'notAssigned')
      : tr(state.lang, 'families')[v.exposureType]],
  ];
  for (const [key, format] of rows) {
    html += '<tr><th scope="row">' + tr(state.lang, key) + '</th>';
    allValues.forEach((v, index) => {
      const tooltip = key === 'direction' ? tr(state.lang, 'directions')[v.direction ?? 0] : '';
      html += '<td' + (LAYERS[index] === state.layer ? ' class="active-depth"' : '')
        + (tooltip ? ' title="' + escapeHtml(tooltip) + '"' : '') + '>'
        + escapeHtml(format(v)) + '</td>';
    });
    html += '</tr>';
  }
  html += '</tbody></table><p class="detail-domain">'
    + tr(state.lang, store.domain[point.index] ? 'insideDomain' : 'outsideDomain')
    + '</p><p class="detail-footnote">' + tr(state.lang, 'gridCentre') + '</p>';
  $('detailContent').innerHTML = html;
}

function hoverCell(point) {
  if (!point || !dataset) {
    mapTooltip.hidden = true;
    if (!state.selected) $('mapCoordinate').textContent = '';
    return;
  }
  $('mapCoordinate').textContent = formatCoordinate(point.lon, point.lat);
  if (window.matchMedia('(pointer: coarse)').matches) return;
  const value = cellValues(dataset, point.layer, point.index);
  let html = '<div class="tooltip-title">' + formatCoordinate(point.lon, point.lat) + '</div>';
  html += '<div class="tooltip-row"><span>' + tr(state.lang, 'selectedYear') + '</span><strong>'
    + state.year + '</strong></div>';
  html += '<div class="tooltip-row"><span>' + tr(state.lang, 'toeYear') + '</span><strong>'
    + (value.toe ?? '—') + '</strong></div>';
  html += '<div class="tooltip-row"><span>' + tr(state.lang, 'exposure') + '</span><strong>'
    + exposureLabel(state.lang, value.exposure) + '</strong></div>';
  html += '<div class="tooltip-row"><span>' + tr(state.lang, 'confidence')
    + '</span><strong class="' + (value.significance === 1 ? 'passed' : 'not-passed') + '">'
    + (value.significance === 0 ? '<i class="confidence-dot"></i>' : '')
    + confidenceLabel(state.lang, value.significance) + '</strong></div>';
  html += '<div class="tooltip-direction">'
    + escapeHtml(tr(state.lang, 'directions')[value.direction ?? 0]) + '</div>';
  mapTooltip.innerHTML = html;
  placeTooltip(mapTooltip, point.clientX, point.clientY);
}

function showToast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

async function expandPanel(panel) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (panel.requestFullscreen) await panel.requestFullscreen();
    else panel.classList.toggle('expanded-fallback');
  } catch { panel.classList.toggle('expanded-fallback'); }
}

function closeChartExpansion() {
  document.querySelectorAll('.chart-expanded').forEach(panel => {
    panel.classList.remove('chart-expanded');
    panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); panel.removeAttribute('aria-label');
    const button = panel.querySelector('[data-expand]');
    button.setAttribute('aria-label', tr(state.lang, 'expand'));
    button.title = tr(state.lang, 'expand');
  });
  document.querySelectorAll('[data-chart-inert]').forEach(node => {
    node.inert = false; delete node.dataset.chartInert;
  });
  $('chartBackdrop').hidden = true;
  document.body.style.overflow = '';
  $('chartTooltip').hidden = true;
}

function toggleChartExpansion(panel) {
  const wasExpanded = panel.classList.contains('chart-expanded');
  closeChartExpansion();
  if (wasExpanded) return;
  panel.classList.add('chart-expanded');
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', tr(state.lang, panel.id === 'timeseriesPanel' ? 'statsTitle' : 'barTitle'));
  const button = panel.querySelector('[data-expand]');
  button.setAttribute('aria-label', tr(state.lang, 'restore')); button.title = tr(state.lang, 'restore');
  const siblings = [...document.querySelectorAll('.dashboard > section, .masthead, .timeline, .page-footer, .detail-card, .dataset-description')];
  for (const node of siblings) {
    if (node === panel) continue;
    node.inert = true; node.dataset.chartInert = '';
  }
  $('chartBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}

function bindControls() {
  for (let year = START_YEAR; year <= END_YEAR; year++) {
    const option = document.createElement('option'); option.value = year; option.textContent = year;
    $('yearSelect').append(option);
  }
  $('yearSlider').addEventListener('input', event => changeYear(event.target.value));
  $('yearSelect').addEventListener('change', event => changeYear(event.target.value));
  $('previousButton').addEventListener('click', () => changeYear(state.year - 1));
  $('nextButton').addEventListener('click', () => changeYear(state.year + 1));
  $('playButton').addEventListener('click', () => {
    if (state.playing) { stopPlayback(); return; }
    state.playing = true; renderControls(); playbackStep();
  });
  document.querySelectorAll('[data-layer]').forEach(button => button.addEventListener('click', () => {
    state.layer = button.dataset.layer; render(); writeLocation();
  }));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    state.toeMode = button.dataset.mode; render(); writeLocation();
  }));
  $('exposureLegend').addEventListener('click', event => {
    const button = event.target.closest('[data-family]'); if (!button) return;
    const index = Number(button.dataset.family);
    state.families[index] = !state.families[index]; render();
  });
  $('seriesLegend').addEventListener('click', event => {
    const button = event.target.closest('[data-series]'); if (!button) return;
    const index = Number(button.dataset.series);
    state.series[index] = !state.series[index]; render();
  });
  $('languageButton').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'zh' : 'en';
    try { localStorage.setItem('compound-cids-language', state.lang); } catch {}
    applyLanguage(); render(); writeLocation();
  });
  $('aboutButton').addEventListener('click', () => $('aboutDialog').showModal());
  $('locateButton').addEventListener('click', () => $('coordinateDialog').showModal());
  document.querySelectorAll('.close-dialog').forEach(button =>
    button.addEventListener('click', () => $(button.dataset.dialog).close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  }));
  $('coordinateForm').addEventListener('submit', event => {
    event.preventDefault();
    const lat = Number($('latitudeInput').value), lon = Number($('longitudeInput').value);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90
        || lon < -180 || lon > 360) {
      $('coordinateError').textContent = tr(state.lang, 'invalidCoordinates');
      $('coordinateError').hidden = false; return;
    }
    $('coordinateError').hidden = true;
    $('coordinateDialog').close(); selectCell(gridAt(lon, lat), state.layer, true);
  });
  $('zoomInButton').addEventListener('click', () => maps[0].zoom(1.45));
  $('zoomOutButton').addEventListener('click', () => maps[0].zoom(1 / 1.45));
  $('resetMapButton').addEventListener('click', () => changeView({zoom: 1, centerLon: 0, centerLat: -1}));
  $('closeDetail').addEventListener('click', closeDetail);
  $('fullscreenButton').addEventListener('click', () => expandPanel(document.documentElement));
  document.querySelectorAll('[data-expand]').forEach(button =>
    button.addEventListener('click', () => {
      toggleChartExpansion($(button.dataset.expand));
    }));
  $('chartBackdrop').addEventListener('click', closeChartExpansion);
  $('copyButton').addEventListener('click', async () => {
    const shareLocation = viewLocation({explicitLanguage: true});
    try { await navigator.clipboard.writeText(shareLocation); showToast(tr(state.lang, 'copied')); }
    catch { showToast(shareLocation); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (document.querySelector('.chart-expanded')) { closeChartExpansion(); return; }
      document.querySelectorAll('.expanded-fallback').forEach(node => node.classList.remove('expanded-fallback'));
      if (!$('aboutDialog').open && !$('coordinateDialog').open) closeDetail();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPlayback();
  });
  document.addEventListener('fullscreenchange', () => {
    const label = tr(state.lang, document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
    $('fullscreenButton').setAttribute('aria-label', label);
    $('fullscreenButton').title = label;
    document.querySelectorAll('[data-expand]').forEach(button => {
      const expanded = document.fullscreenElement === $(button.dataset.expand);
      button.setAttribute('aria-label', tr(state.lang, expanded ? 'exitFullscreen' : 'expand'));
      button.title = button.getAttribute('aria-label');
    });
    $('chartTooltip').hidden = true;
    maps.forEach(map => map.resize());
    timeChart.draw(); barChart.draw();
  });
  window.addEventListener('hashchange', async () => {
    const incoming = readLocation();
    state.layer = incoming.layer; state.toeMode = incoming.mode; state.lang = incoming.lang;
    state.selected = incoming.selected;
    $('detailCard').hidden = !incoming.selected;
    applyLanguage(); await changeYear(incoming.year);
  });
  $('retryButton').addEventListener('click', initialize);
}

async function initialize() {
  $('loadingOverlay').hidden = false;
  $('retryButton').hidden = true;
  $('loadingMessage').textContent = tr(state.lang, 'loading');
  try {
    await store.initialize();
    dataset = await store.year(state.year);
    $('citationText').textContent = store.manifest.citation;
    $('detailCard').hidden = !state.selected;
    render(); writeLocation();
    $('loadingOverlay').hidden = true;
    store.prefetch(state.year - 1); store.prefetch(state.year + 1);
  } catch (error) {
    console.error(error);
    $('loadingMessage').textContent = tr(state.lang, 'loadError');
    $('retryButton').hidden = false;
    $('statusText').textContent = tr(state.lang, 'loadError');
  }
}

bindControls();
applyLanguage();
renderControls();
initialize();
