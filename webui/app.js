const STATUS_ENDPOINT = '/api/status';
const COMMAND_ENDPOINT = (action) => `/api/door/${action}`;
const POLL_INTERVAL_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS;
const HISTORY_ENDPOINT = '/api/history';
const HISTORY_POLL_INTERVAL_MS = 15000;
const HISTORY_DISPLAY_LIMIT = 30;

const state = {
  status: null,
  loading: true,
  commandInFlight: '',
  errorMessage: '',
  lastUpdated: null,
  countdownMs: null,
  manualReloading: false,
  currentTime: new Date(),
  initialized: false,
  doorHistory: [],
  historyError: ''
};

let countdownTimerId = null;
let latestStatusRequestId = 0;
let latestHistoryRequestId = 0;
let historyPollTimer = null;

const elements = {
  lastUpdated: document.querySelector('[data-last-updated]'),
  refreshButton: document.getElementById('refresh-btn'),
  loadingSection: document.querySelector('[data-loading]'),
  cardsSection: document.querySelector('[data-cards]'),
  statusHint: document.querySelector('[data-status-hint]'),
  errorBanner: document.querySelector('[data-error]'),
  currentTime: document.querySelector('[data-current-time]'),
  doorChip: document.querySelector('[data-door-chip]'),
  countdownWrapper: document.querySelector('[data-countdown]'),
  countdownValue: document.querySelector('[data-countdown-value]'),
  countdownMeta: document.querySelector('[data-countdown-meta]'),
  countdownBar: document.querySelector('[data-countdown-bar]'),
  countdownFill: document.querySelector('[data-countdown-fill]'),
  testModeChip: document.querySelector('[data-test-mode]'),
  openButton: document.querySelector('[data-open-btn]'),
  closeButton: document.querySelector('[data-close-btn]'),
  batteryTemp: document.querySelector('[data-battery-temp]'),
  greenhouseTemp: document.querySelector('[data-greenhouse-temp]'),
  batteryVoltage: document.querySelector('[data-battery-voltage]'),
  wifiValues: document.querySelector('[data-wifi-values]'),
  wifiSsid: document.querySelector('[data-wifi-ssid]'),
  wifiIp: document.querySelector('[data-wifi-ip]'),
  wifiSignal: document.querySelector('[data-wifi-signal]'),
  wifiEmpty: document.querySelector('[data-wifi-empty]'),
  doorHistoryBody: document.querySelector('[data-door-history-body]'),
  downloadHistoryButton: document.querySelector('[data-download-history]')
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function doorMotion() {
  return state.status?.door?.motion ?? 'idle';
}

function doorState() {
  return state.status?.door?.state ?? 'unknown';
}

function doorTargetState() {
  return state.status?.door?.targetState ?? null;
}

function doorBusy() {
  return Boolean(state.status?.door?.busy);
}

function isActionActive(action) {
  if (state.commandInFlight === action) {
    return true;
  }
  const motion = doorMotion();
  if (action === 'open') {
    return motion === 'opening';
  }
  if (action === 'close') {
    return motion === 'closing';
  }
  return false;
}

function render() {
  const loading = state.loading;
  const currentDoor = state.status?.door ?? {};
  const travelTimeMs = currentDoor.travelTimeMs ?? DEFAULT_DOOR_TRAVEL_TIME_MS;
  const countdownPercent = state.countdownMs != null && travelTimeMs
    ? Math.min(100, Math.max(0, ((travelTimeMs - state.countdownMs) / travelTimeMs) * 100))
    : 0;
  const chipLabel = doorBusy() && currentDoor.motion && currentDoor.motion !== 'idle'
    ? currentDoor.motion
    : doorState();
  const showInitialLoading = loading && !state.initialized;

  if (elements.loadingSection) {
    elements.loadingSection.hidden = !showInitialLoading;
  }
  if (elements.cardsSection) {
    elements.cardsSection.hidden = !state.initialized;
  }
  if (elements.statusHint) {
    let hintMessage = '';
    if (state.manualReloading) {
      hintMessage = 'Refreshing data...';
    } else if (loading) {
      hintMessage = 'Syncing with controller...';
    } else if (state.commandInFlight === 'open') {
      hintMessage = 'Opening door...';
    } else if (state.commandInFlight === 'close') {
      hintMessage = 'Closing door...';
    }
    const showHint = state.initialized && Boolean(hintMessage);
    elements.statusHint.hidden = !showHint;
    if (showHint) {
      elements.statusHint.textContent = hintMessage;
    }
  }
  if (elements.errorBanner) {
    elements.errorBanner.hidden = !state.errorMessage;
    elements.errorBanner.textContent = state.errorMessage;
  }
  if (elements.lastUpdated) {
    elements.lastUpdated.textContent = state.lastUpdated
      ? `Last updated ${state.lastUpdated.toLocaleTimeString()}`
      : 'Waiting for controller...';
  }
  if (elements.refreshButton) {
    elements.refreshButton.disabled = loading || state.manualReloading;
    elements.refreshButton.textContent = state.manualReloading ? 'Refreshing...' : 'Refresh';
  }
  if (elements.currentTime) {
    elements.currentTime.textContent = formatCurrentTime(state.currentTime);
  }
  if (elements.doorChip) {
    elements.doorChip.textContent = chipLabel ?? 'unknown';
    elements.doorChip.className = `status-chip ${chipLabel ?? 'unknown'}`;
  }

  const showCountdown = doorBusy() && state.countdownMs != null;
  if (elements.countdownWrapper) {
    elements.countdownWrapper.hidden = !showCountdown;
  }
  if (showCountdown && elements.countdownValue) {
    elements.countdownValue.textContent = formatCountdown(state.countdownMs);
  }
  if (elements.countdownBar) {
    elements.countdownBar.hidden = !showCountdown || !travelTimeMs;
  }
  if (elements.countdownFill) {
    elements.countdownFill.style.width = `${countdownPercent}%`;
  }
  if (elements.countdownMeta) {
    const parts = [`Targeting ${doorTargetState() ?? '--'}`];
    if (travelTimeMs) {
      parts.push(`\u00B7 ${Math.round(travelTimeMs / 1000)}s total travel`);
    }
    elements.countdownMeta.textContent = parts.join(' ');
  }

  if (elements.testModeChip) {
    const showTest = Boolean(currentDoor.testMode);
    elements.testModeChip.hidden = !showTest;
  }

  if (elements.openButton) {
    elements.openButton.disabled = doorBusy() || state.commandInFlight === 'close';
    elements.openButton.classList.toggle('active-action', isActionActive('open'));
    elements.openButton.textContent = state.commandInFlight === 'open' ? 'Opening...' : 'Open door';
  }

  if (elements.closeButton) {
    elements.closeButton.disabled = doorBusy() || state.commandInFlight === 'open';
    elements.closeButton.classList.toggle('active-action', isActionActive('close'));
    elements.closeButton.textContent = state.commandInFlight === 'close' ? 'Closing...' : 'Close door';
  }

  if (elements.batteryTemp) {
    elements.batteryTemp.textContent = formatTemp(state.status?.sensors?.batteryTempC);
  }
  if (elements.greenhouseTemp) {
    elements.greenhouseTemp.textContent = formatTemp(state.status?.sensors?.greenhouseTempC);
  }
  if (elements.batteryVoltage) {
    elements.batteryVoltage.textContent = formatVoltage(state.status?.sensors?.batteryVoltage);
  }

  const hasWifi = Boolean(state.status?.wifi);
  if (elements.wifiValues) {
    elements.wifiValues.hidden = !hasWifi;
  }
  if (elements.wifiEmpty) {
    elements.wifiEmpty.hidden = hasWifi;
  }
  if (hasWifi) {
    if (elements.wifiSsid) {
      elements.wifiSsid.textContent = state.status.wifi.ssid ?? '--';
    }
    if (elements.wifiIp) {
      elements.wifiIp.textContent = state.status.wifi.ip ?? '--';
    }
    if (elements.wifiSignal) {
      elements.wifiSignal.textContent = formatRssi(state.status.wifi.rssi);
    }
  }

  renderDoorHistory();
}

function renderDoorHistory() {
  if (!elements.doorHistoryBody) {
    return;
  }
  if (state.historyError) {
    elements.doorHistoryBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-history">${state.historyError}</td>
      </tr>
    `;
    return;
  }
  const rows = Array.isArray(state.doorHistory) ? state.doorHistory : [];
  if (!rows.length) {
    elements.doorHistoryBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-history">History will appear once data is available.</td>
      </tr>
    `;
    return;
  }
  const markup = rows.map((entry) => `
      <tr>
        <td>${formatHistoryTimestamp(entry.timestamp)}</td>
        <td>${formatHistoryDoorState(entry.doorState)}</td>
        <td>${formatTemp(entry.batteryTempC)}</td>
        <td>${formatTemp(entry.greenhouseTempC)}</td>
        <td>${formatVoltage(entry.batteryVoltage)}</td>
        <td>${formatHistoryEvent(entry.event)}</td>
      </tr>
    `).join('');
  elements.doorHistoryBody.innerHTML = markup;
}

function formatCurrentTime(date) {
  return date ? date.toLocaleTimeString() : '--';
}

function formatHistoryTimestamp(value) {
  if (value == null) {
    return '--';
  }
  let timestampMs = value;
  if (typeof value === 'number' && value < 1e12) {
    timestampMs = value * 1000;
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function formatHistoryDoorState(value) {
  if (!value) {
    return 'unknown';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatHistoryEvent(value) {
  if (!value) {
    return 'Snapshot';
  }
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatTemp(value) {
  return value == null ? '--' : `${Number(value).toFixed(1)}\u00B0C`;
}

function formatVoltage(value) {
  return value == null ? '--' : `${Number(value).toFixed(2)} V`;
}

function formatRssi(value) {
  return value == null ? '--' : `${value} dBm`;
}

function formatCountdown(ms) {
  if (ms == null) {
    return '--';
  }
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

async function fetchDoorHistory() {
  const requestId = ++latestHistoryRequestId;
  try {
    const response = await fetch(HISTORY_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`History request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (requestId !== latestHistoryRequestId) {
      return;
    }
    const normalized = Array.isArray(payload) ? payload.slice(0, HISTORY_DISPLAY_LIMIT) : [];
    setState({ doorHistory: normalized, historyError: '' });
  } catch (error) {
    if (requestId !== latestHistoryRequestId) {
      return;
    }
    console.error(error);
    setState({
      doorHistory: [],
      historyError: error?.message ?? 'Unable to load history.'
    });
  }
}

function downloadHistoryCsv() {
  const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];
  const link = document.createElement('a');
  link.href = '/history.csv';
  link.download = `door-history-${timestamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function applyStatus(payload) {
  setState({
    status: payload,
    lastUpdated: new Date(),
    initialized: true
  });
  syncCountdownFromStatus();
}

function updateDoorStatus(doorPayload, options = {}) {
  const nextStatus = state.status ? { ...state.status, door: doorPayload } : { door: doorPayload };
  setState({
    status: nextStatus,
    lastUpdated: new Date()
  });
  if (options.syncCountdown ?? true) {
    syncCountdownFromStatus();
  }
}

function syncCountdownFromStatus() {
  if (state.status?.door?.busy) {
    let remaining = typeof state.status.door.motionRemainingMs === 'number'
      ? state.status.door.motionRemainingMs
      : state.status.door.travelTimeMs ?? DEFAULT_POMODORO_LENGTH_MS;
    if (remaining == null) {
      remaining = DEFAULT_POMODORO_LENGTH_MS;
    }
    setState({ countdownMs: remaining });
    if (state.countdownMs != null) {
      startCountdownLoop();
    } else {
      stopCountdownLoop();
    }
  } else {
    setState({ countdownMs: null });
    stopCountdownLoop();
  }
}

function startCountdownLoop() {
  if (countdownTimerId) {
    return;
  }
  let previous = Date.now();
  countdownTimerId = setInterval(() => {
    if (state.countdownMs == null) {
      stopCountdownLoop();
      return;
    }
    const now = Date.now();
    const delta = now - previous;
    previous = now;
    const nextValue = Math.max(0, state.countdownMs - delta);
    setState({ countdownMs: nextValue });
    if (nextValue === 0) {
      finalizeCountdown();
    }
  }, COUNTDOWN_TICK_MS);
}

function stopCountdownLoop() {
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
}

function settleDoorLocally() {
  if (!state.status?.door) {
    setState({ countdownMs: null });
    stopCountdownLoop();
    return;
  }
  const nextState = state.status.door.targetState ?? state.status.door.state;
  const updatedDoor = {
    ...state.status.door,
    state: nextState,
    targetState: nextState,
    busy: false,
    motion: 'idle',
    motionRemainingMs: null
  };
  stopCountdownLoop();
  setState({ countdownMs: null });
  updateDoorStatus(updatedDoor, { syncCountdown: false });
}

function finalizeCountdown() {
  settleDoorLocally();
  fetchStatus();
}

async function manualRefresh() {
  if (state.manualReloading) {
    return;
  }
  setState({ manualReloading: true });
  try {
    await fetchStatus();
  } finally {
    setState({ manualReloading: false });
  }
}

async function fetchStatus(initial = false) {
  const requestId = ++latestStatusRequestId;
  if (initial) {
    setState({ loading: true });
  }
  setState({ errorMessage: '' });
  try {
    const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Status request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (requestId === latestStatusRequestId) {
      applyStatus(payload);
    }
  } catch (error) {
    if (requestId !== latestStatusRequestId) {
      return;
    }
    console.error(error);
    setState({ errorMessage: error?.message ?? 'Unable to reach the controller.' });
  } finally {
    if (requestId === latestStatusRequestId) {
      setState({ loading: false });
    }
  }
}

async function sendDoorCommand(action) {
  if (!state.status?.door || state.commandInFlight) {
    return;
  }
  setState({ commandInFlight: action, errorMessage: '' });
  try {
    const response = await fetch(COMMAND_ENDPOINT(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`Command failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.door) {
      updateDoorStatus(payload.door);
    }
  } catch (error) {
    console.error(error);
    setState({ errorMessage: error?.message ?? 'Command failed.' });
  } finally {
    setState({ commandInFlight: '' });
    fetchStatus();
  }
}

render();
fetchStatus(true);
fetchDoorHistory();

const pollTimer = setInterval(fetchStatus, POLL_INTERVAL_MS);
const clockTimer = setInterval(() => {
  setState({ currentTime: new Date() });
}, 1000);
historyPollTimer = setInterval(fetchDoorHistory, HISTORY_POLL_INTERVAL_MS);

if (elements.refreshButton) {
  elements.refreshButton.addEventListener('click', manualRefresh);
}
if (elements.openButton) {
  elements.openButton.addEventListener('click', () => sendDoorCommand('open'));
}
if (elements.closeButton) {
  elements.closeButton.addEventListener('click', () => sendDoorCommand('close'));
}
if (elements.downloadHistoryButton) {
  elements.downloadHistoryButton.addEventListener('click', downloadHistoryCsv);
}

window.addEventListener('beforeunload', () => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(historyPollTimer);
  stopCountdownLoop();
});
