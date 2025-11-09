# Coop Door Web UI

The Svelte/Vite stack has been replaced with a zero-build interface that uses plain HTML, Pico.css, and vanilla JavaScript. Everything the controller needs lives in this folder, so deployment is as simple as copying three files.

## Files

- `index.html` &mdash; markup plus Pico.css reference.
- `styles.css` &mdash; lightweight overrides for cards, chips, and countdown visuals.
- `app.js` &mdash; polling logic, countdown handling, and door command helpers.

## Running locally

Because the UI fetches `/api/*` endpoints, open it through any lightweight HTTP server so requests are handled over HTTP/S:

```powershell
cd webui
python -m http.server 4173
```

Browse to wherever you host it (for example `http://localhost:4173`) and use the **Change device** button to enter the controller's IP/host (or append `?device=http://192.168.4.1` to the URL). When the files are served directly from the ESP32 you can skip this step because the UI talks to the same origin automatically.

## Customizing

- Timing constants live at the top of `app.js` if the firmware's travel time changes.
- Styles can be tweaked in `styles.css` without rebuilding anything.
- To add new data points, extend the markup in `index.html` and update the render logic inside `app.js`.

No npm install, bundlers, or hot module reloading is required anymore; edit the files directly and refresh the browser.

## Embedding into the ESP32 firmware

Whenever you change any of the files above, regenerate the embedded asset blob before flashing:

```powershell
cd ..
python tools/embed_web_assets.py --dist webui
pio run -t upload
```

The helper script now reads straight from this directory (no build step), so what you edit here is exactly what the ESP32 will serve.
