const API_BASE_STORAGE_KEY = 'coop:api-base';
const API_QUERY_PARAM_KEYS = ['device', 'controller', 'host', 'api'];
const POLL_INTERVAL_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS;
const HISTORY_POLL_INTERVAL_MS = 15000;
const HISTORY_DISPLAY_LIMIT = 30;

function getPageOrigin() {
  if (window.location.origin && window.location.origin !== 'null') {
    return window.location.origin;
  }
  const host = window.location.host ? `//${window.location.host}` : '//';
  return `${window.location.protocol}${host}`;
}

function sanitizeApiBase(value) {
  if (!value) {
    return '';
  }
  let input = value.trim();
  if (!input || input === '/' || input === '.') {
    return '';
  }
  if (input.startsWith('/')) {
    return input.replace(/\/+$/, '');
  }
  if (input.startsWith('//')) {
    return `${window.location.protocol}${input}`.replace(/\/+$/, '');
  }
  let normalized = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  try {
    const url = new URL(normalized);
    if (url.pathname === '/api' && !url.search && !url.hash) {
      url.pathname = '/';
    }
    url.hash = '';
    url.search = '';
    let result = url.toString();
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    return result;
  } catch (error) {
    console.error('Invalid API base provided:', error);
    return '';
  }
}

function readStoredApiBase() {
  try {
    return sanitizeApiBase(window.localStorage?.getItem(API_BASE_STORAGE_KEY) ?? '');
  } catch {
    return '';
  }
}

function persistApiBase(value) {
  try {
    if (value) {
      window.localStorage?.setItem(API_BASE_STORAGE_KEY, value);
    } else {
      window.localStorage?.removeItem(API_BASE_STORAGE_KEY);
    }
  } catch {
    // Storage might be unavailable (private browsing, etc.)
  }
}

function getQueryApiBase() {
  try {
    const params = new URLSearchParams(window.location.search ?? '');
    for (const key of API_QUERY_PARAM_KEYS) {
      const candidate = params.get(key);
      if (candidate) {
        return sanitizeApiBase(candidate);
      }
    }
  } catch {
    // Ignore parse errors
  }
  return '';
}

const initialApiBase = (() => {
  const fromQuery = getQueryApiBase();
  if (fromQuery) {
    persistApiBase(fromQuery);
    return fromQuery;
  }
  return readStoredApiBase();
})();

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
  historyError: '',
  activeTab: 'dashboard',
  wifiConfig: null,
  wifiConfigLoading: false,
  wifiSaving: false,
  wifiMessage: '',
  wifiMessageType: '',
  wifiForm: {
    ssid: '',
    password: '',
    retainCredentials: true
  },
  wifiFormDirty: false,
  wifiScanResults: [],
  wifiScanLoading: false,
  wifiScanRequested: false,
  apiBase: initialApiBase,
  devicePanelOpen: false,
  devicePanelMessage: '',
  devicePanelMessageType: ''
};

let countdownTimerId = null;
let latestStatusRequestId = 0;
let latestHistoryRequestId = 0;
let historyPollTimer = null;

