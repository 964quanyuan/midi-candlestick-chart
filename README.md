# Catenaires web study

A dependency-free browser translation of `candlestick.py`.

Open `index.html` through a local server so the browser can fetch the MIDI file:

```powershell
python -m http.server 8000
```

Then visit http://localhost:8000/catenaires_web/ from the parent directory.

The page preserves the Python program's six-note candle grouping, seeded pitch-delta randomization, accent handling, playback timing, and measure/candle progression. Browser audio is synthesized from the parsed MIDI note events with Web Audio.
