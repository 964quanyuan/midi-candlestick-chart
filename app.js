const ACCENT_VELOCITY = 95;
const UPDATE_INTERVAL = 50;
const AUDIO_LOOKAHEAD = 0.35;
const PIECES = {
  CTNRS: { 
    ticker: 'CRTR: CTNRS', 
    file: 'pieces/catenaires.mid', 
    candleSize: 8,
    notesPerMeasure: 12,
    title: 'Two Thoughts About the Piano, No. 2: Caténaires - Elliott Carter', 
    silenceFirst: true },
  WTRFLL: { 
    ticker: 'CHPN: WTRFLL', 
    file: 'pieces/op10-1.mid', 
    candleSize: 6, 
    notesPerMeasure: 16,
    title: 'Étude Opus 10 No. 1, "Waterfall" - Frederic Chopin',
    silenceFirst: false },
  FFNT: {
    ticker: 'SCRBN: FFNT',
    file: 'pieces/op42-5.mid',
    candleSize: 8,
    notesPerMeasure: 24,
    title: 'Étude Opus 42 No. 5, "Affanato" - Alexander Scriabin',
    silenceFirst: false },
  DSRDR: {
    ticker: 'LGT: DSRDR',
    file: 'pieces/désordre.mid',
    candleSize: 6,
    notesPerMeasure: -1,
    title: 'Études, Book 1: No. 1, "Désordre" - György Ligeti',
    silenceFirst: false },
};
const LOW_REGISTER_PITCH = 36;
const FULL_VOLUME_PITCH = 72;
const LOW_REGISTER_BOOST_DB = 9;
const LOW_REGISTER_EXTRA_SUSTAIN = 1.8;
const SUSTAIN_MULTIPLIER = 0.5;
const VELOCITY_FLOOR = 0.25;
const VELOCITY_CURVE = 1.7;
const PAGE_TITLES = ['♭ar for ฿ar.', '𝄡ar for ฿ar.'];

const $ = (id) => document.getElementById(id);
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const chartFrame = document.querySelector('.chart-frame');
const controls = document.querySelector('.controls');
const initialSeed = Math.floor(Math.random() * 4294967295) + 1;
const state = { pieceKey: 'CTNRS', piece: PIECES.CTNRS, notes: [], chartNotes: [], candles: [], duration: 0, time: 0, seed: initialSeed, speed: 1, attack: 0.006, reverb: 0, panSensitivity: 1, hoverCandle: null, playing: false, paused: false, raf: 0, audio: null, audioBus: null, reverbBus: null, audioNoteIndex: 0, audioOrigin: 0, audioStart: 0, xStart: 0, xCount: 0, yZoom: 1, yCenter: null, dragY: null, dragX: null };

function randomizePageTitle() {
  state.pageTitle ??= PAGE_TITLES[Math.floor(Math.random() * PAGE_TITLES.length)];
  document.title = state.pageTitle;
  const heading = document.querySelector('h1');
  if (heading) heading.textContent = state.pageTitle;
}

randomizePageTitle();
document.addEventListener('DOMContentLoaded', randomizePageTitle);

function syncControlsHeight() {
  if (window.matchMedia('(min-width: 851px)').matches) controls.style.height = `${chartFrame.getBoundingClientRect().height}px`;
  else controls.style.height = '';
}

function redrawWhenFontsReady() {
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => draw());
    return;
  }
  draw();
}

function seededRandom(seed) {
  let value = (seed >>> 0) || 1;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; };
}

function readU16(data, offset) { return (data[offset] << 8) | data[offset + 1]; }
function readU32(data, offset) { return (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]; }
function variableLength(data, offset) { let value = 0; let byte; do { byte = data[offset++]; value = (value << 7) | (byte & 127); } while (byte & 128); return { value, offset }; }

function parseMidi(buffer) {
  const data = new Uint8Array(buffer), ticksPerBeat = readU16(data, 12), tracks = readU16(data, 10);
  const events = [];
  let offset = 14;
  for (let track = 0; track < tracks; track++) {
    if (String.fromCharCode(...data.slice(offset, offset + 4)) !== 'MTrk') break;
    const length = readU32(data, offset + 4); let cursor = offset + 8; const end = cursor + length; let ticks = 0; let running = 0;
    while (cursor < end) {
      const delta = variableLength(data, cursor); ticks += delta.value; cursor = delta.offset;
      let status = data[cursor++]; if (status < 128) { cursor--; status = running; } else running = status;
      if (status === 0xff) { const type = data[cursor++]; const size = variableLength(data, cursor); cursor = size.offset; if (type === 0x51 && size.value === 3) events.push({ type: 'tempo', ticks, tempo: (data[cursor] << 16) | (data[cursor + 1] << 8) | data[cursor + 2] }); cursor += size.value; }
      else if (status === 0xf0 || status === 0xf7) { const size = variableLength(data, cursor); cursor = size.offset + size.value; }
      else { const command = status & 0xf0; const first = data[cursor++]; if (command !== 0xc0 && command !== 0xd0) cursor++; if (command === 0x90 && data[cursor - 1] > 0) events.push({ type: 'note', ticks, pitch: first, velocity: data[cursor - 1] }); }
    }
    offset = end;
  }
  events.sort((a, b) => a.ticks - b.ticks);
  let tempo = 500000, lastTick = 0, currentTime = 0;
  const notes = [];
  for (const event of events) { currentTime += ((event.ticks - lastTick) * tempo) / (ticksPerBeat * 1000000); lastTick = event.ticks; if (event.type === 'tempo') tempo = event.tempo; else notes.push({ pitch: event.pitch, velocity: event.velocity, time: currentTime }); }
  return notes;
}

function applyPieceSpecificAudio(notes, piece) {
  if (piece.silenceFirst && notes.length > 0) notes[0].silent = true;
  return notes;
}

function getMeasureAndCandle(index, piece = state.piece) {
  if (piece.notesPerMeasure <= 0) return { measure: null, candleInMeasure: index + 1 };
  const noteOffset = index * piece.candleSize;
  const measure = Math.floor(noteOffset / piece.notesPerMeasure) + 1;
  const withinMeasure = noteOffset % piece.notesPerMeasure;
  const candleInMeasure = Math.floor(withinMeasure / piece.candleSize) + 1;
  return { measure, candleInMeasure };
}

function selectFormationNotes(notes, random = Math.random) {
  const formationNotes = [];
  let index = 0;

  while (index < notes.length) {
    const timestamp = notes[index].time;
    const simultaneousNotes = [notes[index]];
    index += 1;

    while (index < notes.length && notes[index].time === timestamp) {
      simultaneousNotes.push(notes[index]);
      index += 1;
    }

    const selectedIndex = Math.floor(random() * simultaneousNotes.length);
    formationNotes.push(simultaneousNotes[selectedIndex]);
  }

  return formationNotes;
}

function randomizeDelta(delta, accented, random) { const low = Math.min(-0.5, -0.25 * Math.abs(delta)); const high = Math.max(0.5, 0.25 * Math.abs(delta)); let result = delta + (random() * (high - low) + low); if (accented) { const accentLow = Math.min(0, 1.25 * delta); const accentHigh = Math.max(0, 1.25 * delta); result += random() * (accentHigh - accentLow) + accentLow; } return result; }
function buildCandles(notes, seed, candleSize = state.piece.candleSize) {
  const random = seededRandom(seed);
  notes = selectFormationNotes(notes, random);
  const candles = [];
  for (let index = 0; index + candleSize <= notes.length; index += candleSize) {
    const chunk = notes.slice(index, index + candleSize), path = [0], deltas = [];
    for (let i = 0; i < candleSize; i++) {
      const previousNote = i === 0 ? notes[index - 1] : chunk[i - 1];
      const delta = previousNote ? chunk[i].pitch - previousNote.pitch : 0;
      deltas.push(randomizeDelta(delta, chunk[i].velocity >= ACCENT_VELOCITY, random));
    }
    deltas[Math.floor(random() * candleSize)] = 0;
    for (const delta of deltas) path.push(path[path.length - 1] + delta);
    candles.push({ index: index / candleSize, notes: chunk, path, open: 0, high: Math.max(...path), low: Math.min(...path), close: path[path.length - 1] });
  }
  let previousClose = 0;
  for (const candle of candles) { const offset = previousClose - candle.path[0]; candle.path = candle.path.map(value => value + offset); candle.open = candle.path[0]; candle.high = Math.max(...candle.path); candle.low = Math.min(...candle.path); candle.close = candle.path[candle.path.length - 1]; previousClose = candle.close; }
  return candles;
}

function partialCandle(candle, time) {
  const times = candle.notes.map(note => note.time); if (time < times[0]) return { ...candle, path: [candle.open], high: candle.open, low: candle.open, close: candle.open };
  const nextNoteIndex = times.findIndex(value => value > time);
  const completedNoteCount = nextNoteIndex < 0 ? times.length : nextNoteIndex;
  const path = candle.path.slice(0, completedNoteCount + 1);
  if (completedNoteCount < times.length && completedNoteCount > 0) {
    const startTime = times[completedNoteCount - 1];
    const endTime = times[completedNoteCount];
    if (endTime > startTime) {
      const fraction = Math.max(0, Math.min(1, (time - startTime) / (endTime - startTime)));
      path.push(path[path.length - 1] + fraction * (candle.path[completedNoteCount + 1] - candle.path[completedNoteCount]));
    }
  }
  return { ...candle, path, high: Math.max(...path), low: Math.min(...path), close: path[path.length - 1] };
}

