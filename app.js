const CANDLE_SIZE = 6;
const ACCENT_VELOCITY = 120;
const UPDATE_INTERVAL = 50;
const AUDIO_LOOKAHEAD = 0.35;
const MIDI_URL = 'catenaires_sample.mid';

const $ = (id) => document.getElementById(id);
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const state = { notes: [], candles: [], duration: 0, time: 0, seed: 42, speed: 1, playing: false, paused: false, raf: 0, audio: null, audioNoteIndex: 0, audioOrigin: 0, audioStart: 0 };

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

function randomizeDelta(delta, accented, random) { const low = Math.min(-0.5, -0.25 * Math.abs(delta)); const high = Math.max(0.5, 0.25 * Math.abs(delta)); let result = delta + (random() * (high - low) + low); if (accented) { const accentLow = Math.min(0, 1.25 * delta); const accentHigh = Math.max(0, 1.25 * delta); result += random() * (accentHigh - accentLow) + accentLow; } return result; }
function buildCandles(notes, seed) {
  const random = seededRandom(seed), candles = [];
  for (let index = 0; index + CANDLE_SIZE <= notes.length; index += CANDLE_SIZE) {
    const chunk = notes.slice(index, index + CANDLE_SIZE), path = [0], deltas = [];
    for (let i = 0; i < CANDLE_SIZE - 1; i++) { const delta = chunk[i + 1].pitch - chunk[i].pitch; const randomized = randomizeDelta(delta, chunk[i + 1].velocity >= ACCENT_VELOCITY, random); deltas.push(randomized); path.push(path[path.length - 1] + randomized); }
    candles.push({ index: index / CANDLE_SIZE, notes: chunk, path, open: 0, high: Math.max(...path), low: Math.min(...path), close: path[path.length - 1] });
  }
  let previousClose = 0;
  for (const candle of candles) { const offset = previousClose - candle.path[0]; candle.path = candle.path.map(value => value + offset); candle.open = candle.path[0]; candle.high = Math.max(...candle.path); candle.low = Math.min(...candle.path); candle.close = candle.path[candle.path.length - 1]; previousClose = candle.close; }
  return candles;
}

function partialCandle(candle, time) {
  const times = candle.notes.map(note => note.time); if (time <= times[0]) return { ...candle, path: [candle.open], high: candle.open, low: candle.open, close: candle.open };
  let index = Math.max(0, Math.min(candle.path.length - 1, times.findIndex(value => value > time) - 1)); if (index < 0) index = candle.path.length - 1; const path = candle.path.slice(0, index + 1);
  if (index < candle.path.length - 1 && time < times[times.length - 1]) { const fraction = Math.max(0, Math.min(1, (time - times[index]) / (times[index + 1] - times[index]))); path.push(path[path.length - 1] + fraction * (candle.path[index + 1] - candle.path[index])); }
  return { ...candle, path, high: Math.max(...path), low: Math.min(...path), close: path[path.length - 1] };
}

function resizeCanvas() { const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); draw(); }
function draw() {
  const width = canvas.clientWidth, height = canvas.clientHeight; ctx.clearRect(0, 0, width, height); if (!state.candles.length) return;
  const values = state.candles.flatMap(candle => [candle.low, candle.high]), min = Math.min(...values), max = Math.max(...values), margin = Math.max(2, (max - min) * .1), y = value => height - 28 - ((value - (min - margin)) / (max - min + margin * 2)) * (height - 52), x = index => 38 + index * ((width - 58) / Math.max(1, state.candles.length));
  ctx.strokeStyle = '#d4d3c9'; ctx.lineWidth = 1; ctx.font = '10px DM Mono, monospace'; ctx.fillStyle = '#7a8177';
  for (let i = 0; i < 5; i++) { const value = min - margin + ((max - min + margin * 2) * i / 4); const py = y(value); ctx.beginPath(); ctx.moveTo(38, py); ctx.lineTo(width - 10, py); ctx.stroke(); ctx.fillText(value.toFixed(1), 3, py - 4); }
  const activeIndex = Math.max(0, Math.min(state.candles.length - 1, Math.floor(state.notes.findIndex(note => note.time > state.time) / CANDLE_SIZE))); const active = partialCandle(state.candles[activeIndex], state.time); const completed = state.time >= state.candles[activeIndex].notes.at(-1).time;
  state.candles.forEach((candle, index) => { if (index > activeIndex || (index === activeIndex && !completed)) return; const color = candle.close >= candle.open ? '#315d48' : '#b85c45'; drawCandle(candle, index, color, x, y); });
  if (!completed) drawCandle(active, activeIndex, active.close >= active.open ? '#315d48' : '#b85c45', x, y);
  const start = state.candles[activeIndex].notes[0].time, end = state.candles[activeIndex].notes.at(-1).time, progress = end > start ? Math.max(0, Math.min(1, (state.time - start) / (end - start))) : 0, playX = x(activeIndex + progress);
  ctx.strokeStyle = '#c39141'; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, height - 28); ctx.stroke(); ctx.setLineDash([]);
  updateReadout(active, activeIndex); $('measureLabel').textContent = `MEASURE ${String(Math.floor(activeIndex / 2) + 1).padStart(2, '0')} / CANDLE ${String(activeIndex % 2 + 1).padStart(2, '0')}`;
}
function drawCandle(candle, index, color, x, y) { const px = x(index), open = y(candle.open), close = y(candle.close), high = y(candle.high), low = y(candle.low); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, high); ctx.lineTo(px, low); ctx.stroke(); ctx.globalAlpha = .84; ctx.fillRect(px - 5, Math.min(open, close), 10, Math.max(2, Math.abs(close - open))); ctx.globalAlpha = 1; }
function updateReadout(candle) { $('openValue').textContent = candle.open.toFixed(2); $('highValue').textContent = candle.high.toFixed(2); $('lowValue').textContent = candle.low.toFixed(2); $('closeValue').textContent = candle.close.toFixed(2); }
function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }

