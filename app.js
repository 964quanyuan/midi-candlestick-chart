const ACCENT_VELOCITY = 95;
const UPDATE_INTERVAL = 50;
const AUDIO_LOOKAHEAD = 0.35;
const PIECES = {
  CTNRS: { 
    ticker: 'CRTR: CTNRS', 
    file: 'pieces/catenaires.mid', 
    candleSize: 6,
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
};
const LOW_REGISTER_PITCH = 36;
const FULL_VOLUME_PITCH = 72;
const LOW_REGISTER_BOOST_DB = 9;
const LOW_REGISTER_EXTRA_SUSTAIN = 1.8;
const SUSTAIN_MULTIPLIER = 0.5;
const VELOCITY_FLOOR = 0.25;
const VELOCITY_CURVE = 1.7;

const $ = (id) => document.getElementById(id);
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const chartFrame = document.querySelector('.chart-frame');
const controls = document.querySelector('.controls');
const initialSeed = Math.floor(Math.random() * 4294967295) + 1;
const state = { pieceKey: 'CTNRS', piece: PIECES.CTNRS, notes: [], chartNotes: [], candles: [], duration: 0, time: 0, seed: initialSeed, speed: 1, attack: 0.006, reverb: 0, panSensitivity: 1, hoverCandle: null, playing: false, paused: false, raf: 0, audio: null, audioBus: null, reverbBus: null, audioNoteIndex: 0, audioOrigin: 0, audioStart: 0, xStart: 0, xCount: 0, yZoom: 1, yCenter: null, dragY: null, dragX: null };

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
  state.candles.forEach((candle, index) => { if (index > activeIndex || (index === activeIndex && !completed) || index < state.xStart - 1 || index > state.xStart + state.xCount + 1) return; const color = candle.close >= candle.open ? bullishColor : bearishColor; drawCandle(candle, index, color, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow); });
  if (!completed) drawCandle(active, activeIndex, active.close >= active.open ? bullishColor : bearishColor, x, y, Math.min(18, Math.max(1, slot * 0.62)), candleGlow);
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
  $('measureLabel').textContent = `MEASURE ${String(measure).padStart(2, '0')} / CANDLE ${String(candleInMeasure).padStart(2, '0')}`;
}
function drawCandle(candle, index, color, x, y, bodyWidth, glowing) { const px = x(index), open = y(candle.open), close = y(candle.close), high = y(candle.high), low = y(candle.low); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; if (glowing) { ctx.shadowColor = color; ctx.shadowBlur = 6; } else ctx.shadowBlur = 0; ctx.beginPath(); ctx.moveTo(px, high); ctx.lineTo(px, low); ctx.stroke(); ctx.globalAlpha = .84; ctx.fillRect(px - bodyWidth / 2, Math.min(open, close), bodyWidth, Math.max(2, Math.abs(close - open))); ctx.globalAlpha = 1; }
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

function createPianoVoice(note, startTime) {
  if (note.silent) return;
  const context = state.audio;
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
  output.gain.exponentialRampToValueAtTime(loudness, startTime + state.attack);
  output.gain.exponentialRampToValueAtTime(loudness * 0.32, startTime + sustain * 0.18);
  output.gain.exponentialRampToValueAtTime(0.0001, startTime + sustain);
  filter.connect(output).connect(state.audioBus || context.destination);

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
  hammerGain.gain.exponentialRampToValueAtTime(0.0001, startTime + Math.max(0.035, state.attack * 5));
  hammer.connect(hammerGain).connect(filter);
  hammer.start(startTime);
}

function scheduleAudioNotes() {
  if (!state.audio) return;
  const contextTime = state.audio.currentTime;
  const audioElapsed = Math.max(0, contextTime - state.audioStart);
  const scheduledUntil = Math.min(state.duration, state.audioOrigin + (audioElapsed + AUDIO_LOOKAHEAD) * state.speed);
  while (state.audioNoteIndex < state.notes.length && state.notes[state.audioNoteIndex].time <= scheduledUntil) {
    const note = state.notes[state.audioNoteIndex];
    const startTime = state.audioStart + (note.time - state.audioOrigin) / state.speed;
    if (startTime >= contextTime - 0.01) createPianoVoice(note, startTime);
    state.audioNoteIndex += 1;
  }
}