function resizeCanvas() { const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); redrawWhenFontsReady(); syncControlsHeight(); }
function draw() {
  const width = canvas.clientWidth, height = canvas.clientHeight; ctx.clearRect(0, 0, width, height); if (!state.candles.length) return;
  const visibleValues = state.candles.slice(Math.floor(state.xStart), Math.ceil(state.xStart + state.xCount)).flatMap(candle => [candle.low, candle.high]);
  const values = visibleValues.length ? visibleValues : state.candles.flatMap(candle => [candle.low, candle.high]);
  const dataMin = Math.min(...values), dataMax = Math.max(...values), dataRange = Math.max(2, (dataMax - dataMin) * 1.1), center = state.yCenter ?? (dataMin + dataMax) / 2, visibleRange = dataRange / state.yZoom, min = center - visibleRange / 2, max = center + visibleRange / 2, plotWidth = width - 58, slot = plotWidth / Math.max(1, state.xCount), y = value => height - 28 - ((value - min) / visibleRange) * (height - 52), x = index => 38 + (index - state.xStart + 0.5) * slot;
  const theme = getComputedStyle(document.body);
  ctx.strokeStyle = theme.getPropertyValue('--line').trim(); ctx.lineWidth = 1; ctx.font = '10px DM Mono, monospace'; ctx.fillStyle = theme.getPropertyValue('--muted').trim();
  for (let i = 0; i < 5; i++) { const value = min + (visibleRange * i / 4); const py = y(value); ctx.beginPath(); ctx.moveTo(38, py); ctx.lineTo(width - 10, py); ctx.stroke(); ctx.fillText(value.toFixed(1), 3, py - 4); }
  const nextNoteIndex = state.chartNotes.findIndex(note => note.time > state.time);
  const consumedNoteCount = nextNoteIndex < 0 ? state.chartNotes.length : nextNoteIndex;
  const activeIndex = Math.max(0, Math.min(state.candles.length - 1, Math.floor(consumedNoteCount / state.piece.candleSize)));
  const active = partialCandle(state.candles[activeIndex], state.time); const completed = state.time >= state.candles[activeIndex].notes.at(-1).time;
  const selectedIndex = state.hoverCandle !== null && state.hoverCandle <= activeIndex ? state.hoverCandle : activeIndex;
  const selectedCandle = selectedIndex === activeIndex && !completed ? active : state.candles[selectedIndex];
  const bullishColor = theme.getPropertyValue('--bullish').trim();
  const bearishColor = theme.getPropertyValue('--bearish').trim();
  const plotTop = 0;
  const plotBottom = height - 28;
  const plotLeft = 38;
  const plotRight = width - 10;
  const candleGlow = document.body.classList.contains('night');
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);
  ctx.clip();
  state.candles.forEach((candle, index) => { if (index > activeIndex || (index === activeIndex && !completed) || index < state.xStart - 1 || index > state.xStart + state.xCount + 1) return; const color = candle.close >= candle.open ? bullishColor : bearishColor; drawCandle(ctx, candle, index, color, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow); });
  if (!completed) drawCandle(ctx, active, activeIndex, active.close >= active.open ? bullishColor : bearishColor, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow);
  ctx.shadowBlur = 0;
  const playX = x(activeIndex);
  const currentPrice = active.close;
  const priceY = y(currentPrice);
  const gold = theme.getPropertyValue('--gold').trim();
  const white = '#f5f7ff';
  const crosshairColor = document.body.classList.contains('night') ? white : gold;
  const glowing = document.body.classList.contains('night');
  if (glowing) { ctx.shadowColor = crosshairColor; ctx.shadowBlur = 9; }
  ctx.strokeStyle = crosshairColor;
  ctx.setLineDash([2, 5]);

  // Only draw the vertical play line if it is within the active chart area (x >= 38)
  if (playX >= plotLeft && playX <= plotRight) {
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, height - 28);
    ctx.stroke();
  }

  // Draw horizontal price line across the grid area
  ctx.beginPath();
  ctx.moveTo(plotLeft, priceY);
  ctx.lineTo(plotRight, priceY);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.restore();

  const priceLabel = currentPrice.toFixed(2);
  const priceLabelWidth = Math.max(38, ctx.measureText(priceLabel).width + 10);
  const labelY = Math.max(9, Math.min(height - 9, priceY));
  ctx.save();
  if (glowing) { ctx.shadowColor = crosshairColor; ctx.shadowBlur = 9; }
  ctx.fillStyle = crosshairColor; ctx.fillRect(0, labelY - 9, priceLabelWidth, 18);
  ctx.fillStyle = theme.getPropertyValue('--paper').trim(); ctx.textAlign = 'left'; ctx.fillText(priceLabel, 5, labelY + 4); ctx.textAlign = 'left';
  ctx.restore();
  const selectedColor = selectedCandle.close >= selectedCandle.open ? bullishColor : bearishColor;
  updateReadout(selectedCandle, selectedColor); updateQuantitativeMetrics(activeIndex, active);
  const { measure, candleInMeasure } = getMeasureAndCandle(selectedIndex, state.piece);
  $('measureLabel').textContent = measure === null
    ? `MEASURE ? / CANDLE ${String(candleInMeasure).padStart(2, '0')}`
    : `MEASURE ${String(measure).padStart(2, '0')} / CANDLE ${String(candleInMeasure).padStart(2, '0')}`;
}
function drawCandle(ctx, candle, index, color, x, y, bodyWidth, glowing) { const px = x(index), open = y(candle.open), close = y(candle.close), high = y(candle.high), low = y(candle.low); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; if (glowing) { ctx.shadowColor = color; ctx.shadowBlur = 6; } else ctx.shadowBlur = 0; ctx.beginPath(); ctx.moveTo(px, high); ctx.lineTo(px, low); ctx.stroke(); ctx.globalAlpha = .84; ctx.fillRect(px - bodyWidth / 2, Math.min(open, close), bodyWidth, Math.max(2, Math.abs(close - open))); ctx.globalAlpha = 1; }
function updateReadout(candle, color) { const readout = $('openValue').closest('.ohlc-readout'); readout.style.color = color; readout.classList.add('candle-color'); $('openValue').textContent = candle.open.toFixed(2); $('highValue').textContent = candle.high.toFixed(2); $('lowValue').textContent = candle.low.toFixed(2); $('closeValue').textContent = candle.close.toFixed(2); }
function updateQuantitativeMetrics(activeIndex, activeCandle) {
  const start = Math.max(0, Math.ceil(state.xStart - 0.5));
  const viewportEnd = Math.min(state.candles.length, Math.floor(state.xStart + state.xCount - 0.5) + 1);
  const end = Math.min(viewportEnd, activeIndex + 1);
  const scopedCandles = state.candles.slice(start, end);
  const closes = scopedCandles.map((candle, index) => start + index === activeIndex ? activeCandle.close : candle.close);
  const closeChanges = closes.slice(1).map((close, index) => close - closes[index]);
  const averageChange = closeChanges.length ? closeChanges.reduce((sum, value) => sum + value, 0) / closeChanges.length : 0;
  const volatility = closeChanges.length ? Math.sqrt(closeChanges.reduce((sum, value) => sum + (value - averageChange) ** 2, 0) / closeChanges.length) : 0;
  const scopedRanges = scopedCandles.map((candle, index) => start + index === activeIndex ? activeCandle : candle);
  const highestHigh = scopedRanges.length ? Math.max(...scopedRanges.map(candle => candle.high)) : 0;
  const lowestLow = scopedRanges.length ? Math.min(...scopedRanges.map(candle => candle.low)) : 0;
  const pitchDeltaRange = highestHigh - lowestLow;
  const period = 14;
  const recentChanges = closeChanges.slice(-period);
  const gains = recentChanges.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = recentChanges.filter(value => value < 0).reduce((sum, value) => sum - value, 0);
  const rsi = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - (100 / (1 + gains / losses));
  $('volatilityValue').textContent = volatility.toFixed(2);
  $('pitchDeltaAverageValue').textContent = `${pitchDeltaRange.toFixed(2)}`;
  $('rsiValue').textContent = rsi.toFixed(2);
}
function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function updateTimeLabel() {
  $('timeline').value = state.time;
  $('timeLabel').textContent = `${formatTime(state.time)} / ${formatTime(state.duration)}`;
}

function updateHoveredCandle(event) {
  if (!state.candles.length || state.dragX || state.dragY) return;
  const rect = canvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  if (localX < 38 || localX > canvas.clientWidth - 10 || localY < 0 || localY > canvas.clientHeight - 28) {
    if (state.hoverCandle !== null) { state.hoverCandle = null; draw(); }
    return;
  }
  const index = Math.floor(state.xStart + ((localX - 38) / (canvas.clientWidth - 58)) * state.xCount);
  const nextNoteIndex = state.chartNotes.findIndex(note => note.time > state.time);
  const consumedNoteCount = nextNoteIndex < 0 ? state.chartNotes.length : nextNoteIndex;
  const activeIndex = Math.max(0, Math.min(state.candles.length - 1, Math.floor(consumedNoteCount / state.piece.candleSize)));
  const visibleStart = Math.floor(state.xStart);
  const visibleEnd = Math.min(state.candles.length - 1, Math.ceil(state.xStart + state.xCount));
  const isOnPaintedCandle = index >= visibleStart && index <= visibleEnd && index <= activeIndex;
  if (!isOnPaintedCandle) {
    if (state.hoverCandle !== null) { state.hoverCandle = null; draw(); }
    return;
  }
  const hovered = Math.max(0, Math.min(activeIndex, index));
  if (state.hoverCandle !== hovered) { state.hoverCandle = hovered; draw(); }
}

function zoomHorizontally(event) {
  if (!state.candles.length) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const plotWidth = rect.width - 58;
  const pointerRatio = Math.max(0, Math.min(1, (event.clientX - rect.left - 38) / plotWidth));
  const pointerIndex = state.xStart + pointerRatio * state.xCount;
  const zoomFactor = Math.exp(event.deltaY * 0.0015);
  const nextCount = Math.max(8, Math.min(state.candles.length, state.xCount * zoomFactor));
  state.xStart = Math.max(0, Math.min(state.candles.length - nextCount, pointerIndex - pointerRatio * nextCount));
  state.xCount = nextCount;
  draw();
}

function beginYAxisDrag(event) {
  const rect = canvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  if (localX > 38) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  state.dragY = { pointerId: event.pointerId, startY: event.clientY, startZoom: state.yZoom };
  canvas.classList.add('dragging-y');
}

function dragYAxis(event) {
  if (!state.dragY || event.pointerId !== state.dragY.pointerId) return;
  const zoom = state.dragY.startZoom * Math.exp((state.dragY.startY - event.clientY) * 0.008);
  state.yZoom = Math.max(0.35, Math.min(16, zoom));
  draw();
}

function endYAxisDrag(event) {
  if (!state.dragY || event.pointerId !== state.dragY.pointerId) return;
  canvas.releasePointerCapture(event.pointerId);
  state.dragY = null;
  canvas.classList.remove('dragging-y');
}

function beginChartDrag(event) {
  const rect = canvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  if (localX <= 38 || !state.candles.length) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  const scopedCandles = state.candles.slice(Math.floor(state.xStart), Math.ceil(state.xStart + state.xCount));
  const values = (scopedCandles.length ? scopedCandles : state.candles).flatMap(candle => [candle.low, candle.high]);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const dataRange = Math.max(2, (dataMax - dataMin) * 1.1);
  state.dragX = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startStart: state.xStart, startCenter: state.yCenter ?? (dataMin + dataMax) / 2, visibleRange: dataRange / state.yZoom };
  canvas.classList.add('dragging-x');
}

function dragChart(event) {
  if (!state.dragX || event.pointerId !== state.dragX.pointerId) return;
  const plotWidth = canvas.clientWidth - 58;
  const indexDelta = (state.dragX.startX - event.clientX) / plotWidth * state.xCount * state.panSensitivity;
  state.xStart = Math.max(0, Math.min(state.candles.length - state.xCount, state.dragX.startStart + indexDelta));
  const plotHeight = canvas.clientHeight - 52;
  state.yCenter = state.dragX.startCenter + (event.clientY - state.dragX.startY) / plotHeight * state.dragX.visibleRange * state.panSensitivity;
  draw();
}

function endChartDrag(event) {
  if (!state.dragX || event.pointerId !== state.dragX.pointerId) return;
  canvas.releasePointerCapture(event.pointerId);
  state.dragX = null;
  canvas.classList.remove('dragging-x');
}

function getLowRegisterFactor(pitch) {
  return Math.max(0, Math.min(1, (FULL_VOLUME_PITCH - pitch) / (FULL_VOLUME_PITCH - LOW_REGISTER_PITCH)));
}

function createPianoVoice(note, startTime, target = state) {
  if (note.silent) return;
  const context = target.audio;
  const frequency = 440 * Math.pow(2, (note.pitch - 69) / 12);
  const lowRegisterFactor = getLowRegisterFactor(note.pitch);
  const volumeMultiplier = Math.pow(10, (lowRegisterFactor * LOW_REGISTER_BOOST_DB) / 20);
  const sustain = (1.8 + lowRegisterFactor * LOW_REGISTER_EXTRA_SUSTAIN) * SUSTAIN_MULTIPLIER;
  const normalizedVelocity = Math.max(0, Math.min(1, note.velocity / 127));
  const velocityGain = VELOCITY_FLOOR + (1 - VELOCITY_FLOOR) * Math.pow(normalizedVelocity, VELOCITY_CURVE);
  const loudness = 0.047 * velocityGain * volumeMultiplier;
  const output = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(9000, frequency * 13), startTime);
  filter.Q.value = 0.7;
  output.gain.setValueAtTime(0.0001, startTime);
  output.gain.exponentialRampToValueAtTime(loudness, startTime + target.attack);
  output.gain.exponentialRampToValueAtTime(loudness * 0.32, startTime + sustain * 0.18);
  output.gain.exponentialRampToValueAtTime(0.0001, startTime + sustain);
  filter.connect(output).connect(target.audioBus || context.destination);

  const partials = [
    [1, 0.78, 'triangle'],
    [2, 0.16, 'sine'],
    [3, 0.045, 'sine'],
  ];
  for (const [multiple, level, type] of partials) {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency * multiple, startTime);
    oscillator.detune.setValueAtTime(multiple === 1 ? -2 : multiple * 1.5, startTime);
    partialGain.gain.value = level;
    oscillator.connect(partialGain).connect(filter);
    oscillator.start(startTime);
    oscillator.stop(startTime + sustain + 0.05);
  }

  const hammer = context.createBufferSource();
  const noise = context.createBuffer(1, context.sampleRate * 0.035, context.sampleRate);
  const noiseData = noise.getChannelData(0);
  for (let i = 0; i < noiseData.length; i += 1) noiseData[i] = (Math.random() * 2 - 1) * (1 - i / noiseData.length);
  hammer.buffer = noise;
  const hammerGain = context.createGain();
  hammerGain.gain.setValueAtTime(0.018 * velocityGain, startTime);
  hammerGain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.max(0.035, target.attack * 5));
  hammer.connect(hammerGain).connect(filter);
  hammer.start(startTime);
}