const elements = {
  lastUpdated: document.querySelector('[data-last-updated]'),
  deviceTarget: document.querySelector('[data-device-target]'),
  refreshButton: document.getElementById('refresh-btn'),
  deviceTargetButton: document.getElementById('device-target-btn'),
  devicePanel: document.querySelector('[data-device-panel]'),
  devicePanelForm: document.querySelector('[data-device-form]'),
  devicePanelInput: document.querySelector('[data-device-input]'),
  devicePanelMessage: document.querySelector('[data-device-message]'),
  deviceResetButton: document.querySelector('[data-device-reset]'),
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
  downloadHistoryButton: document.querySelector('[data-download-history]'),
  dashboardPanel: document.querySelector('[data-dashboard-panel]'),
  settingsPanel: document.querySelector('[data-settings-panel]'),
  tabButtons: document.querySelectorAll('[data-tab-btn]'),
  wifiForm: document.querySelector('[data-wifi-form]'),
  wifiSsidInput: document.querySelector('[data-wifi-ssid-input]'),
  wifiPasswordInput: document.querySelector('[data-wifi-password-input]'),
  wifiRetainSelect: document.querySelector('[data-wifi-retain-select]'),
  wifiSubmitButton: document.querySelector('[data-wifi-submit]'),
  wifiScanButton: document.querySelector('[data-wifi-scan]'),
  wifiScanResults: document.querySelector('[data-wifi-scan-results]'),
  wifiMessage: document.querySelector('[data-wifi-message]'),
  wifiApBadge: document.querySelector('[data-wifi-ap-badge]'),
  wifiApHint: document.querySelector('[data-wifi-ap-hint]'),
  wifiConfigMeta: document.querySelector('[data-wifi-config-meta]')
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

function buildEndpoint(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = state.apiBase;
  if (!base) {
    return normalizedPath;
  }
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}${normalizedPath}`;
}

function formatDeviceTargetLabel() {
  const origin = getPageOrigin();
  const normalizedOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  if (!state.apiBase) {
    return `Device target: ${normalizedOrigin}`;
  }
  if (/^https?:\/\//i.test(state.apiBase)) {
    return `Device target: ${state.apiBase}`;
  }
  return `Device target: ${normalizedOrigin}${state.apiBase}`;
}

function applyApiBaseChange(nextBase, options = {}) {
  const sanitized = sanitizeApiBase(nextBase);
  if (sanitized === state.apiBase) {
    return;
  }
  if (!options.skipPersist) {
    persistApiBase(sanitized);
  }
  const resettingWifiState = state.activeTab === 'settings';
  setState({
    apiBase: sanitized,
    status: null,
    lastUpdated: null,
    initialized: false,
    errorMessage: '',
    doorHistory: [],
    historyError: '',
    wifiMessage: '',
    wifiMessageType: ''
  });
  fetchStatus(true);
  fetchDoorHistory();
  if (resettingWifiState) {
    setState({
      wifiConfig: null,
      wifiConfigLoading: false,
      wifiForm: {
        ssid: '',
        password: '',
        retainCredentials: true
      },
      wifiFormDirty: false,
      wifiScanResults: [],
      wifiScanRequested: false
    });
    fetchWifiConfig();
  }
}

function clearDevicePanelMessage() {
  if (!state.devicePanelMessage && !state.devicePanelMessageType) {
    return;
  }
  setState({ devicePanelMessage: '', devicePanelMessageType: '' });
}

function toggleDevicePanel(forceOpen) {
  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !state.devicePanelOpen;
  if (nextOpen === state.devicePanelOpen) {
    if (nextOpen) {
      requestAnimationFrame(() => {
        elements.devicePanelInput?.focus();
        elements.devicePanelInput?.select();
      });
    }
    return;
  }
  setState({
    devicePanelOpen: nextOpen,
    devicePanelMessage: '',
    devicePanelMessageType: ''
  });
  if (nextOpen) {
    requestAnimationFrame(() => {
      elements.devicePanelInput?.focus();
      elements.devicePanelInput?.select();
    });
  }
}

function handleDeviceTargetClick() {
  toggleDevicePanel();
}

function handleDeviceFormSubmit(event) {
  event.preventDefault();
  const value = (elements.devicePanelInput?.value ?? '').trim();
  if (!value) {
    applyApiBaseChange('');
    toggleDevicePanel(false);
    return;
  }
  const sanitized = sanitizeApiBase(value);
  if (!sanitized) {
    setState({
      devicePanelMessage: 'Enter a valid http(s) URL, hostname, or /path value.',
      devicePanelMessageType: 'error'
    });
    return;
  }
  applyApiBaseChange(sanitized);
  toggleDevicePanel(false);
}

function handleDeviceResetClick() {
  applyApiBaseChange('');
  toggleDevicePanel(false);
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
  const settingsActive = state.activeTab === 'settings';
  const isDashboard = !settingsActive;
  const showInitialLoading = loading && !state.initialized && isDashboard;

  if (elements.loadingSection) {
    elements.loadingSection.hidden = !showInitialLoading;
  }
  if (elements.cardsSection) {
    elements.cardsSection.hidden = !state.initialized || !isDashboard;
  }
  if (elements.dashboardPanel) {
    elements.dashboardPanel.hidden = !isDashboard;
  }
  if (elements.settingsPanel) {
    elements.settingsPanel.hidden = !settingsActive;
  }
  if (!settingsActive && elements.settingsPanel?.contains(document.activeElement)) {
    if (typeof document.activeElement?.blur === 'function') {
      document.activeElement.blur();
    }
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
    const showHint = state.initialized && Boolean(hintMessage) && isDashboard;
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
  if (elements.deviceTarget) {
    elements.deviceTarget.textContent = formatDeviceTargetLabel();
  }
  if (elements.devicePanel) {
    elements.devicePanel.hidden = !state.devicePanelOpen;
  }
  if (elements.devicePanelInput) {
    const nextValue = state.apiBase ?? '';
    if (elements.devicePanelInput.value !== nextValue) {
      elements.devicePanelInput.value = nextValue;
    }
  }
  if (elements.devicePanelMessage) {
    const hasMessage = Boolean(state.devicePanelMessage);
    elements.devicePanelMessage.hidden = !hasMessage;
    if (hasMessage) {
      elements.devicePanelMessage.textContent = state.devicePanelMessage;
      const type = state.devicePanelMessageType || 'error';
      elements.devicePanelMessage.className = `device-form-message subtle small ${type}`;
    }
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

  if (elements.tabButtons && elements.tabButtons.length) {
    elements.tabButtons.forEach((button) => {
      const tabName = button.dataset.tabBtn ?? 'dashboard';
      const isActive = tabName === state.activeTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  const settingsLocked = !settingsActive || state.wifiSaving;
  const configLoading = state.wifiConfigLoading && settingsActive;
  if (elements.wifiSsidInput) {
    elements.wifiSsidInput.value = state.wifiForm?.ssid ?? '';
    elements.wifiSsidInput.disabled = settingsLocked;
  }
  if (elements.wifiPasswordInput) {
    elements.wifiPasswordInput.value = state.wifiForm?.password ?? '';
    elements.wifiPasswordInput.disabled = settingsLocked;
  }
  if (elements.wifiRetainSelect) {
    const retainValue = state.wifiForm?.retainCredentials !== false;
    elements.wifiRetainSelect.value = String(retainValue);
    elements.wifiRetainSelect.disabled = settingsLocked;
  }
  if (elements.wifiSubmitButton) {
    const hasSsid = Boolean((state.wifiForm?.ssid ?? '').trim());
    const retainChanged = state.wifiConfig
      ? state.wifiForm?.retainCredentials !== state.wifiConfig.retainCredentials
      : false;
    const canSubmit = settingsActive && (hasSsid || retainChanged) && !settingsLocked && !configLoading;
    elements.wifiSubmitButton.disabled = !canSubmit;
    elements.wifiSubmitButton.textContent = state.wifiSaving ? 'Saving...' : 'Save settings';
  }
  if (elements.wifiMessage) {
    if (!settingsActive) {
      elements.wifiMessage.hidden = true;
    } else {
      let messageText = state.wifiMessage;
      let messageType = state.wifiMessageType || 'info';
      if (!messageText && configLoading) {
        messageText = 'Loading Wi-Fi settings...';
        messageType = 'info';
      }
      const hasMessage = Boolean(messageText);
      elements.wifiMessage.hidden = !hasMessage;
      if (hasMessage) {
        elements.wifiMessage.textContent = messageText;
        elements.wifiMessage.className = `banner ${messageType}`;
      }
    }
  }
  if (elements.wifiApBadge) {
    const showBadge = Boolean(state.wifiConfig?.configPortalActive);
    elements.wifiApBadge.hidden = !showBadge;
  }
  if (elements.wifiApHint) {
    if (state.wifiConfig?.configPortalActive) {
      const apIp = state.wifiConfig.apIp ?? '192.168.4.1';
      elements.wifiApHint.hidden = false;
      elements.wifiApHint.textContent =
        `Device hotspot '${state.wifiConfig.configSsid ?? 'CoopDoorSetup'}' is active at ${apIp}.`;
    } else {
      elements.wifiApHint.hidden = true;
    }
  }
  if (elements.wifiConfigMeta) {
    const storedLabel = state.wifiConfig?.hasStored
      ? state.wifiConfig.storedSsid || 'Hidden SSID'
      : null;
    elements.wifiConfigMeta.textContent = storedLabel
      ? `Stored SSID: ${storedLabel}`
      : 'No stored Wi-Fi credentials yet.';
  }
  if (elements.wifiScanButton) {
    elements.wifiScanButton.disabled = !settingsActive || state.wifiScanLoading;
  }

  renderWifiScanResults();
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

function renderWifiScanResults() {
  if (!elements.wifiScanResults) {
    return;
  }
  const container = elements.wifiScanResults;
  if (state.activeTab !== 'settings') {
    container.classList.remove('visible');
    container.innerHTML = '';
    return;
  }
  container.innerHTML = '';
  if (!state.wifiScanRequested) {
    container.classList.remove('visible');
    return;
  }
  container.classList.add('visible');
  if (state.wifiScanLoading) {
    container.textContent = 'Scanning for networks...';
    return;
  }
  const networks = Array.isArray(state.wifiScanResults) ? state.wifiScanResults : [];
  if (!networks.length) {
    container.textContent = 'No networks discovered yet.';
    return;
  }
  networks.forEach((network) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'network-result';
    button.dataset.networkSsid = network?.ssid ?? '';
    const name = document.createElement('span');
    name.textContent = network?.ssid ?? 'Unknown network';
    button.appendChild(name);
    if (network?.rssi != null) {
      const rssi = document.createElement('span');
      rssi.className = 'network-rssi';
      rssi.textContent = `${network.rssi} dBm`;
      button.appendChild(rssi);
    }
    container.appendChild(button);
  });
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
    const response = await fetch(buildEndpoint('/api/history'), { cache: 'no-store' });
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
  link.href = buildEndpoint('/history.csv');
  link.download = `door-history-${timestamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function activateTab(tabName) {
  if (state.activeTab === tabName) {
    return;
  }
  const nextState = { activeTab: tabName };
  if (tabName !== 'settings') {
    nextState.wifiScanRequested = false;
  }
  setState(nextState);
  if (tabName === 'settings' && !state.wifiConfig && !state.wifiConfigLoading) {
    fetchWifiConfig();
  }
}

async function fetchWifiConfig() {
  if (state.wifiConfigLoading) {
    return;
  }
  setState({ wifiConfigLoading: true, wifiMessage: '', wifiMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/wifi/config'), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Settings request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    applyWifiConfig(payload);
  } catch (error) {
    console.error(error);
    setState({
      wifiConfigLoading: false,
      wifiMessage: error?.message ?? 'Unable to load Wi-Fi settings.',
      wifiMessageType: 'error'
    });
  }
}

function applyWifiConfig(payload) {
  const retainValue = payload?.retainCredentials !== false;
  const shouldSyncForm = !state.wifiFormDirty;
  const nextForm = shouldSyncForm
    ? {
        ssid: payload?.storedSsid ?? '',
        password: '',
        retainCredentials: retainValue
      }
    : {
        ...state.wifiForm,
        retainCredentials: state.wifiForm?.retainCredentials ?? retainValue
      };
  setState({
    wifiConfig: {
      ...payload,
      retainCredentials: retainValue
    },
    wifiConfigLoading: false,
    wifiForm: nextForm,
    wifiFormDirty: shouldSyncForm ? false : state.wifiFormDirty
  });
}

function updateWifiFormField(field, value) {
  setState({
    wifiForm: {
      ...state.wifiForm,
      [field]: value
    },
    wifiFormDirty: true,
    wifiMessage: '',
    wifiMessageType: ''
  });
}

async function handleWifiFormSubmit(event) {
  event.preventDefault();
  if (state.wifiSaving) {
    return;
  }
  const ssid = (state.wifiForm?.ssid ?? '').trim();
  const password = state.wifiForm?.password ?? '';
  const retainValue = state.wifiForm?.retainCredentials !== false;
  const retainChanged = state.wifiConfig
    ? retainValue !== state.wifiConfig.retainCredentials
    : false;
  if (!ssid && !retainChanged) {
    return;
  }
  const payload = { retainCredentials: retainValue };
  if (ssid) {
    payload.ssid = ssid;
    payload.password = password;
  }
  setState({ wifiSaving: true, wifiMessage: '', wifiMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/wifi/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload?.error ?? `Save failed with HTTP ${response.status}`);
    }
    const result = await response.json();
    const successMessage = result?.rebooting
      ? 'Credentials saved. The controller is rebooting...'
      : 'Wi-Fi settings updated.';
    const nextForm = {
      ...state.wifiForm,
      password: '',
      retainCredentials: retainValue
    };
    setState({
      wifiSaving: false,
      wifiMessage: successMessage,
      wifiMessageType: 'success',
      wifiForm: nextForm,
      wifiFormDirty: false,
      wifiConfig: state.wifiConfig
        ? { ...state.wifiConfig, retainCredentials: retainValue }
        : state.wifiConfig
    });
    if (!result?.rebooting) {
      fetchWifiConfig();
    }
  } catch (error) {
    console.error(error);
    setState({
      wifiSaving: false,
      wifiMessage: error?.message ?? 'Unable to save Wi-Fi settings.',
      wifiMessageType: 'error'
    });
  }
}

async function fetchWifiScan() {
  if (state.wifiScanLoading) {
    return;
  }
  setState({ wifiScanLoading: true, wifiScanRequested: true, wifiMessage: '', wifiMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/wifi/scan'), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Scan failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const networks = Array.isArray(payload) ? payload : [];
    setState({
      wifiScanLoading: false,
      wifiScanResults: networks
    });
  } catch (error) {
    console.error(error);
    setState({
      wifiScanLoading: false,
      wifiScanResults: [],
      wifiScanRequested: true,
      wifiMessage: error?.message ?? 'Wi-Fi scan failed.',
      wifiMessageType: 'error'
    });
  }
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
    const response = await fetch(buildEndpoint('/api/status'), { cache: 'no-store' });
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
    const response = await fetch(buildEndpoint(`/api/door/${action}`), {
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
if (elements.deviceTargetButton) {
  elements.deviceTargetButton.addEventListener('click', handleDeviceTargetClick);
}
if (elements.devicePanelForm) {
  elements.devicePanelForm.addEventListener('submit', handleDeviceFormSubmit);
}
if (elements.deviceResetButton) {
  elements.deviceResetButton.addEventListener('click', handleDeviceResetClick);
}
if (elements.devicePanelInput) {
  elements.devicePanelInput.addEventListener('input', clearDevicePanelMessage);
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
if (elements.tabButtons && elements.tabButtons.length) {
  elements.tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tabBtn ?? 'dashboard';
      activateTab(tabName);
    });
  });
}
if (elements.wifiForm) {
  elements.wifiForm.addEventListener('submit', handleWifiFormSubmit);
}
if (elements.wifiSsidInput) {
  elements.wifiSsidInput.addEventListener('input', (event) => {
    updateWifiFormField('ssid', event.target.value);
  });
}
if (elements.wifiPasswordInput) {
  elements.wifiPasswordInput.addEventListener('input', (event) => {
    updateWifiFormField('password', event.target.value);
  });
}
if (elements.wifiRetainSelect) {
  elements.wifiRetainSelect.addEventListener('change', (event) => {
    const retainValue = event.target.value === 'true';
    updateWifiFormField('retainCredentials', retainValue);
  });
}
if (elements.wifiScanButton) {
  elements.wifiScanButton.addEventListener('click', fetchWifiScan);
}
if (elements.wifiScanResults) {
  elements.wifiScanResults.addEventListener('click', (event) => {
    const button = event.target.closest('[data-network-ssid]');
    if (!button) {
      return;
    }
    const ssidValue = button.dataset.networkSsid ?? '';
    updateWifiFormField('ssid', ssidValue);
  });
}

window.addEventListener('beforeunload', () => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(historyPollTimer);
  stopCountdownLoop();
});
