const POLL_INTERVAL_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS;
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
  timezoneConfig: null,
  timezoneOptions: [],
  timezoneLoading: false,
  timezoneError: '',
  timezoneMessage: '',
  timezoneUpdating: '',
  timezonePickerOpen: false
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
  wifiConfigMeta: document.querySelector('[data-wifi-config-meta]'),
  timezoneSection: document.querySelector('[data-timezone-section]'),
  timezoneTrigger: document.querySelector('[data-timezone-trigger]'),
  timezonePicker: document.querySelector('[data-timezone-picker]'),
  timezoneOptions: document.querySelector('[data-timezone-options]'),
  timezoneMessage: document.querySelector('[data-timezone-message]'),
  timezoneLabel: document.querySelector('[data-timezone-label]'),
  timezoneOffset: document.querySelector('[data-timezone-offset]')
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
  return normalizedPath;
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
  renderTimezonePicker();
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
  const markup = rows.map((entry) => {
    const displayTime = entry?.displayTime ?? formatHistoryTimestamp(entry.timestamp);
    return `
      <tr>
        <td>${displayTime}</td>
        <td>${formatHistoryDoorState(entry.doorState)}</td>
        <td>${formatTemp(entry.batteryTempC)}</td>
        <td>${formatTemp(entry.greenhouseTempC)}</td>
        <td>${formatVoltage(entry.batteryVoltage)}</td>
        <td>${formatHistoryEvent(entry.event)}</td>
      </tr>
    `;
  }).join('');
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

function renderTimezonePicker() {
  if (!elements.timezoneTrigger) {
    return;
  }
  const labelText = state.timezoneConfig?.label ?? 'UTC';
  const offsetText = formatTimezoneOffset(state.timezoneConfig?.offsetMinutes ?? 0);
  if (elements.timezoneLabel) {
    elements.timezoneLabel.textContent = labelText;
  }
  if (elements.timezoneOffset) {
    elements.timezoneOffset.textContent = offsetText;
  }
  if (elements.timezonePicker) {
    elements.timezonePicker.hidden = !state.timezonePickerOpen;
  }
  if (elements.timezoneOptions) {
    const options = Array.isArray(state.timezoneOptions) ? state.timezoneOptions : [];
    elements.timezoneOptions.innerHTML = '';
    if (state.timezoneLoading) {
      const loading = document.createElement('p');
      loading.className = 'subtle small';
      loading.textContent = 'Loading timezones...';
      elements.timezoneOptions.appendChild(loading);
    } else if (!options.length) {
      const empty = document.createElement('p');
      empty.className = 'subtle small';
      empty.textContent = state.timezoneError || 'Timezone data unavailable.';
      elements.timezoneOptions.appendChild(empty);
    } else {
      const fragment = document.createDocumentFragment();
      options.forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'timezone-option';
        if (option.id === state.timezoneConfig?.id) {
          button.classList.add('active');
        }
        button.dataset.timezoneId = option.id ?? '';
        button.disabled = state.timezoneUpdating === option.id;
        const label = document.createElement('span');
        label.textContent = option.label ?? option.id ?? 'UTC';
        const offset = document.createElement('span');
        offset.className = 'timezone-offset';
        offset.textContent = formatTimezoneOffset(option.offsetMinutes);
        button.appendChild(label);
        button.appendChild(offset);
        fragment.appendChild(button);
      });
      elements.timezoneOptions.appendChild(fragment);
    }
  }
  if (elements.timezoneMessage) {
    const message = state.timezoneMessage || state.timezoneError || '';
    elements.timezoneMessage.textContent = message;
    elements.timezoneMessage.hidden = !message;
  }
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

function formatTimezoneOffset(minutes) {
  if (typeof minutes !== 'number' || Number.isNaN(minutes)) {
    return 'UTC+00:00';
  }
  const sign = minutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(minutes);
  const hours = Math.floor(absMinutes / 60)
    .toString()
    .padStart(2, '0');
  const remainder = (absMinutes % 60).toString().padStart(2, '0');
  return `UTC${sign}${hours}:${remainder}`;
}

function normalizeTimezoneConfig(payload) {
  const timezoneId = payload?.timezoneId ?? payload?.id ?? 'UTC';
  const label = payload?.label ?? timezoneId ?? 'UTC';
  const offset =
    typeof payload?.offsetMinutes === 'number' ? payload.offsetMinutes : 0;
  return {
    id: timezoneId,
    label,
    offsetMinutes: offset
  };
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

async function fetchTimezoneConfig(force = false) {
  if (state.timezoneLoading && !force) {
    return;
  }
  setState({
    timezoneLoading: true,
    timezoneError: '',
    timezoneMessage: ''
  });
  try {
    const response = await fetch(buildEndpoint('/api/timezone'), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Timezone request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    setState({
      timezoneLoading: false,
      timezoneConfig: normalizeTimezoneConfig(payload),
      timezoneOptions: Array.isArray(payload?.options) ? payload.options : []
    });
  } catch (error) {
    console.error(error);
    setState({
      timezoneLoading: false,
      timezoneError: error?.message ?? 'Unable to load timezone options.'
    });
  }
}

async function updateTimezoneSelection(timezoneId) {
  const trimmed = (timezoneId ?? '').trim();
  if (!trimmed || state.timezoneUpdating === trimmed) {
    return;
  }
  setState({
    timezoneUpdating: trimmed,
    timezoneError: '',
    timezoneMessage: ''
  });
  try {
    const response = await fetch(buildEndpoint('/api/timezone'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: trimmed }),
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error ?? `Timezone update failed with HTTP ${response.status}`);
    }
    setState({
      timezoneUpdating: '',
      timezoneConfig: normalizeTimezoneConfig(payload),
      timezoneMessage: 'Timezone updated.',
      timezoneError: '',
      timezonePickerOpen: false
    });
    fetchDoorHistory();
  } catch (error) {
    console.error(error);
    setState({
      timezoneUpdating: '',
      timezoneError: error?.message ?? 'Unable to update timezone.'
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
    nextState.timezonePickerOpen = false;
  }
  setState(nextState);
  if (tabName === 'settings' && !state.wifiConfig && !state.wifiConfigLoading) {
    fetchWifiConfig();
  }
  if (tabName === 'settings' && !state.timezoneConfig && !state.timezoneLoading) {
    fetchTimezoneConfig();
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
if (elements.openButton) {
  elements.openButton.addEventListener('click', () => sendDoorCommand('open'));
}
if (elements.closeButton) {
  elements.closeButton.addEventListener('click', () => sendDoorCommand('close'));
}
if (elements.downloadHistoryButton) {
  elements.downloadHistoryButton.addEventListener('click', downloadHistoryCsv);
}
if (elements.timezoneTrigger) {
  elements.timezoneTrigger.addEventListener('click', () => {
    if (!state.timezoneOptions.length && !state.timezoneLoading) {
      fetchTimezoneConfig();
    }
    setState({
      timezonePickerOpen: !state.timezonePickerOpen,
      timezoneMessage: ''
    });
  });
}
if (elements.timezoneOptions) {
  elements.timezoneOptions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-timezone-id]');
    if (!button) {
      return;
    }
    const timezoneId = button.dataset.timezoneId ?? '';
    updateTimezoneSelection(timezoneId);
  });
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
document.addEventListener('click', (event) => {
  if (!state.timezonePickerOpen) {
    return;
  }
  if (elements.timezoneSection?.contains(event.target)) {
    return;
  }
  setState({ timezonePickerOpen: false });
});

window.addEventListener('beforeunload', () => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(historyPollTimer);
  stopCountdownLoop();
});