function setupAudio() {
  state.audio = new (window.AudioContext || window.webkitAudioContext)();
  const input = state.audio.createGain();
  const dry = state.audio.createGain();
  const convolver = state.audio.createConvolver();
  const wet = state.audio.createGain();
  const impulse = state.audio.createBuffer(2, state.audio.sampleRate * 2, state.audio.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / data.length, 2.4);
  }
  convolver.buffer = impulse;
  wet.gain.value = state.reverb;
  input.connect(dry).connect(state.audio.destination);
  input.connect(convolver).connect(wet).connect(state.audio.destination);
  state.audioBus = input;
  state.reverbBus = wet;
  state.audioOrigin = state.time;
  state.audioStart = state.audio.currentTime + 0.04;
  state.audioNoteIndex = state.notes.findIndex(note => note.time >= state.time);
  if (state.audioNoteIndex < 0) state.audioNoteIndex = state.notes.length;
  scheduleAudioNotes();
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
    $('noteCount').textContent = `${state.notes.length} NOTES / ${state.candles.length} CANDLES`;
    $('statusLabel').textContent = 'READY';
    if ($('pieceTitleLabel')) $('pieceTitleLabel').textContent = piece.title;
    resizeCanvas();
  } catch (error) {
    state.duration = 0;
    state.time = 0;
    $('timeline').max = 1;
    $('timeline').value = 0;
    $('timeLabel').textContent = '00:00 / 00:00';
    $('statusLabel').textContent = 'MIDI NOT FOUND';
    $('noteCount').textContent = 'ADD MIDI BESIDE PIECES';
    draw();
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
$('playButton').onclick = play; $('pauseButton').onclick = pause; $('restartButton').onclick = restart; $('finishButton').onclick = finishPlayback; $('pieceSelect').onchange = event => { if (event.target.value) { syncPieceSelector(); } loadPiece(event.target.value); }; $('timeline').oninput = event => { state.time = Number(event.target.value); if (state.audio) state.audio.close(); state.audio = null; draw(); }; $('speed').oninput = event => { state.speed = Number(event.target.value); $('speedValue').textContent = `${state.speed.toFixed(2)}x`; }; $('attack').oninput = event => { state.attack = Number(event.target.value); $('attackValue').textContent = `${state.attack.toFixed(3)}s`; }; $('reverb').oninput = event => { state.reverb = Number(event.target.value); $('reverbValue').textContent = `${Math.round(state.reverb * 100)}%`; if (state.reverbBus) state.reverbBus.gain.setTargetAtTime(state.reverb, state.audio.currentTime, 0.01); }; $('panSensitivity').oninput = event => { state.panSensitivity = Number(event.target.value); $('panSensitivityValue').textContent = `${state.panSensitivity.toFixed(2)}x`; }; $('seed').onchange = event => { const seed = Number.parseInt(event.target.value, 10); applySeed(Number.isNaN(seed) ? 1 : seed); };
$('seedDie').onclick = () => applySeed(Math.floor(Math.random() * 4294967295) + 1);
const themeToggle = $('themeToggle');
if (themeToggle) {
  themeToggle.onclick = () => { const night = document.body.classList.toggle('night'); themeToggle.textContent = night ? 'Day mode' : 'Night mode'; themeToggle.setAttribute('aria-pressed', String(night)); draw(); };
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
window.onresize = resizeCanvas;
window.onkeydown = event => {
  if (event.target.tagName === 'INPUT') return;
  if (event.code === 'Space') { event.preventDefault(); state.playing ? pause() : play(); }
  if (event.key.toLowerCase() === 'r') restart();
  if (event.key === 'ArrowRight') { state.time = state.duration; draw(); }
};