function scheduleAudioNotes(target = state) {
  if (!target.audio) return;
  const contextTime = target.audio.currentTime;
  const audioElapsed = Math.max(0, contextTime - target.audioStart);
  const scheduledUntil = Math.min(target.duration, target.audioOrigin + (audioElapsed + AUDIO_LOOKAHEAD) * target.speed);
  while (target.audioNoteIndex < target.notes.length && target.notes[target.audioNoteIndex].time <= scheduledUntil) {
    const note = target.notes[target.audioNoteIndex];
    const startTime = target.audioStart + (note.time - target.audioOrigin) / target.speed;
    if (startTime >= contextTime - 0.01) createPianoVoice(note, startTime, target);
    target.audioNoteIndex += 1;
  }
}

function setupAudio(target = state) {
  target.audio = new (window.AudioContext || window.webkitAudioContext)();
  const input = target.audio.createGain();
  const dry = target.audio.createGain();
  const convolver = target.audio.createConvolver();
  const wet = target.audio.createGain();
  const impulse = target.audio.createBuffer(2, target.audio.sampleRate * 2, target.audio.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / data.length, 2.4);
  }
  convolver.buffer = impulse;
  wet.gain.value = target.reverb;
  input.connect(dry).connect(target.audio.destination);
  input.connect(convolver).connect(wet).connect(target.audio.destination);
  target.audioBus = input;
  target.reverbBus = wet;
  target.audioOrigin = target.time;
  target.audioStart = target.audio.currentTime + 0.04;
  target.audioNoteIndex = target.notes.findIndex(note => note.time >= target.time);
  if (target.audioNoteIndex < 0) target.audioNoteIndex = target.notes.length;
  scheduleAudioNotes(target);
}

function resetChartPan() {
  state.xStart = 0;
  state.xCount = Math.max(8, Math.min(120, state.candles.length));
  state.yZoom = 1;
  state.yCenter = null;
}

function resetChartToFullView() {
  state.xStart = 0;
  state.xCount = Math.max(1, state.candles.length);
  state.yZoom = 1;
  state.yCenter = null;
}

function updateFooterNotes() {
  const noteCount = $('noteCount');
  if (!noteCount) return;
  const challengeScreen = $('challengeScreen');
  const inChallenge = challengeScreen && !challengeScreen.hidden;
  if (inChallenge) {
    if (!challengeState.piece) noteCount.textContent = 'SELECT A TICKER TO BEGIN';
    else if (challengeState.candles.length) noteCount.textContent = `AUDIOVISUAL SPECS: ${challengeState.notes.length} NOTES / ${challengeState.candles.length} CANDLES`;
    else noteCount.textContent = 'ADD MIDI BESIDE PIECES';
  } else if (!state.piece || !state.notes.length) {
    noteCount.textContent = state.piece ? 'ADD MIDI BESIDE PIECES' : 'Loading MIDI…';
  } else {
    noteCount.textContent = `AUDIOVISUAL SPECS: ${state.notes.length} NOTES / ${state.candles.length} CANDLES`;
  }
}

const challengeCanvas = $('challengeChart');
const challengeCtx = challengeCanvas ? challengeCanvas.getContext('2d') : null;
const workbenchSection = document.querySelector('section.workbench');
const challengeState = { pieceKey: '', piece: null, notes: [], chartNotes: [], candles: [], seed: 42, duration: 0, time: 0, playing: false, started: false, finished: false, raf: 0, lastFrame: null, xStart: 0, xCount: 8, yMin: -100, yMax: 100, hoverCandle: null, hoverPrice: null, dragX: null, dragY: null, dragOrder: null, dragBracket: null, pendingHitboxes: [], bracketHitboxes: [], speed: 1, attack: 0.006, reverb: 0, audio: null, audioBus: null, reverbBus: null, audioNoteIndex: 0, audioOrigin: 0, audioStart: 0, statusFlashTimer: null };
const tradingState = { mode: 'netting', positions: [], pendingOrders: [], workingOrders: [], nextId: 1, balance: 1000 };
const ROUND_TRIP_FEE_PER_UNIT = 1.5;
const DEFAULT_HOTKEYS = { limitBuy: 'shift+b', limitSell: 'shift+s', stopBuy: 'ctrl+b', stopSell: 'ctrl+s', marketBuy: 'alt+b', marketSell: 'alt+s' };
const hotkeys = { ...DEFAULT_HOTKEYS };
let listeningHotkeyButton = null;

function getChallengeActiveCandle() {
  if (!challengeState.candles.length) return null;
  const nextNoteIndex = challengeState.chartNotes.findIndex(note => note.time > challengeState.time);
  const consumedNoteCount = nextNoteIndex < 0 ? challengeState.chartNotes.length : nextNoteIndex;
  const activeIndex = Math.max(0, Math.min(challengeState.candles.length - 1, Math.floor(consumedNoteCount / challengeState.piece.candleSize)));
  const candle = challengeState.candles[activeIndex];
  const completed = challengeState.time >= candle.notes.at(-1).time;
  return { activeIndex, active: partialCandle(candle, challengeState.time), completed };
}

function getChallengeCurrentPrice() {
  const info = getChallengeActiveCandle();
  return info ? info.active.close : null;
}

function computePnl(side, entryPrice, exitPrice, qty) {
  return (side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * qty;
}

function closePosition(position, exitPrice, reason) {
  position.status = 'closed';
  position.exitPrice = exitPrice;
  position.exitTime = challengeState.time;
  position.exitReason = reason;
  position.realizedPnl = computePnl(position.side, position.entryPrice, exitPrice, position.qty);
  position.fee = position.qty * ROUND_TRIP_FEE_PER_UNIT;
  tradingState.balance += position.realizedPnl - position.fee;
}

function fillOrder(order, price) {
  const incomingSide = order.side === 'buy' ? 'long' : 'short';
  if (tradingState.mode === 'hedging') {
    tradingState.positions.push({ id: tradingState.nextId++, side: incomingSide, qty: order.qty, entryPrice: price, entryTime: challengeState.time, tp: order.tp, sl: order.sl, status: 'open', exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null });
    return;
  }
  const net = tradingState.positions.find(position => position.status === 'open' && position.netKey === 'net');
  if (!net) {
    tradingState.positions.push({ id: tradingState.nextId++, side: incomingSide, qty: order.qty, entryPrice: price, entryTime: challengeState.time, tp: order.tp, sl: order.sl, status: 'open', exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null, netKey: 'net' });
    return;
  }
  if (net.side === incomingSide) {
    const totalQty = net.qty + order.qty;
    net.entryPrice = (net.entryPrice * net.qty + price * order.qty) / totalQty;
    net.qty = totalQty;
    if (order.tp !== null) net.tp = order.tp;
    if (order.sl !== null) net.sl = order.sl;
    return;
  }
  if (order.qty === net.qty) {
    closePosition(net, price, 'flatten');
  } else if (order.qty < net.qty) {
    const pnl = computePnl(net.side, net.entryPrice, price, order.qty);
    const fee = order.qty * ROUND_TRIP_FEE_PER_UNIT;
    net.qty -= order.qty;
    tradingState.balance += pnl - fee;
    tradingState.positions.push({ id: tradingState.nextId++, side: net.side, qty: order.qty, entryPrice: net.entryPrice, entryTime: net.entryTime, tp: null, sl: null, status: 'closed', exitPrice: price, exitTime: challengeState.time, exitReason: 'reduce', realizedPnl: pnl, fee });
  } else {
    const pnl = computePnl(net.side, net.entryPrice, price, net.qty);
    const fee = net.qty * ROUND_TRIP_FEE_PER_UNIT;
    net.status = 'closed'; net.exitPrice = price; net.exitTime = challengeState.time; net.exitReason = 'flip'; net.realizedPnl = pnl; net.fee = fee;
    tradingState.balance += pnl - fee;
    tradingState.positions.push({ id: tradingState.nextId++, side: incomingSide, qty: order.qty - net.qty, entryPrice: price, entryTime: challengeState.time, tp: order.tp, sl: order.sl, status: 'open', exitPrice: null, exitTime: null, exitReason: null, realizedPnl: null, netKey: 'net' });
  }
}

function computeTotalUnrealizedPnl(currentPrice) {
  return tradingState.positions.filter(position => position.status === 'open').reduce((sum, position) => sum + computePnl(position.side, position.entryPrice, currentPrice, position.qty), 0);
}

function updateChallengeAccountMetrics(currentPrice) {
  const balanceValue = $('challengeBalanceValue');
  const unrealizedValue = $('challengeUnrealizedPnlValue');
  if (!balanceValue || !unrealizedValue) return;
  const unrealized = currentPrice === null ? 0 : computeTotalUnrealizedPnl(currentPrice);
  balanceValue.textContent = tradingState.balance.toFixed(2);
  unrealizedValue.textContent = `${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)}`;
  const theme = getComputedStyle(document.body);
  unrealizedValue.style.color = theme.getPropertyValue(unrealized >= 0 ? '--bullish' : '--bearish').trim();
}

function liquidateChallengeAccount(currentPrice) {
  tradingState.positions.filter(position => position.status === 'open').forEach(position => closePosition(position, currentPrice, 'liquidated'));
  tradingState.workingOrders = [];
  flashChallengeStatus('ACCOUNT LIQUIDATED');
}

function processChallengeTick() {
  const currentPrice = getChallengeCurrentPrice();
  if (currentPrice === null) return;
  const volatility = Number($('challengeVolatilityValue')?.textContent) || 0;
  const slippage = 0.1 * volatility;
  if (tradingState.pendingOrders.length) {
    tradingState.pendingOrders.splice(0).forEach(order => fillOrder(order, currentPrice));
  }
  if (tradingState.workingOrders.length) {
    const remaining = [];
    tradingState.workingOrders.forEach(order => {
      let triggered = false;
      let fillPrice = order.price;
      if (order.type === 'limit') {
        if (order.side === 'buy' && currentPrice <= order.price) triggered = true;
        if (order.side === 'sell' && currentPrice >= order.price) triggered = true;
      } else {
        if (order.side === 'buy' && currentPrice >= order.price) { triggered = true; fillPrice = order.price + slippage; }
        if (order.side === 'sell' && currentPrice <= order.price) { triggered = true; fillPrice = order.price - slippage; }
      }
      if (triggered) fillOrder(order, fillPrice);
      else remaining.push(order);
    });
    tradingState.workingOrders = remaining;
  }
  tradingState.positions.filter(position => position.status === 'open').forEach(position => {
    if (position.tp !== null) {
      const tpLevel = position.side === 'long' ? position.entryPrice + position.tp : position.entryPrice - position.tp;
      if ((position.side === 'long' && currentPrice >= tpLevel) || (position.side === 'short' && currentPrice <= tpLevel)) { closePosition(position, tpLevel, 'tp'); return; }
    }
    if (position.sl !== null) {
      const slLevel = position.side === 'long' ? position.entryPrice - position.sl : position.entryPrice + position.sl;
      if ((position.side === 'long' && currentPrice <= slLevel) || (position.side === 'short' && currentPrice >= slLevel)) {
        const filledSlPrice = position.side === 'long' ? slLevel - slippage : slLevel + slippage;
        closePosition(position, filledSlPrice, 'sl');
      }
    }
  });
  if (tradingState.balance + computeTotalUnrealizedPnl(currentPrice) <= 0 && tradingState.positions.some(position => position.status === 'open')) {
    liquidateChallengeAccount(currentPrice);
  }
  updateChallengeAccountMetrics(currentPrice);
  renderTradeLog();
}

function flashChallengeStatus(message) {
  const label = $('challengeStatusLabel');
  if (!label) return;
  label.textContent = message;
  clearTimeout(challengeState.statusFlashTimer);
  challengeState.statusFlashTimer = setTimeout(() => { if (challengeState.playing) label.textContent = 'PLAYING'; }, 1200);
}

function placeHotkeyOrder(type, side, price) {
  const currentPrice = getChallengeCurrentPrice();
  if (currentPrice === null) return;
  const qty = Math.max(1, Math.round(Number($('positionQuantity')?.value) || 1));
  const tpRaw = $('takeProfitInput')?.value;
  const slRaw = $('stopLossInput')?.value;
  const tp = tpRaw !== '' && tpRaw != null ? Math.abs(Number(tpRaw)) : null;
  const sl = slRaw !== '' && slRaw != null ? Math.abs(Number(slRaw)) : null;
  if (type === 'market') {
    tradingState.pendingOrders.push({ side, qty, tp, sl });
    flashChallengeStatus(`MARKET ${side.toUpperCase()} QUEUED`);
    return;
  }
  if (type === 'limit') {
    const invalid = side === 'buy' ? price > currentPrice : price < currentPrice;
    if (invalid) { flashChallengeStatus('INVALID LIMIT PRICE'); return; }
  } else {
    const invalid = side === 'buy' ? price < currentPrice : price > currentPrice;
    if (invalid) { flashChallengeStatus('INVALID STOP PRICE'); return; }
  }
  tradingState.workingOrders.push({ id: tradingState.nextId++, type, side, qty, price, tp, sl });
  renderTradeLog();
  flashChallengeStatus(`${type.toUpperCase()} ${side.toUpperCase()} @ ${price.toFixed(2)}`);
}

function comboFromEvent(event) {
  if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey) parts.push('meta');
  const keyName = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.toLowerCase();
  parts.push(keyName);
  return parts.join('+');
}