function createPianoVoice(note, startTime) {
  const context = state.audio;
  const frequency = 440 * Math.pow(2, (note.pitch - 69) / 12);
  const loudness = Math.min(0.045, 0.012 + note.velocity / 3600);
  const output = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(9000, frequency * 13), startTime);
  filter.Q.value = 0.7;
  output.gain.setValueAtTime(0.0001, startTime);
  output.gain.exponentialRampToValueAtTime(loudness, startTime + 0.006);
  output.gain.exponentialRampToValueAtTime(loudness * 0.32, startTime + 0.32);
  output.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.8);
  filter.connect(output).connect(context.destination);

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
    oscillator.stop(startTime + 1.85);
  }

  const hammer = context.createBufferSource();
  const noise = context.createBuffer(1, context.sampleRate * 0.035, context.sampleRate);
  const noiseData = noise.getChannelData(0);
  for (let i = 0; i < noiseData.length; i += 1) noiseData[i] = (Math.random() * 2 - 1) * (1 - i / noiseData.length);
  hammer.buffer = noise;
  const hammerGain = context.createGain();
  hammerGain.gain.setValueAtTime(Math.min(0.018, note.velocity / 8000), startTime);
  hammerGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.035);
  hammer.connect(hammerGain).connect(filter);
  hammer.start(startTime);
}

function scheduleAudioNotes() {
  if (!state.audio) return;
  const contextTime = state.audio.currentTime;
  const scheduledUntil = state.time + AUDIO_LOOKAHEAD * state.speed;
  while (state.audioNoteIndex < state.notes.length && state.notes[state.audioNoteIndex].time <= scheduledUntil) {
    const note = state.notes[state.audioNoteIndex];
    const startTime = state.audioStart + (note.time - state.audioOrigin) / state.speed;
    if (startTime >= contextTime - 0.01) createPianoVoice(note, startTime);
    state.audioNoteIndex += 1;
  }
}

function setupAudio() {
  state.audio = new (window.AudioContext || window.webkitAudioContext)();
  state.audioOrigin = state.time;
  state.audioStart = state.audio.currentTime + 0.04;
  state.audioNoteIndex = state.notes.findIndex(note => note.time >= state.time);
  if (state.audioNoteIndex < 0) state.audioNoteIndex = state.notes.length;
  scheduleAudioNotes();
}

function animate(timestamp) {
  if (!state.lastFrame) state.lastFrame = timestamp;
  if (state.playing) {
    state.time = Math.min(state.duration, state.time + (timestamp - state.lastFrame) / 1000 * state.speed);
    scheduleAudioNotes();
  }
  state.lastFrame = timestamp;
  $('timeline').value = state.time;
  $('timeLabel').textContent = `${formatTime(state.time)} / ${formatTime(state.duration)}`;
  $('statusLabel').textContent = state.time >= state.duration ? 'FINISHED' : state.playing ? 'PLAYING' : 'PAUSED';
  draw();
  if (state.playing && state.time < state.duration) state.raf = requestAnimationFrame(animate);
  else state.playing = false;
}

function play() {
  if (state.time >= state.duration) state.time = 0;
  if (!state.audio) setupAudio();
  state.audio.resume();
  state.playing = true;
  state.paused = false;
  cancelAnimationFrame(state.raf);
  state.lastFrame = 0;
  state.raf = requestAnimationFrame(animate);
}

function pause() {
  state.playing = false;
  state.paused = true;
  if (state.audio) state.audio.close();
  state.audio = null;
  draw();
}

function restart() {
  state.playing = false;
  state.time = 0;
  if (state.audio) state.audio.close();
  state.audio = null;
  draw();
}

$('playButton').onclick = play; $('pauseButton').onclick = pause; $('restartButton').onclick = restart; $('finishButton').onclick = () => { state.playing = false; state.time = state.duration; draw(); }; $('timeline').oninput = event => { state.time = Number(event.target.value); if (state.audio) state.audio.close(); state.audio = null; draw(); }; $('speed').oninput = event => { state.speed = Number(event.target.value); $('speedValue').textContent = `${state.speed.toFixed(2)}x`; }; $('seed').onchange = event => { state.seed = Number(event.target.value) || 1; state.candles = buildCandles(state.notes, state.seed); restart(); };
window.onresize = resizeCanvas; window.onkeydown = event => { if (event.target.tagName === 'INPUT') return; if (event.code === 'Space') { event.preventDefault(); state.playing ? pause() : play(); } if (event.key.toLowerCase() === 'r') restart(); if (event.key === 'ArrowRight') { state.time = state.duration; draw(); } };
fetch(MIDI_URL).then(response => response.arrayBuffer()).then(buffer => { state.notes = parseMidi(buffer); state.duration = state.notes.at(-1).time; state.candles = buildCandles(state.notes, state.seed); $('noteCount').textContent = `${state.notes.length} NOTES / ${state.candles.length} CANDLES`; $('timeline').max = state.duration; resizeCanvas(); draw(); }).catch(() => { $('statusLabel').textContent = 'MIDI NOT FOUND'; $('noteCount').textContent = 'ADD MIDI BESIDE PAGE'; });