function formatHotkey(combo) {
  return combo.split('+').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('+');
}

function handleTradingHotkey(event) {
  if (event.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (!challengeState.playing || challengeState.hoverPrice === null) return;
  const combo = comboFromEvent(event);
  if (!combo) return;
  const action = Object.keys(hotkeys).find(key => hotkeys[key] === combo);
  if (!action) return;
  const actionMap = { limitBuy: ['limit', 'buy'], limitSell: ['limit', 'sell'], stopBuy: ['stop', 'buy'], stopSell: ['stop', 'sell'], marketBuy: ['market', 'buy'], marketSell: ['market', 'sell'] };
  const [type, side] = actionMap[action];
  event.preventDefault();
  placeHotkeyOrder(type, side, challengeState.hoverPrice);
}

function submitOrder(side) {
  if (!challengeState.playing) return;
  const qty = Math.max(1, Math.round(Number($('positionQuantity')?.value) || 1));
  const tpRaw = $('takeProfitInput')?.value;
  const slRaw = $('stopLossInput')?.value;
  tradingState.pendingOrders.push({ side, qty, tp: tpRaw !== '' && tpRaw != null ? Math.abs(Number(tpRaw)) : null, sl: slRaw !== '' && slRaw != null ? Math.abs(Number(slRaw)) : null });
}

function cancelWorkingOrder(id) {
  tradingState.workingOrders = tradingState.workingOrders.filter(order => order.id !== id);
  renderTradeLog();
}

function flattenPosition(id) {
  const position = tradingState.positions.find(item => item.id === id && item.status === 'open');
  if (!position) return;
  const price = getChallengeCurrentPrice();
  if (price === null) return;
  closePosition(position, price, 'flatten');
  renderTradeLog();
}

function renderTradeLog() {
  const tbody = $('tradeLogBody');
  if (!tbody) return;
  const currentPrice = getChallengeCurrentPrice();
  const workingRows = tradingState.workingOrders.map(order => {
    return `<tr><td>${order.id}</td><td class="${order.side === 'buy' ? 'long' : 'short'}">${order.type.toUpperCase()} ${order.side.toUpperCase()}</td><td>${order.qty}</td><td>${order.price.toFixed(2)}</td><td>${order.tp != null ? order.tp.toFixed(2) : '\u2014'}</td><td>${order.sl != null ? order.sl.toFixed(2) : '\u2014'}</td><td>\u2014</td><td>\u2014</td><td>\u2014</td><td>PENDING</td><td><button type="button" class="flatten-button" data-cancel-id="${order.id}">Cancel</button></td></tr>`;
  }).join('');
  const positionRows = tradingState.positions.map(position => {
    const pnl = position.status === 'open' ? computePnl(position.side, position.entryPrice, currentPrice ?? position.entryPrice, position.qty) : position.realizedPnl;
    const flattenCell = position.status === 'open' ? `<button type="button" class="flatten-button" data-flatten-id="${position.id}">Flatten</button>` : '';
    return `<tr><td>${position.id}</td><td class="${position.side}">${position.side === 'long' ? 'BUY' : 'SELL'}</td><td>${position.qty}</td><td>${position.entryPrice.toFixed(2)}</td><td>${position.tp != null ? position.tp.toFixed(2) : '\u2014'}</td><td>${position.sl != null ? position.sl.toFixed(2) : '\u2014'}</td><td>${position.exitPrice != null ? position.exitPrice.toFixed(2) : '\u2014'}</td><td class="${pnl >= 0 ? 'positive' : 'negative'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</td><td class="negative">${position.status === 'closed' ? `-${position.fee.toFixed(2)}` : '\u2014'}</td><td>${position.status === 'open' ? 'OPEN' : position.exitReason.toUpperCase()}</td><td>${flattenCell}</td></tr>`;
  }).join('');
  let totalRow = '';
  if (challengeState.finished) {
    const totalRealized = tradingState.positions.reduce((sum, position) => sum + (position.status === 'closed' ? position.realizedPnl : 0), 0);
    const totalFees = tradingState.positions.reduce((sum, position) => sum + (position.fee || 0), 0);
    const netTotal = totalRealized - totalFees;
    totalRow = `<tr class="trade-log-total"><td colspan="7">TOTAL</td><td class="${totalRealized >= 0 ? 'positive' : 'negative'}">${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(2)}</td><td class="negative">-${totalFees.toFixed(2)}</td><td>=</td><td class="${netTotal >= 0 ? 'positive' : 'negative'}">${netTotal.toFixed(2)}</td></tr>`;
  }
  tbody.innerHTML = workingRows + positionRows + totalRow;
}

function drawChallengeBracketLine(theme, y, plotLeft, plotRight, owner, field, level) {
  const bullishColor = theme.getPropertyValue('--bullish').trim();
  const bearishColor = theme.getPropertyValue('--bearish').trim();
  const paper = theme.getPropertyValue('--paper').trim();
  const color = field === 'tp' ? bullishColor : bearishColor;
  const py = y(level);
  challengeCtx.save();
  challengeCtx.setLineDash([1, 4]);
  challengeCtx.strokeStyle = color;
  challengeCtx.globalAlpha = 0.55;
  challengeCtx.lineWidth = 1;
  challengeCtx.beginPath();
  challengeCtx.moveTo(plotLeft, py);
  challengeCtx.lineTo(plotRight, py);
  challengeCtx.stroke();
  challengeCtx.setLineDash([]);
  challengeCtx.globalAlpha = 1;
  challengeCtx.restore();
  const label = `${field.toUpperCase()} ${level.toFixed(2)}`;
  challengeCtx.font = '10px DM Mono, monospace';
  const labelWidth = challengeCtx.measureText(label).width + 10;
  const labelX = plotRight - labelWidth;
  challengeCtx.save();
  challengeCtx.globalAlpha = 0.85;
  challengeCtx.fillStyle = color;
  challengeCtx.fillRect(labelX, py - 9, labelWidth, 18);
  challengeCtx.globalAlpha = 1;
  challengeCtx.fillStyle = paper;
  challengeCtx.textAlign = 'left';
  challengeCtx.fillText(label, labelX + 5, py + 4);
  challengeCtx.restore();
  challengeState.bracketHitboxes.push({ ownerKind: owner.kind, ownerId: owner.id, field, lineTop: py - 6, lineBottom: py + 6 });
}

function drawChallengePositionLabels(theme, y, plotLeft, plotRight, currentPrice) {
  const bullishColor = theme.getPropertyValue('--bullish').trim();
  const bearishColor = theme.getPropertyValue('--bearish').trim();
  const paper = theme.getPropertyValue('--paper').trim();
  challengeState.bracketHitboxes = [];
  tradingState.positions.filter(position => position.status === 'open').forEach(position => {
    const color = position.side === 'long' ? bullishColor : bearishColor;
    const py = y(position.entryPrice);
    challengeCtx.save();
    challengeCtx.setLineDash([4, 4]);
    challengeCtx.strokeStyle = color;
    challengeCtx.lineWidth = 1;
    challengeCtx.beginPath();
    challengeCtx.moveTo(plotLeft, py);
    challengeCtx.lineTo(plotRight, py);
    challengeCtx.stroke();
    challengeCtx.setLineDash([]);
    const pnl = computePnl(position.side, position.entryPrice, currentPrice, position.qty);
    const label = `${position.side === 'long' ? 'B' : 'S'}${position.qty} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
    challengeCtx.font = '10px DM Mono, monospace';
    const labelWidth = challengeCtx.measureText(label).width + 10;
    challengeCtx.fillStyle = color;
    challengeCtx.fillRect(plotRight - labelWidth, py - 9, labelWidth, 18);
    challengeCtx.fillStyle = paper;
    challengeCtx.textAlign = 'left';
    challengeCtx.fillText(label, plotRight - labelWidth + 5, py + 4);
    challengeCtx.restore();
    if (position.tp != null) {
      const tpLevel = position.side === 'long' ? position.entryPrice + position.tp : position.entryPrice - position.tp;
      drawChallengeBracketLine(theme, y, plotLeft, plotRight, { kind: 'position', id: position.id }, 'tp', tpLevel);
    }
    if (position.sl != null) {
      const slLevel = position.side === 'long' ? position.entryPrice - position.sl : position.entryPrice + position.sl;
      drawChallengeBracketLine(theme, y, plotLeft, plotRight, { kind: 'position', id: position.id }, 'sl', slLevel);
    }
  });
}

function drawChallengePendingOrders(theme, y, plotLeft, plotRight) {
  const bullishColor = theme.getPropertyValue('--bullish').trim();
  const bearishColor = theme.getPropertyValue('--bearish').trim();
  const paper = theme.getPropertyValue('--paper').trim();
  challengeState.pendingHitboxes = [];
  tradingState.workingOrders.forEach(order => {
    const color = order.side === 'buy' ? bullishColor : bearishColor;
    const py = y(order.price);
    challengeCtx.save();
    challengeCtx.setLineDash([2, 3]);
    challengeCtx.strokeStyle = color;
    challengeCtx.globalAlpha = 0.6;
    challengeCtx.lineWidth = 1;
    challengeCtx.beginPath();
    challengeCtx.moveTo(plotLeft, py);
    challengeCtx.lineTo(plotRight, py);
    challengeCtx.stroke();
    challengeCtx.setLineDash([]);
    challengeCtx.globalAlpha = 1;
    challengeCtx.restore();
    const label = `${order.type.toUpperCase()[0]} ${order.side === 'buy' ? 'B' : 'S'}${order.qty} @ ${order.price.toFixed(2)}`;
    challengeCtx.font = '10px DM Mono, monospace';
    const closeWidth = 14;
    const labelWidth = challengeCtx.measureText(label).width + 10 + closeWidth;
    const labelX = plotRight - labelWidth;
    challengeCtx.save();
    challengeCtx.globalAlpha = 0.85;
    challengeCtx.fillStyle = color;
    challengeCtx.fillRect(labelX, py - 9, labelWidth, 18);
    challengeCtx.globalAlpha = 1;
    challengeCtx.fillStyle = paper;
    challengeCtx.textAlign = 'left';
    challengeCtx.fillText(label, labelX + 5, py + 4);
    challengeCtx.textAlign = 'center';
    challengeCtx.fillText('\u00d7', labelX + labelWidth - closeWidth / 2, py + 4);
    challengeCtx.textAlign = 'left';
    challengeCtx.restore();
    challengeState.pendingHitboxes.push({
      id: order.id,
      lineTop: py - 6,
      lineBottom: py + 6,
      closeRect: { x: labelX + labelWidth - closeWidth, y: py - 9, w: closeWidth, h: 18 },
    });
    if (order.tp != null) {
      const tpLevel = order.side === 'buy' ? order.price + order.tp : order.price - order.tp;
      drawChallengeBracketLine(theme, y, plotLeft, plotRight, { kind: 'order', id: order.id }, 'tp', tpLevel);
    }
    if (order.sl != null) {
      const slLevel = order.side === 'buy' ? order.price - order.sl : order.price + order.sl;
      drawChallengeBracketLine(theme, y, plotLeft, plotRight, { kind: 'order', id: order.id }, 'sl', slLevel);
    }
  });
}

function setOrderButtonsEnabled(enabled) {
  ['buyButton', 'sellButton'].forEach(id => { const el = $(id); if (el) el.disabled = !enabled; });
}

function setBracketControlsEnabled(enabled) {
  ['positionQuantity', 'takeProfitInput', 'stopLossInput'].forEach(id => { const el = $(id); if (el) el.disabled = !enabled; });
  document.querySelectorAll('.mode-option, .quantity-shortcuts button').forEach(button => { button.disabled = !enabled; });
}

function setTradingControlsEnabled(enabled) {
  setOrderButtonsEnabled(enabled);
  setBracketControlsEnabled(enabled);
}

function setChallengeTickerPickerEnabled(enabled) {
  const select = $('challengePieceSelect');
  const button = $('challengePiecePickerButton');
  if (select) select.disabled = !enabled;
  if (button) button.disabled = !enabled;
}

function resetTradingState() {
  tradingState.mode = 'netting';
  tradingState.positions = [];
  tradingState.pendingOrders = [];
  tradingState.workingOrders = [];
  tradingState.nextId = 1;
  tradingState.balance = 1000;
  const qtyInput = $('positionQuantity'); if (qtyInput) qtyInput.value = 1;
  const tpInput = $('takeProfitInput'); if (tpInput) tpInput.value = '';
  const slInput = $('stopLossInput'); if (slInput) slInput.value = '';
  document.querySelectorAll('.mode-option').forEach(button => button.classList.toggle('active', button.dataset.mode === 'netting'));
  updateChallengeAccountMetrics(getChallengeCurrentPrice() ?? 0);
  renderTradeLog();
}

function updateChallengeButtonLabel() {
  const button = $('challengeButton');
  if (!button) return;
  const challengeScreen = $('challengeScreen');
  const inChallenge = challengeScreen && !challengeScreen.hidden;
  if (!inChallenge) { button.textContent = 'begin trading challenge'; button.disabled = false; return; }
  if (challengeState.started) { button.textContent = 'quit trading challenge'; button.disabled = false; return; }
  if (!challengeState.piece || !challengeState.candles.length) { button.textContent = 'select a ticker to begin'; button.disabled = true; return; }
  button.textContent = 'play'; button.disabled = false;
}

function finishChallengePlayback() {
  challengeState.playing = false;
  challengeState.finished = true;
  const finalPrice = getChallengeCurrentPrice();
  if (finalPrice !== null) tradingState.positions.filter(position => position.status === 'open').forEach(position => closePosition(position, finalPrice, 'session-end'));
  tradingState.workingOrders = [];
  challengeState.pendingHitboxes = [];
  renderTradeLog();
  setTradingControlsEnabled(false);
  updateChallengeButtonLabel();
  if ($('challengeStatusLabel')) $('challengeStatusLabel').textContent = 'FINISHED';
  drawChallengeChart();
}

function challengeAnimate(timestamp) {
  if (!challengeState.playing) return;
  if (challengeState.audio) {
    challengeState.time = Math.min(challengeState.duration, challengeState.audioOrigin + Math.max(0, challengeState.audio.currentTime - challengeState.audioStart) * challengeState.speed);
  }
  scheduleAudioNotes(challengeState);
  processChallengeTick();
  drawChallengeChart();
  if (challengeState.playing && challengeState.time < challengeState.duration) challengeState.raf = requestAnimationFrame(challengeAnimate);
  else finishChallengePlayback();
}

function startChallengePlayback() {
  if (!challengeState.piece || !challengeState.candles.length || challengeState.started) return;
  challengeState.started = true;
  challengeState.playing = true;
  challengeState.finished = false;
  challengeState.time = 0;
  if (!challengeState.audio) setupAudio(challengeState);
  challengeState.audio.resume().then(() => {
    challengeState.audioOrigin = challengeState.time;
    challengeState.audioStart = challengeState.audio.currentTime + 0.04;
    challengeState.audioNoteIndex = challengeState.notes.findIndex(note => note.time >= challengeState.time);
    if (challengeState.audioNoteIndex < 0) challengeState.audioNoteIndex = challengeState.notes.length;
    scheduleAudioNotes(challengeState);
  });
  setOrderButtonsEnabled(true);
  setChallengeTickerPickerEnabled(false);
  updateChallengeButtonLabel();
  if ($('challengeStatusLabel')) $('challengeStatusLabel').textContent = 'PLAYING';
  cancelAnimationFrame(challengeState.raf);
  challengeState.raf = requestAnimationFrame(challengeAnimate);
}

function closeChallengeAudio() {
  if (challengeState.audio) challengeState.audio.close();
  challengeState.audio = null;
  challengeState.audioBus = null;
  challengeState.reverbBus = null;
}

function resetChallengeMetricsDisplay() {
  ['challengeOpenValue', 'challengeHighValue', 'challengeLowValue', 'challengeCloseValue'].forEach(id => { const el = $(id); if (el) el.textContent = '0.00'; });
  const readout = $('challengeOpenValue')?.closest('.ohlc-readout');
  if (readout) { readout.style.color = ''; readout.classList.remove('candle-color'); }
  if ($('challengeVolatilityValue')) $('challengeVolatilityValue').textContent = '0.00';
  if ($('challengePitchDeltaAverageValue')) $('challengePitchDeltaAverageValue').textContent = '0.00';
  if ($('challengeRsiValue')) $('challengeRsiValue').textContent = '50.00';
  if ($('challengeMeasureLabel')) $('challengeMeasureLabel').textContent = 'MEASURE 01 / CANDLE 01';
}

function resetChallengeChartState() {
  cancelAnimationFrame(challengeState.raf);
  closeChallengeAudio();
  challengeState.pieceKey = '';
  challengeState.piece = null;
  challengeState.notes = [];
  challengeState.chartNotes = [];
  challengeState.candles = [];
  challengeState.duration = 0;
  challengeState.time = 0;
  challengeState.playing = false;
  challengeState.started = false;
  challengeState.finished = false;
  challengeState.lastFrame = null;
  challengeState.xStart = 0;
  challengeState.xCount = 8;
  challengeState.yMin = -100;
  challengeState.yMax = 100;
  challengeState.hoverCandle = null;
  challengeState.hoverPrice = null;
  challengeState.dragOrder = null;
  challengeState.dragBracket = null;
  challengeState.pendingHitboxes = [];
  challengeState.bracketHitboxes = [];
  resetTradingState();
  setTradingControlsEnabled(false);
  setChallengeTickerPickerEnabled(true);
  const pieceSelect = $('challengePieceSelect');
  if (pieceSelect) { pieceSelect.value = ''; syncChallengePieceSelector(); }
  if ($('challengePieceTitleLabel')) $('challengePieceTitleLabel').textContent = '';
  if ($('challengeStatusLabel')) $('challengeStatusLabel').textContent = 'SELECT';
  resetChallengeMetricsDisplay();
  updateChallengeButtonLabel();
  drawChallengeChart();
}

function resizeChallengeCanvas() {
  if (!challengeCanvas) return;
  const rect = challengeCanvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  challengeCanvas.width = rect.width * ratio;
  challengeCanvas.height = rect.height * ratio;
  challengeCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawChallengeChart();
}

function updateChallengeReadout(candle, color) {
  const openValue = $('challengeOpenValue');
  if (!openValue) return;
  const readout = openValue.closest('.ohlc-readout');
  readout.style.color = color;
  readout.classList.add('candle-color');
  openValue.textContent = candle.open.toFixed(2);
  $('challengeHighValue').textContent = candle.high.toFixed(2);
  $('challengeLowValue').textContent = candle.low.toFixed(2);
  $('challengeCloseValue').textContent = candle.close.toFixed(2);
}

function updateChallengeQuantitativeMetrics(activeIndex) {
  const start = Math.max(0, Math.ceil(challengeState.xStart - 0.5));
  const viewportEnd = Math.min(challengeState.candles.length, Math.floor(challengeState.xStart + challengeState.xCount - 0.5) + 1);
  const end = Math.min(viewportEnd, activeIndex + 1);
  const scopedCandles = challengeState.candles.slice(start, end);
  const closes = scopedCandles.map(candle => candle.close);
  const closeChanges = closes.slice(1).map((close, index) => close - closes[index]);
  const averageChange = closeChanges.length ? closeChanges.reduce((sum, value) => sum + value, 0) / closeChanges.length : 0;
  const volatility = closeChanges.length ? Math.sqrt(closeChanges.reduce((sum, value) => sum + (value - averageChange) ** 2, 0) / closeChanges.length) : 0;
  const highestHigh = scopedCandles.length ? Math.max(...scopedCandles.map(candle => candle.high)) : 0;
  const lowestLow = scopedCandles.length ? Math.min(...scopedCandles.map(candle => candle.low)) : 0;
  const pitchDeltaRange = highestHigh - lowestLow;
  const period = 14;
  const recentChanges = closeChanges.slice(-period);
  const gains = recentChanges.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = recentChanges.filter(value => value < 0).reduce((sum, value) => sum - value, 0);
  const rsi = losses === 0 ? (gains === 0 ? 50 : 100) : 100 - (100 / (1 + gains / losses));
  $('challengeVolatilityValue').textContent = volatility.toFixed(2);
  $('challengePitchDeltaAverageValue').textContent = `${pitchDeltaRange.toFixed(2)}`;
  $('challengeRsiValue').textContent = rsi.toFixed(2);
}

function drawChallengeChart() {
  if (!challengeCanvas) return;
  const width = challengeCanvas.clientWidth, height = challengeCanvas.clientHeight;
  challengeCtx.clearRect(0, 0, width, height);
  if (!challengeState.candles.length) { challengeState.pendingHitboxes = []; challengeState.bracketHitboxes = []; return; }
  const activeInfo = getChallengeActiveCandle();
  const activeIndex = activeInfo.activeIndex;
  const completed = activeInfo.completed;
  const active = activeInfo.active;
  const min = challengeState.yMin, visibleRange = challengeState.yMax - challengeState.yMin;
  const plotWidth = width - 58, slot = plotWidth / Math.max(1, challengeState.xCount);
  const y = value => height - 28 - ((value - min) / visibleRange) * (height - 52);
  const x = index => 38 + (index - challengeState.xStart + 0.5) * slot;
  const theme = getComputedStyle(document.body);
  challengeCtx.strokeStyle = theme.getPropertyValue('--line').trim();
  challengeCtx.lineWidth = 1;
  challengeCtx.font = '10px DM Mono, monospace';
  challengeCtx.fillStyle = theme.getPropertyValue('--muted').trim();
  for (let i = 0; i < 5; i++) {
    const value = min + (visibleRange * i / 4);
    const py = y(value);
    challengeCtx.beginPath(); challengeCtx.moveTo(38, py); challengeCtx.lineTo(width - 10, py); challengeCtx.stroke();
    challengeCtx.fillText(value.toFixed(1), 3, py - 4);
  }
  const bullishColor = theme.getPropertyValue('--bullish').trim();
  const bearishColor = theme.getPropertyValue('--bearish').trim();
  const plotLeft = 38, plotRight = width - 10, plotTop = 0, plotBottom = height - 28;
  const candleGlow = document.body.classList.contains('night');
  challengeCtx.save();
  challengeCtx.beginPath();
  challengeCtx.rect(plotLeft, plotTop, plotRight - plotLeft, plotBottom - plotTop);
  challengeCtx.clip();
  challengeState.candles.forEach((candle, index) => {
    if (index < challengeState.xStart - 1 || index > challengeState.xStart + challengeState.xCount + 1) return;
    if (index > activeIndex || (index === activeIndex && !completed)) return;
    const color = candle.close >= candle.open ? bullishColor : bearishColor;
    drawCandle(challengeCtx, candle, index, color, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow);
  });
  if (!completed) drawCandle(challengeCtx, active, activeIndex, active.close >= active.open ? bullishColor : bearishColor, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow);
  challengeCtx.restore();
  {
    const currentPrice = active.close;
    const gold = theme.getPropertyValue('--gold').trim();
    const white = '#f5f7ff';
    const crosshairColor = document.body.classList.contains('night') ? white : gold;
    const glowing = document.body.classList.contains('night');
    challengeCtx.save();
    if (glowing) { challengeCtx.shadowColor = crosshairColor; challengeCtx.shadowBlur = 9; }
    challengeCtx.strokeStyle = crosshairColor;
    challengeCtx.setLineDash([2, 5]);
    const playX = x(activeIndex);
    const priceY = y(currentPrice);
    if (playX >= plotLeft && playX <= plotRight) { challengeCtx.beginPath(); challengeCtx.moveTo(playX, 0); challengeCtx.lineTo(playX, plotBottom); challengeCtx.stroke(); }
    challengeCtx.beginPath(); challengeCtx.moveTo(plotLeft, priceY); challengeCtx.lineTo(plotRight, priceY); challengeCtx.stroke();
    challengeCtx.setLineDash([]);
    challengeCtx.restore();
    const priceLabel = currentPrice.toFixed(2);
    const priceLabelWidth = Math.max(38, challengeCtx.measureText(priceLabel).width + 10);
    const labelY = Math.max(9, Math.min(height - 9, priceY));
    challengeCtx.save();
    if (glowing) { challengeCtx.shadowColor = crosshairColor; challengeCtx.shadowBlur = 9; }
    challengeCtx.fillStyle = crosshairColor;
    challengeCtx.fillRect(0, labelY - 9, priceLabelWidth, 18);
    challengeCtx.fillStyle = theme.getPropertyValue('--paper').trim();
    challengeCtx.textAlign = 'left';
    challengeCtx.fillText(priceLabel, 5, labelY + 4);
    challengeCtx.restore();
    drawChallengePositionLabels(theme, y, plotLeft, plotRight, currentPrice);
    drawChallengePendingOrders(theme, y, plotLeft, plotRight);
  }
  const selectedIndex = challengeState.hoverCandle !== null && challengeState.hoverCandle <= activeIndex ? challengeState.hoverCandle : activeIndex;
  const selectedCandle = selectedIndex === activeIndex && !completed ? active : challengeState.candles[selectedIndex];
  const selectedColor = selectedCandle.close >= selectedCandle.open ? bullishColor : bearishColor;
  updateChallengeReadout(selectedCandle, selectedColor);
  updateChallengeQuantitativeMetrics(selectedIndex);
  const { measure, candleInMeasure } = getMeasureAndCandle(selectedIndex, challengeState.piece);
  $('challengeMeasureLabel').textContent = measure === null
    ? `MEASURE ? / CANDLE ${String(candleInMeasure).padStart(2, '0')}`
    : `MEASURE ${String(measure).padStart(2, '0')} / CANDLE ${String(candleInMeasure).padStart(2, '0')}`;
}

async function loadChallengePiece(pieceKey) {
  const piece = PIECES[pieceKey];
  cancelAnimationFrame(challengeState.raf);
  closeChallengeAudio();
  challengeState.pieceKey = pieceKey;
  challengeState.piece = piece;
  challengeState.notes = [];
  challengeState.chartNotes = [];
  challengeState.candles = [];
  challengeState.duration = 0;
  challengeState.time = 0;
  challengeState.playing = false;
  challengeState.started = false;
  challengeState.finished = false;
  challengeState.lastFrame = null;
  challengeState.xStart = 0;
  challengeState.xCount = 8;
  challengeState.yMin = -100;
  challengeState.yMax = 100;
  challengeState.hoverCandle = null;
  resetTradingState();
  setTradingControlsEnabled(false);
  $('challengeStatusLabel').textContent = 'LOADING';
  resetChallengeMetricsDisplay();
  try {
    const response = await fetch(piece.file);
    if (!response.ok) throw new Error(`Unable to load ${piece.file}`);
    challengeState.seed = Math.floor(Math.random() * 4294967295) + 1;
    challengeState.notes = applyPieceSpecificAudio(parseMidi(await response.arrayBuffer()), piece);
    challengeState.chartNotes = selectFormationNotes(challengeState.notes, seededRandom(challengeState.seed));
    challengeState.duration = challengeState.notes.at(-1)?.time || 0;
    challengeState.candles = buildCandles(challengeState.notes, challengeState.seed, piece.candleSize);
    challengeState.xCount = Math.max(8, Math.min(120, challengeState.candles.length));
    $('challengeStatusLabel').textContent = 'READY';
    if ($('challengePieceTitleLabel')) $('challengePieceTitleLabel').textContent = piece.title;
    setBracketControlsEnabled(true);
    resizeChallengeCanvas();
  } catch (error) {
    challengeState.candles = [];
    $('challengeStatusLabel').textContent = 'MIDI NOT FOUND';
    drawChallengeChart();
  }
  updateFooterNotes();
  updateChallengeButtonLabel();
}

function syncChallengePieceSelector() {
  const pieceSelect = $('challengePieceSelect');
  if (!pieceSelect) return;
  const placeholder = Array.from(pieceSelect.options).find(option => option.value === '');
  if (placeholder && pieceSelect.value !== '') pieceSelect.removeChild(placeholder);
  if (pieceSelect.value === '' && !placeholder) {
    const newPlaceholder = new Option('SELECT PIECE', '');
    pieceSelect.insertBefore(newPlaceholder, pieceSelect.firstChild);
  }
  const pickerButton = $('challengePiecePickerButton');
  const pickerMenu = $('challengePiecePickerMenu');
  if (pickerButton) pickerButton.textContent = pieceSelect.options[pieceSelect.selectedIndex]?.textContent || 'SELECT PIECE';
  if (pickerMenu && pieceSelect.value !== '') pickerMenu.querySelector('[data-piece=""]')?.remove();
}

function chooseChallengePiece(pieceKey) {
  const pieceSelect = $('challengePieceSelect');
  if (!pieceSelect || !pieceKey) return;
  pieceSelect.value = pieceKey;
  syncChallengePieceSelector();
  loadChallengePiece(pieceKey);
}

function getChallengePriceAtY(canvasHeight, localY) {
  const min = challengeState.yMin;
  const visibleRange = challengeState.yMax - challengeState.yMin;
  return min + (canvasHeight - 28 - localY) * visibleRange / (canvasHeight - 52);
}

function updateChallengeHoveredCandle(event) {
  if (!challengeState.candles.length || challengeState.dragX || challengeState.dragY) return;
  const rect = challengeCanvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  if (localX < 38 || localX > challengeCanvas.clientWidth - 10 || localY < 0 || localY > challengeCanvas.clientHeight - 28) {
    if (challengeState.hoverCandle !== null) { challengeState.hoverCandle = null; drawChallengeChart(); }
    challengeState.hoverPrice = null;
    return;
  }
  challengeState.hoverPrice = getChallengePriceAtY(challengeCanvas.clientHeight, localY);
  const index = Math.floor(challengeState.xStart + ((localX - 38) / (challengeCanvas.clientWidth - 58)) * challengeState.xCount);
  const activeIndex = getChallengeActiveCandle().activeIndex;
  const visibleStart = Math.floor(challengeState.xStart);
  const visibleEnd = Math.min(challengeState.candles.length - 1, Math.ceil(challengeState.xStart + challengeState.xCount));
  if (index < visibleStart || index > visibleEnd || index > activeIndex) {
    if (challengeState.hoverCandle !== null) { challengeState.hoverCandle = null; drawChallengeChart(); }
    return;
  }
  const hovered = Math.max(0, Math.min(activeIndex, index));
  if (challengeState.hoverCandle !== hovered) { challengeState.hoverCandle = hovered; drawChallengeChart(); }
}

function zoomChallengeHorizontally(event) {
  if (!challengeState.candles.length) return;
  event.preventDefault();
  const rect = challengeCanvas.getBoundingClientRect();
  const plotWidth = rect.width - 58;
  const pointerRatio = Math.max(0, Math.min(1, (event.clientX - rect.left - 38) / plotWidth));
  const pointerIndex = challengeState.xStart + pointerRatio * challengeState.xCount;
  const zoomFactor = Math.exp(event.deltaY * 0.0015);
  const nextCount = Math.max(8, Math.min(challengeState.candles.length, challengeState.xCount * zoomFactor));
  challengeState.xStart = Math.max(0, Math.min(challengeState.candles.length - nextCount, pointerIndex - pointerRatio * nextCount));
  challengeState.xCount = nextCount;
  drawChallengeChart();
}

function beginChallengeYAxisDrag(event) {
  const rect = challengeCanvas.getBoundingClientRect();
  if (event.clientX - rect.left > 38) return;
  event.preventDefault();
  challengeCanvas.setPointerCapture(event.pointerId);
  challengeState.dragY = { pointerId: event.pointerId, startY: event.clientY, startMin: challengeState.yMin, startMax: challengeState.yMax };
  challengeCanvas.classList.add('dragging-y');
}

function dragChallengeYAxis(event) {
  if (!challengeState.dragY || event.pointerId !== challengeState.dragY.pointerId) return;
  const center = (challengeState.dragY.startMin + challengeState.dragY.startMax) / 2;
  const startRange = challengeState.dragY.startMax - challengeState.dragY.startMin;
  const factor = Math.exp((challengeState.dragY.startY - event.clientY) * 0.008);
  const newRange = Math.max(5, Math.min(5000, startRange / factor));
  challengeState.yMin = center - newRange / 2;
  challengeState.yMax = center + newRange / 2;
  drawChallengeChart();
}

function endChallengeYAxisDrag(event) {
  if (!challengeState.dragY || event.pointerId !== challengeState.dragY.pointerId) return;
  challengeCanvas.releasePointerCapture(event.pointerId);
  challengeState.dragY = null;
  challengeCanvas.classList.remove('dragging-y');
}

function beginChallengeChartDrag(event) {
  const rect = challengeCanvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  if (localX <= 38 || !challengeState.candles.length) return;
  event.preventDefault();
  challengeCanvas.setPointerCapture(event.pointerId);
  challengeState.dragX = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startStart: challengeState.xStart, startMin: challengeState.yMin, startMax: challengeState.yMax };
  challengeCanvas.classList.add('dragging-x');
}

function dragChallengeChart(event) {
  if (!challengeState.dragX || event.pointerId !== challengeState.dragX.pointerId) return;
  const plotWidth = challengeCanvas.clientWidth - 58;
  const indexDelta = (challengeState.dragX.startX - event.clientX) / plotWidth * challengeState.xCount;
  challengeState.xStart = Math.max(0, Math.min(challengeState.candles.length - challengeState.xCount, challengeState.dragX.startStart + indexDelta));
  const plotHeight = challengeCanvas.clientHeight - 52;
  const range = challengeState.dragX.startMax - challengeState.dragX.startMin;
  const shift = (event.clientY - challengeState.dragX.startY) / plotHeight * range;
  challengeState.yMin = challengeState.dragX.startMin + shift;
  challengeState.yMax = challengeState.dragX.startMax + shift;
  drawChallengeChart();
}

function endChallengeChartDrag(event) {
  if (!challengeState.dragX || event.pointerId !== challengeState.dragX.pointerId) return;
  challengeCanvas.releasePointerCapture(event.pointerId);
  challengeState.dragX = null;
  challengeCanvas.classList.remove('dragging-x');
}

function beginChallengeOrderDrag(event, id) {
  event.preventDefault();
  challengeCanvas.setPointerCapture(event.pointerId);
  challengeState.dragOrder = { pointerId: event.pointerId, id };
  challengeCanvas.classList.add('dragging-y');
}

function dragChallengeOrder(event) {
  if (!challengeState.dragOrder || event.pointerId !== challengeState.dragOrder.pointerId) return;
  const order = tradingState.workingOrders.find(item => item.id === challengeState.dragOrder.id);
  if (!order) { challengeState.dragOrder = null; return; }
  const rect = challengeCanvas.getBoundingClientRect();
  const localY = event.clientY - rect.top;
  order.price = getChallengePriceAtY(challengeCanvas.clientHeight, localY);
  renderTradeLog();
  drawChallengeChart();
}

function endChallengeOrderDrag(event) {
  if (!challengeState.dragOrder || event.pointerId !== challengeState.dragOrder.pointerId) return;
  challengeCanvas.releasePointerCapture(event.pointerId);
  challengeState.dragOrder = null;
  challengeCanvas.classList.remove('dragging-y');
}

function beginChallengeBracketDrag(event, ownerKind, ownerId, field) {
  event.preventDefault();
  challengeCanvas.setPointerCapture(event.pointerId);
  challengeState.dragBracket = { pointerId: event.pointerId, ownerKind, ownerId, field };
  challengeCanvas.classList.add('dragging-y');
}

function dragChallengeBracket(event) {
  if (!challengeState.dragBracket || event.pointerId !== challengeState.dragBracket.pointerId) return;
  const { ownerKind, ownerId, field } = challengeState.dragBracket;
  const owner = ownerKind === 'position'
    ? tradingState.positions.find(item => item.id === ownerId && item.status === 'open')
    : tradingState.workingOrders.find(item => item.id === ownerId);
  if (!owner) { challengeState.dragBracket = null; return; }
  const currentPrice = getChallengeCurrentPrice();
  if (currentPrice === null) return;
  const rect = challengeCanvas.getBoundingClientRect();
  const localY = event.clientY - rect.top;
  let level = getChallengePriceAtY(challengeCanvas.clientHeight, localY);
  const referencePrice = ownerKind === 'position' ? owner.entryPrice : owner.price;
  const isLong = owner.side === 'long' || owner.side === 'buy';
  // TP behaves like a closing limit order, SL like a closing stop order: both are only
  // constrained by the current price, so either can legally sit on either side of entry.
  if (field === 'tp') level = isLong ? Math.max(level, currentPrice) : Math.min(level, currentPrice);
  else level = isLong ? Math.min(level, currentPrice) : Math.max(level, currentPrice);
  const offset = field === 'tp'
    ? (isLong ? level - referencePrice : referencePrice - level)
    : (isLong ? referencePrice - level : level - referencePrice);
  owner[field] = offset;
  renderTradeLog();
  drawChallengeChart();
}

function endChallengeBracketDrag(event) {
  if (!challengeState.dragBracket || event.pointerId !== challengeState.dragBracket.pointerId) return;
  challengeCanvas.releasePointerCapture(event.pointerId);
  challengeState.dragBracket = null;
  challengeCanvas.classList.remove('dragging-y');
}

async function loadPiece(pieceKey) {
  const piece = PIECES[pieceKey];
  state.playing = false;
  if (state.audio) state.audio.close();
  state.audio = null;
  state.audioBus = null;
  state.reverbBus = null;
  state.time = 0;
  state.pieceKey = pieceKey;
  state.piece = piece;
  state.notes = [];
  state.chartNotes = [];
  state.candles = [];
  resetChartPan();
  $('statusLabel').textContent = 'LOADING';

  try {
    const response = await fetch(piece.file);
    if (!response.ok) throw new Error(`Unable to load ${piece.file}`);
    state.notes = applyPieceSpecificAudio(parseMidi(await response.arrayBuffer()), piece);
    state.chartNotes = selectFormationNotes(state.notes, seededRandom(state.seed));
    state.duration = state.notes.at(-1).time;
    state.candles = buildCandles(state.notes, state.seed, piece.candleSize);
    resetChartPan();
    $('timeline').max = state.duration;
    state.time = 0;
    updateTimeLabel();
    $('statusLabel').textContent = 'READY';
    if ($('pieceTitleLabel')) $('pieceTitleLabel').textContent = piece.title;
    resizeCanvas();
    updateFooterNotes();
  } catch (error) {
    state.duration = 0;
    state.time = 0;
    $('timeline').max = 1;
    $('timeline').value = 0;
    $('timeLabel').textContent = '00:00 / 00:00';
    $('statusLabel').textContent = 'MIDI NOT FOUND';
    draw();
    updateFooterNotes();
  }
}

function animate() {
  if (state.playing) {
    if (state.audio) {
      state.time = Math.min(
        state.duration,
        state.audioOrigin + Math.max(0, state.audio.currentTime - state.audioStart) * state.speed,
      );
    }
    scheduleAudioNotes();
  }
  updateTimeLabel();
  $('statusLabel').textContent = state.time >= state.duration ? 'FINISHED' : state.playing ? 'PLAYING' : 'PAUSED';
  draw();
  if (state.playing && state.time < state.duration) state.raf = requestAnimationFrame(animate);
  else state.playing = false;
}

function play() {
  if (state.time >= state.duration) {
    state.time = 0;
    resetChartPan();
  }
  if (!state.audio) setupAudio();
  state.audio.resume().then(() => {
    state.audioOrigin = state.time;
    state.audioStart = state.audio.currentTime + 0.04;
    state.audioNoteIndex = state.notes.findIndex(note => note.time >= state.time);
    if (state.audioNoteIndex < 0) state.audioNoteIndex = state.notes.length;
    scheduleAudioNotes();
  });
  state.playing = true;
  state.paused = false;
  cancelAnimationFrame(state.raf);
  state.raf = requestAnimationFrame(animate);
}

function pause() {
  state.playing = false;
  state.paused = true;
  if (state.audio) state.audio.close();
  state.audio = null;
  state.audioBus = null;
  state.reverbBus = null;
  draw();
}

function restart() {
  state.playing = false;
  state.time = 0;
  resetChartPan();
  if (state.audio) state.audio.close();
  state.audio = null;
  state.audioBus = null;
  state.reverbBus = null;
  draw();
}

function finishPlayback() {
  state.playing = false;
  state.time = state.duration;
  resetChartToFullView();
  if (state.audio) state.audio.close();
  state.audio = null;
  state.audioBus = null;
  state.reverbBus = null;
  updateTimeLabel();
  $('statusLabel').textContent = 'FINISHED';
  draw();
}

function syncPieceSelector() {
  const pieceSelect = $('pieceSelect');
  if (!pieceSelect) return;
  const placeholder = Array.from(pieceSelect.options).find(option => option.value === '');
  if (placeholder && pieceSelect.value !== '') {
    pieceSelect.removeChild(placeholder);
  }
  if (pieceSelect.value === '' && !placeholder) {
    const newPlaceholder = new Option('SELECT PIECE', '');
    pieceSelect.insertBefore(newPlaceholder, pieceSelect.firstChild);
  }
  const pickerButton = $('piecePickerButton');
  const pickerMenu = $('piecePickerMenu');
  if (pickerButton) pickerButton.textContent = pieceSelect.options[pieceSelect.selectedIndex]?.textContent || 'SELECT PIECE';
  if (pickerMenu && pieceSelect.value !== '') pickerMenu.querySelector('[data-piece=""]')?.remove();
}

function choosePiece(pieceKey) {
  const pieceSelect = $('pieceSelect');
  if (!pieceSelect || !pieceKey) return;
  pieceSelect.value = pieceKey;
  syncPieceSelector();
  loadPiece(pieceKey);
}

function getDieFace(seed) {
  const remainder = ((seed % 6) + 6) % 6;
  return remainder || 6;
}

function updateDieFace(seed) {
  const die = $('seedDie');
  if (!die) return;
  const face = getDieFace(seed);
  const pipPositions = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };
  die.innerHTML = Array.from({ length: 9 }, (_, index) => `<span class="pip${pipPositions[face].includes(index + 1) ? ' visible' : ''}"></span>`).join('');
  die.setAttribute('aria-label', `Randomize seed; showing ${face}`);
}

function applySeed(seed) {
  state.seed = seed;
  $('seed').value = seed;
  updateDieFace(seed);
  if (!state.notes.length) return;
  state.chartNotes = selectFormationNotes(state.notes, seededRandom(state.seed));
  state.candles = buildCandles(state.notes, state.seed, state.piece.candleSize);
  restart();
}

$('seed').value = state.seed; $('attackValue').textContent = `${state.attack.toFixed(3)}s`; $('reverbValue').textContent = `${Math.round(state.reverb * 100)}%`; $('panSensitivityValue').textContent = `${state.panSensitivity.toFixed(2)}x`;
updateDieFace(state.seed);
$('playButton').onclick = play; $('pauseButton').onclick = pause; $('restartButton').onclick = restart; $('finishButton').onclick = finishPlayback; $('pieceSelect').onchange = event => { if (event.target.value) { syncPieceSelector(); } loadPiece(event.target.value); }; $('piecePickerButton').onclick = () => { const wrapper = $('piecePickerButton').closest('.piece-menu'); const isOpen = wrapper.classList.toggle('open'); $('piecePickerButton').setAttribute('aria-expanded', String(isOpen)); }; $('piecePickerMenu').onclick = event => { const option = event.target.closest('[data-piece]'); if (!option) return; choosePiece(option.dataset.piece); const wrapper = $('piecePickerButton').closest('.piece-menu'); wrapper.classList.remove('open'); $('piecePickerButton').setAttribute('aria-expanded', 'false'); }; document.addEventListener('click', event => { const wrapper = $('piecePickerButton').closest('.piece-menu'); if (!wrapper.contains(event.target)) { wrapper.classList.remove('open'); $('piecePickerButton').setAttribute('aria-expanded', 'false'); } }); $('timeline').oninput = event => { state.time = Number(event.target.value); if (state.audio) { state.audio.close(); state.audio = null; } if (state.playing) { setupAudio(); state.audio.resume(); } draw(); }; $('speed').oninput = event => { if (state.playing) pause(); state.speed = Number(event.target.value); $('speedValue').textContent = `${state.speed.toFixed(2)}x`; }; $('attack').oninput = event => { state.attack = Number(event.target.value); $('attackValue').textContent = `${state.attack.toFixed(3)}s`; }; $('reverb').oninput = event => { state.reverb = Number(event.target.value); $('reverbValue').textContent = `${Math.round(state.reverb * 100)}%`; if (state.reverbBus) state.reverbBus.gain.setTargetAtTime(state.reverb, state.audio.currentTime, 0.01); }; $('panSensitivity').oninput = event => { state.panSensitivity = Number(event.target.value); $('panSensitivityValue').textContent = `${state.panSensitivity.toFixed(2)}x`; }; $('seed').onchange = event => { const seed = Number.parseInt(event.target.value, 10); applySeed(Number.isNaN(seed) ? 1 : seed); };
$('seedDie').onclick = () => applySeed(Math.floor(Math.random() * 4294967295) + 1);
const piecePickerButton = $('piecePickerButton');
const piecePickerMenu = $('piecePickerMenu');
if (piecePickerButton && piecePickerMenu) {
  piecePickerButton.onclick = event => {
    event.stopPropagation();
    const wrapper = piecePickerButton.closest('.piece-menu');
    const isOpen = !wrapper.classList.contains('open');
    wrapper.classList.toggle('open', isOpen);
    piecePickerMenu.style.display = isOpen ? 'grid' : 'none';
    piecePickerButton.setAttribute('aria-expanded', String(isOpen));
  };
  piecePickerMenu.onclick = event => {
    event.stopPropagation();
    const option = event.target.closest('[data-piece]');
    if (!option || !option.dataset.piece) return;
    choosePiece(option.dataset.piece);
    const wrapper = piecePickerButton.closest('.piece-menu');
    wrapper.classList.remove('open');
    piecePickerMenu.style.display = 'none';
    piecePickerButton.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', event => {
    const wrapper = piecePickerButton.closest('.piece-menu');
    if (wrapper.contains(event.target)) return;
    wrapper.classList.remove('open');
    piecePickerMenu.style.display = 'none';
    piecePickerButton.setAttribute('aria-expanded', 'false');
  });
}
const themeToggle = $('themeToggle');
if (themeToggle) {
  themeToggle.onclick = () => { const night = document.body.classList.toggle('night'); themeToggle.textContent = night ? 'Day mode' : 'Night mode'; themeToggle.setAttribute('aria-pressed', String(night)); draw(); drawChallengeChart(); };
}
const challengePiecePickerButton = $('challengePiecePickerButton');
const challengePiecePickerMenu = $('challengePiecePickerMenu');
if (challengePiecePickerButton && challengePiecePickerMenu) {
  challengePiecePickerButton.onclick = event => {
    event.stopPropagation();
    const wrapper = challengePiecePickerButton.closest('.piece-menu');
    const isOpen = !wrapper.classList.contains('open');
    wrapper.classList.toggle('open', isOpen);
    challengePiecePickerMenu.style.display = isOpen ? 'grid' : 'none';
    challengePiecePickerButton.setAttribute('aria-expanded', String(isOpen));
  };
  challengePiecePickerMenu.onclick = event => {
    event.stopPropagation();
    const option = event.target.closest('[data-piece]');
    if (!option || !option.dataset.piece) return;
    chooseChallengePiece(option.dataset.piece);
    const wrapper = challengePiecePickerButton.closest('.piece-menu');
    wrapper.classList.remove('open');
    challengePiecePickerMenu.style.display = 'none';
    challengePiecePickerButton.setAttribute('aria-expanded', 'false');
  };
  document.addEventListener('click', event => {
    const wrapper = challengePiecePickerButton.closest('.piece-menu');
    if (wrapper.contains(event.target)) return;
    wrapper.classList.remove('open');
    challengePiecePickerMenu.style.display = 'none';
    challengePiecePickerButton.setAttribute('aria-expanded', 'false');
  });
}
if ($('challengePieceSelect')) {
  $('challengePieceSelect').onchange = event => { if (event.target.value) syncChallengePieceSelector(); loadChallengePiece(event.target.value); };
}
let challengeScrollHandler = null;

function smoothScrollTo(targetY, duration = 1100, onComplete) {
  const startY = window.scrollY;
  const distance = targetY - startY;
  const startTime = performance.now();
  const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function step(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    window.scrollTo(0, startY + distance * easeInOutCubic(progress));
    if (progress < 1) requestAnimationFrame(step);
    else if (onComplete) onComplete();
  }
  requestAnimationFrame(step);
}

function enableChallengeScrollGuard() {
  if (challengeScrollHandler) return;
  let ticking = false;
  challengeScrollHandler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const themeToggle = $('themeToggle');
      const challengeScreen = $('challengeScreen');
      if (!themeToggle || !challengeScreen || challengeScreen.hidden) return;
      const minScrollY = Math.max(0, window.scrollY + themeToggle.getBoundingClientRect().top - 112);
      if (window.scrollY < minScrollY) {
        window.scrollTo({ top: window.scrollY + challengeScreen.getBoundingClientRect().top, behavior: 'smooth' });
      }
    });
  };
  window.addEventListener('scroll', challengeScrollHandler, { passive: true });
}

function disableChallengeScrollGuard() {
  if (!challengeScrollHandler) return;
  window.removeEventListener('scroll', challengeScrollHandler);
  challengeScrollHandler = null;
}

const challengeButton = $('challengeButton');
if (challengeButton) {
  challengeButton.onclick = () => {
    const challengeScreen = $('challengeScreen');
    const inChallenge = challengeScreen && !challengeScreen.hidden;
    if (!inChallenge) {
      if (state.playing) pause();
      if (workbenchSection) workbenchSection.classList.add('frozen');
      challengeScreen.hidden = false;
      updateFooterNotes();
      resizeChallengeCanvas();
      updateChallengeButtonLabel();
      challengeScreen.scrollIntoView({ behavior: 'smooth', block: 'start' });
      enableChallengeScrollGuard();
      return;
    }
    if (challengeState.started) {
      if (workbenchSection) workbenchSection.classList.remove('frozen');
      disableChallengeScrollGuard();
      resetChallengeChartState();
      updateFooterNotes();
      resizeCanvas();
      const targetY = workbenchSection ? workbenchSection.getBoundingClientRect().top + window.scrollY : window.scrollY;
      smoothScrollTo(targetY, 1100, () => { challengeScreen.hidden = true; updateChallengeButtonLabel(); });
      return;
    }
    if (!challengeState.piece) return;
    startChallengePlayback();
  };
}
$('buyButton').onclick = () => submitOrder('buy');
$('sellButton').onclick = () => submitOrder('sell');
document.querySelectorAll('.mode-option').forEach(button => {
  button.onclick = () => {
    tradingState.mode = button.dataset.mode;
    document.querySelectorAll('.mode-option').forEach(other => other.classList.toggle('active', other === button));
  };
});
document.querySelectorAll('.quantity-shortcuts button').forEach(button => {
  button.onclick = () => { $('positionQuantity').value = button.dataset.qty; };
});
const tradeLogBody = $('tradeLogBody');
if (tradeLogBody) {
  tradeLogBody.addEventListener('pointerdown', event => {
    const flattenButton = event.target.closest('[data-flatten-id]');
    if (flattenButton) { flattenPosition(Number(flattenButton.dataset.flattenId)); return; }
    const cancelButton = event.target.closest('[data-cancel-id]');
    if (cancelButton) cancelWorkingOrder(Number(cancelButton.dataset.cancelId));
  });
}
document.querySelectorAll('.hotkey-input').forEach(button => {
  button.textContent = formatHotkey(hotkeys[button.dataset.hotkey]);
  button.onclick = () => {
    if (listeningHotkeyButton) { listeningHotkeyButton.classList.remove('listening'); listeningHotkeyButton.textContent = formatHotkey(hotkeys[listeningHotkeyButton.dataset.hotkey]); }
    listeningHotkeyButton = button;
    button.classList.add('listening');
    button.textContent = 'press a key\u2026';
  };
});
document.addEventListener('keydown', event => {
  if (listeningHotkeyButton) {
    const combo = comboFromEvent(event);
    if (!combo) return;
    event.preventDefault();
    hotkeys[listeningHotkeyButton.dataset.hotkey] = combo;
    listeningHotkeyButton.textContent = formatHotkey(combo);
    listeningHotkeyButton.classList.remove('listening');
    listeningHotkeyButton = null;
    return;
  }
  handleTradingHotkey(event);
});
if (challengeCanvas) {
  challengeCanvas.addEventListener('wheel', zoomChallengeHorizontally, { passive: false });
  challengeCanvas.addEventListener('pointerdown', event => {
    const rect = challengeCanvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const closeHit = challengeState.pendingHitboxes.find(box => localX >= box.closeRect.x && localX <= box.closeRect.x + box.closeRect.w && localY >= box.closeRect.y && localY <= box.closeRect.y + box.closeRect.h);
    if (closeHit) { cancelWorkingOrder(closeHit.id); return; }
    const lineHit = challengeState.pendingHitboxes.find(box => localX > 38 && localY >= box.lineTop && localY <= box.lineBottom);
    if (lineHit) { beginChallengeOrderDrag(event, lineHit.id); return; }
    const bracketHit = challengeState.bracketHitboxes.find(box => localX > 38 && localY >= box.lineTop && localY <= box.lineBottom);
    if (bracketHit) { beginChallengeBracketDrag(event, bracketHit.ownerKind, bracketHit.ownerId, bracketHit.field); return; }
    if (localX <= 38) beginChallengeYAxisDrag(event);
    else beginChallengeChartDrag(event);
  });
  challengeCanvas.addEventListener('pointermove', event => {
    if (challengeState.dragOrder) dragChallengeOrder(event);
    else if (challengeState.dragBracket) dragChallengeBracket(event);
    else if (challengeState.dragY) dragChallengeYAxis(event);
    else if (challengeState.dragX) dragChallengeChart(event);
    else updateChallengeHoveredCandle(event);
  });
  challengeCanvas.addEventListener('pointerup', event => {
    endChallengeOrderDrag(event);
    endChallengeBracketDrag(event);
    endChallengeYAxisDrag(event);
    endChallengeChartDrag(event);
  });
  challengeCanvas.addEventListener('pointercancel', event => {
    endChallengeOrderDrag(event);
    endChallengeBracketDrag(event);
    endChallengeYAxisDrag(event);
    endChallengeChartDrag(event);
  });
  challengeCanvas.addEventListener('pointerleave', () => {
    challengeState.hoverPrice = null;
    if (challengeState.hoverCandle !== null) { challengeState.hoverCandle = null; drawChallengeChart(); }
  });
}
canvas.addEventListener('wheel', zoomHorizontally, { passive: false });
canvas.addEventListener('pointerdown', event => {
  const rect = canvas.getBoundingClientRect();
  if (event.clientX - rect.left <= 38) beginYAxisDrag(event);
  else beginChartDrag(event);
});
canvas.addEventListener('pointermove', event => {
  if (state.dragY) dragYAxis(event);
  else if (state.dragX) dragChart(event);
  else updateHoveredCandle(event);
});
canvas.addEventListener('pointerup', event => {
  endYAxisDrag(event);
  endChartDrag(event);
});
canvas.addEventListener('pointercancel', event => {
  endYAxisDrag(event);
  endChartDrag(event);
});
canvas.addEventListener('pointerleave', () => {
  if (state.hoverCandle !== null) { state.hoverCandle = null; draw(); }
});
window.onresize = () => { resizeCanvas(); const challengeScreen = $('challengeScreen'); if (challengeScreen && !challengeScreen.hidden) resizeChallengeCanvas(); };
window.onkeydown = event => {
  if (event.target.tagName === 'INPUT') return;
  if (event.code === 'Space') { event.preventDefault(); state.playing ? pause() : play(); }
  if (event.key.toLowerCase() === 'r') restart();
  if (event.key === 'ArrowRight') { state.time = state.duration; draw(); }
};
