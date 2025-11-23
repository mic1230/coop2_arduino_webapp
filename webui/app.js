const POLL_INTERVAL_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS;
const HISTORY_POLL_INTERVAL_MS = 15000;
const HISTORY_DISPLAY_LIMIT = 30;
const POWER_SAVE_DEFAULT_SLEEP_SECONDS = 30;
const POWER_SAVE_MIN_SECONDS = 1;
const POWER_SAVE_MAX_SECONDS = 200;
const POWER_SAVE_MIN_AWAKE_SECONDS = 30;
const GEOCODE_DEBOUNCE_MS = 350;
const DEFAULT_LATITUDE = 41.505;
const DEFAULT_LONGITUDE = -81.69;
const DEFAULT_SUNRISE_OFFSET = -15;
const DEFAULT_SUNSET_OFFSET = 30;
const MIN_SUN_OFFSET = -720;
const MAX_SUN_OFFSET = 720;
const STORAGE_KEYS = {
  schedulerCoords: 'coopSchedulerCoords'
};

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
  timezonePickerOpen: false,
  geocodeQuery: '',
  geocodeLoading: false,
  geocodeResults: [],
  geocodeError: '',
  geocodeOpen: false,
  geocodeCountry: 'US',
  geocodeActiveIndex: -1,
  schedulerStatus: null,
  schedulerLoading: false,
  schedulerSaving: false,
  schedulerMessage: '',
  schedulerError: '',
  schedulerForm: {
    enabled: undefined,
    latitude: String(DEFAULT_LATITUDE),
    longitude: String(DEFAULT_LONGITUDE),
    sunriseOffsetMinutes: String(DEFAULT_SUNRISE_OFFSET),
    sunsetOffsetMinutes: String(DEFAULT_SUNSET_OFFSET)
  },
  schedulerDirty: false,
  powerSaving: null,
  powerSavingForm: {
    enabled: false,
    sleepSeconds: String(POWER_SAVE_DEFAULT_SLEEP_SECONDS)
  },
  powerSavingDirty: false,
  powerSavingSaving: false,
  powerSavingMessage: '',
  powerSavingError: '',
  modemSleep: null,
  modemSleepForm: {
    enabled: false
  },
  modemSleepDirty: false,
  modemSleepSaving: false,
  modemSleepMessage: '',
  modemSleepError: '',
  overrideMs: null,
  firmwareInfo: null
};

function supportsLocalStorage() {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch (error) {
    console.warn('Local storage unavailable:', error);
    return false;
  }
}

function loadStoredSchedulerCoords() {
  if (!supportsLocalStorage()) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.schedulerCoords);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const latitude =
      typeof parsed?.latitude === 'number'
        ? String(parsed.latitude)
        : (parsed?.latitude ?? '').toString();
    const longitude =
      typeof parsed?.longitude === 'number'
        ? String(parsed.longitude)
        : (parsed?.longitude ?? '').toString();
    return {
      latitude: latitude || '',
      longitude: longitude || ''
    };
  } catch (error) {
    console.warn('Unable to load cached coordinates:', error);
    return null;
  }
}

function persistSchedulerCoords(coords) {
  if (!supportsLocalStorage()) {
    return;
  }
  try {
    if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      window.localStorage.removeItem(STORAGE_KEYS.schedulerCoords);
      return;
    }
    window.localStorage.setItem(
      STORAGE_KEYS.schedulerCoords,
      JSON.stringify({
        latitude: coords.latitude,
        longitude: coords.longitude
      })
    );
  } catch (error) {
    console.warn('Unable to save cached coordinates:', error);
  }
}

const cachedCoords = loadStoredSchedulerCoords();
if (cachedCoords) {
  if (!state.schedulerForm.latitude) {
    state.schedulerForm.latitude = cachedCoords.latitude;
  }
  if (!state.schedulerForm.longitude) {
    state.schedulerForm.longitude = cachedCoords.longitude;
  }
}

let countdownTimerId = null;
let overrideTimerId = null;
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
  overrideBanner: document.querySelector('[data-override-banner]'),
  overrideCountdown: document.querySelector('[data-override-countdown]'),
  testModeChip: document.querySelector('[data-test-mode]'),
  openButton: document.querySelector('[data-open-btn]'),
  closeButton: document.querySelector('[data-close-btn]'),
  greenhouseTemp: document.querySelector('[data-greenhouse-temp]'),
  greenhouseHumidity: document.querySelector('[data-greenhouse-humidity]'),
  batteryVoltage: document.querySelector('[data-battery-voltage]'),
  wifiValues: document.querySelector('[data-wifi-values]'),
  wifiSsid: document.querySelector('[data-wifi-ssid]'),
  wifiIp: document.querySelector('[data-wifi-ip]'),
  wifiSignal: document.querySelector('[data-wifi-signal]'),
  wifiEmpty: document.querySelector('[data-wifi-empty]'),
  powerCard: document.querySelector('[data-power-card]'),
  powerChip: document.querySelector('[data-power-chip]'),
  powerStatus: document.querySelector('[data-power-status]'),
  powerNext: document.querySelector('[data-power-next]'),
  powerEta: document.querySelector('[data-power-eta]'),
  powerBlockers: document.querySelector('[data-power-blockers]'),
  powerSleepDisplay: document.querySelector('[data-power-sleep-display]'),
  powerForm: document.querySelector('[data-power-form]'),
  powerToggle: document.querySelector('[data-power-toggle]'),
  powerSleepInput: document.querySelector('[data-power-sleep-input]'),
  powerSaveButton: document.querySelector('[data-power-save]'),
  powerResetButton: document.querySelector('[data-power-reset]'),
  powerMessage: document.querySelector('[data-power-message]'),
  powerError: document.querySelector('[data-power-error]'),
  modemToggle: document.querySelector('[data-modem-toggle]'),
  modemSaveButton: document.querySelector('[data-modem-save]'),
  modemResetButton: document.querySelector('[data-modem-reset]'),
  modemMessage: document.querySelector('[data-modem-message]'),
  modemError: document.querySelector('[data-modem-error]'),
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
  timezoneOffset: document.querySelector('[data-timezone-offset]'),
  schedulerCard: document.querySelector('[data-scheduler-card]'),
  schedulerEnabledChip: document.querySelector('[data-scheduler-enabled-chip]'),
  schedulerNextAction: document.querySelector('[data-scheduler-next-action]'),
  schedulerSunriseTime: document.querySelector('[data-scheduler-sunrise-time]'),
  schedulerSunsetTime: document.querySelector('[data-scheduler-sunset-time]'),
  schedulerOpenTime: document.querySelector('[data-scheduler-open-time]'),
  schedulerCloseTime: document.querySelector('[data-scheduler-close-time]'),
  schedulerLastOpen: document.querySelector('[data-scheduler-last-open]'),
  schedulerLastClose: document.querySelector('[data-scheduler-last-close]'),
  schedulerMessage: document.querySelector('[data-scheduler-message]'),
  schedulerError: document.querySelector('[data-scheduler-error]'),
  schedulerForm: document.querySelector('[data-scheduler-form]'),
  schedulerEnabledSelect: document.querySelector('[data-scheduler-enabled-select]'),
  schedulerLatitudeInput: document.querySelector('[data-scheduler-latitude-input]'),
  schedulerLongitudeInput: document.querySelector('[data-scheduler-longitude-input]'),
  schedulerSunriseOffsetInput: document.querySelector('[data-scheduler-sunrise-offset-input]'),
  schedulerSunsetOffsetInput: document.querySelector('[data-scheduler-sunset-offset-input]'),
  schedulerSaveButton: document.querySelector('[data-scheduler-save]'),
  schedulerRefreshButton: document.querySelector('[data-scheduler-refresh]'),
  geoInput: document.querySelector('[data-geo-input]'),
  geoSuggest: document.querySelector('[data-geo-suggest]'),
  geoCountry: document.querySelector('[data-geo-country]')
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

function powerSavingStatus() {
  return state.powerSaving ?? state.status?.powerSaving ?? null;
}

function modemSleepStatus() {
  return state.modemSleep ?? state.status?.modemSleep ?? null;
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
  const showOverride = typeof state.overrideMs === 'number' && state.overrideMs > 0;
  if (elements.overrideBanner) {
    elements.overrideBanner.hidden = !showOverride;
  }
  if (showOverride && elements.overrideCountdown) {
    elements.overrideCountdown.textContent = formatOverrideCountdown(state.overrideMs);
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

  if (elements.greenhouseTemp) {
    elements.greenhouseTemp.textContent = formatTemp(state.status?.sensors?.greenhouseTempC);
  }
  if (elements.greenhouseHumidity) {
    elements.greenhouseHumidity.textContent = formatHumidity(
      state.status?.sensors?.greenhouseHumidityPct
    );
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

  const schedulerForm = state.schedulerForm ?? {};
  const schedulerLocked = !settingsActive || state.schedulerLoading;
  if (elements.schedulerEnabledSelect) {
    const selectEmpty = schedulerForm.enabled === undefined || schedulerForm.enabled === null;
    elements.schedulerEnabledSelect.value = selectEmpty ? '' : (schedulerForm.enabled ? 'true' : 'false');
    elements.schedulerEnabledSelect.classList.toggle('empty', selectEmpty);
    elements.schedulerEnabledSelect.disabled = schedulerLocked;
  }
  if (elements.schedulerLatitudeInput) {
    elements.schedulerLatitudeInput.value =
      schedulerForm.latitude == null ? '' : String(schedulerForm.latitude);
    elements.schedulerLatitudeInput.disabled = schedulerLocked;
  }
  if (elements.schedulerLongitudeInput) {
    elements.schedulerLongitudeInput.value =
      schedulerForm.longitude == null ? '' : String(schedulerForm.longitude);
    elements.schedulerLongitudeInput.disabled = schedulerLocked;
  }
  if (elements.schedulerSunriseOffsetInput) {
    elements.schedulerSunriseOffsetInput.value =
      schedulerForm.sunriseOffsetMinutes == null ? '' : String(schedulerForm.sunriseOffsetMinutes);
    elements.schedulerSunriseOffsetInput.disabled = schedulerLocked;
  }
  if (elements.schedulerSunsetOffsetInput) {
    elements.schedulerSunsetOffsetInput.value =
      schedulerForm.sunsetOffsetMinutes == null ? '' : String(schedulerForm.sunsetOffsetMinutes);
    elements.schedulerSunsetOffsetInput.disabled = schedulerLocked;
  }
  if (elements.geoInput) {
    elements.geoInput.value = state.geocodeQuery ?? '';
    elements.geoInput.disabled = schedulerLocked;
  }
  if (elements.geoCountry) {
    elements.geoCountry.value = state.geocodeCountry || '';
    elements.geoCountry.disabled = schedulerLocked;
  }
  if (elements.schedulerSaveButton) {
    const canSave =
      settingsActive && state.schedulerDirty && !state.schedulerSaving && !state.schedulerLoading;
    elements.schedulerSaveButton.disabled = !canSave;
    elements.schedulerSaveButton.textContent = state.schedulerSaving ? 'Saving...' : 'Save schedule';
  }
  if (elements.schedulerRefreshButton) {
    elements.schedulerRefreshButton.disabled = state.schedulerLoading;
  }

  renderPowerSavingCard();
  renderModemSleep();
  renderWifiScanResults();
  renderDoorHistory();
  renderTimezonePicker();
  renderSchedulerPanel();
  renderGeoSuggest();
}

function renderPowerSavingCard() {
  if (!elements.powerCard) {
    return;
  }
  const settingsActive = state.activeTab === 'settings';
  elements.powerCard.hidden = !settingsActive || !state.initialized;
  if (!settingsActive || !state.initialized) {
    return;
  }
  const status = powerSavingStatus();
  const form = state.powerSavingForm ?? {};
  const minSleep = status?.minSleepSeconds ?? POWER_SAVE_MIN_SECONDS;
  const maxSleep = status?.maxSleepSeconds ?? POWER_SAVE_MAX_SECONDS;
  const minAwake = status?.minAwakeSeconds ?? POWER_SAVE_MIN_AWAKE_SECONDS;
  const formHasEnabled = form.enabled !== undefined && form.enabled !== null;
  const enabledFromForm = formHasEnabled
    ? form.enabled === true || form.enabled === 'true' || form.enabled === 1 || form.enabled === '1'
    : null;
  const enabled = enabledFromForm != null ? enabledFromForm : Boolean(status?.enabled);
  const sleepValue =
    form.sleepSeconds ??
    (status?.sleepSeconds != null ? String(status.sleepSeconds) : String(POWER_SAVE_DEFAULT_SLEEP_SECONDS));
  const sleepSeconds = parseInt(sleepValue, 10);
  const validSleep =
    Number.isFinite(sleepSeconds) && sleepSeconds >= minSleep && sleepSeconds <= maxSleep;
  const blockers = Array.isArray(status?.blockers) ? status.blockers : [];
  const blockersText = formatPowerBlockers(blockers);
  const secondsUntilSleep =
    typeof status?.secondsUntilSleep === 'number' ? status.secondsUntilSleep : null;
  const hasBlockers = enabled && blockers.length > 0;
  const ready = enabled && status?.ready && !hasBlockers && (secondsUntilSleep == null || secondsUntilSleep === 0);

  if (elements.powerChip) {
    elements.powerChip.className = enabled ? 'chip success' : 'chip danger';
    elements.powerChip.textContent = enabled ? 'On' : 'Off';
  }
  if (elements.powerStatus) {
    elements.powerStatus.textContent = enabled ? 'Enabled' : 'Disabled';
  }
  if (elements.powerSleepDisplay) {
    elements.powerSleepDisplay.textContent = validSleep ? `${sleepSeconds}s` : '--';
  }

  let nextText = '--';
  if (!enabled) {
    nextText = 'Disabled';
  } else if (hasBlockers) {
    nextText = 'Waiting';
  } else if (secondsUntilSleep == null) {
    nextText = 'Waiting';
  } else if (secondsUntilSleep <= 0) {
    nextText = 'Ready to sleep';
  } else {
    nextText = `Sleeping in ${formatSecondsShort(secondsUntilSleep)}`;
  }
  if (elements.powerNext) {
    elements.powerNext.textContent = nextText;
  }

  let etaText = '';
  if (enabled) {
    if (secondsUntilSleep != null && secondsUntilSleep > 0) {
      etaText = `Minimum awake time left: ${formatSecondsShort(secondsUntilSleep)}.`;
    } else if (ready) {
      etaText = 'Device will deep sleep when idle.';
    } else if (!hasBlockers && secondsUntilSleep == null) {
      etaText = `Awake at least ${minAwake}s each cycle.`;
    }
  } else {
    etaText = 'Deep sleep is disabled.';
  }
  if (elements.powerEta) {
    elements.powerEta.textContent = etaText || '--';
  }
  if (elements.powerBlockers) {
    const showBlockers = enabled && blockersText;
    elements.powerBlockers.hidden = !showBlockers;
    if (showBlockers) {
      elements.powerBlockers.textContent = blockersText;
    }
  }

  const locked = state.powerSavingSaving;
  if (elements.powerToggle) {
    elements.powerToggle.checked = Boolean(enabled);
    elements.powerToggle.disabled = locked;
  }
  if (elements.powerSleepInput) {
    elements.powerSleepInput.value = sleepValue ?? '';
    elements.powerSleepInput.disabled = locked;
    elements.powerSleepInput.min = String(minSleep);
    elements.powerSleepInput.max = String(maxSleep);
  }
  if (elements.powerSaveButton) {
    const canSave = !locked && state.powerSavingDirty && validSleep;
    elements.powerSaveButton.disabled = !canSave;
    elements.powerSaveButton.textContent = state.powerSavingSaving ? 'Saving...' : 'Save power settings';
  }
  if (elements.powerResetButton) {
    elements.powerResetButton.disabled = locked || !state.powerSavingDirty;
  }
  if (elements.powerMessage) {
    const showMessage = Boolean(state.powerSavingMessage);
    elements.powerMessage.hidden = !showMessage;
    if (showMessage) {
      elements.powerMessage.textContent = state.powerSavingMessage;
    }
  }
  if (elements.powerError) {
    const showError = Boolean(state.powerSavingError);
    elements.powerError.hidden = !showError;
    if (showError) {
      elements.powerError.textContent = state.powerSavingError;
    }
  }
}

function renderModemSleep() {
  if (!elements.powerCard) {
    return;
  }
  const settingsActive = state.activeTab === 'settings';
  const status = normalizeModemSleepStatus(modemSleepStatus());
  const form = state.modemSleepForm ?? {};
  const locked = state.modemSleepSaving;
  const formEnabled = form.enabled === true || form.enabled === 'true';
  const enabled = form.hasOwnProperty('enabled')
    ? formEnabled
    : status?.enabled ?? false;

  if (elements.modemToggle) {
    elements.modemToggle.checked = enabled;
    elements.modemToggle.disabled = locked;
  }
  if (elements.modemSaveButton) {
    const canSave = !locked && state.modemSleepDirty;
    elements.modemSaveButton.disabled = !canSave || !settingsActive;
    elements.modemSaveButton.textContent = locked ? 'Saving...' : 'Save modem sleep';
  }
  if (elements.modemResetButton) {
    elements.modemResetButton.disabled = locked || !state.modemSleepDirty;
  }
  if (elements.modemMessage) {
    const showMessage = Boolean(state.modemSleepMessage);
    elements.modemMessage.hidden = !showMessage;
    if (showMessage) {
      elements.modemMessage.textContent = state.modemSleepMessage;
    }
  }
  if (elements.modemError) {
    const showError = Boolean(state.modemSleepError);
    elements.modemError.hidden = !showError;
    if (showError) {
      elements.modemError.textContent = state.modemSleepError;
    }
  }
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
        <td>${formatTemp(entry.greenhouseTempC)}</td>
        <td>${formatHumidity(entry.greenhouseHumidityPct)}</td>
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

function renderSchedulerPanel() {
  if (!elements.schedulerCard) {
    return;
  }
  const settingsActive = state.activeTab === 'settings';
  elements.schedulerCard.hidden = !settingsActive;
  if (!settingsActive) {
    return;
  }
  const schedulerData = state.schedulerStatus ?? state.status?.scheduler ?? null;
  const formEnabled = state.schedulerForm?.enabled;
  const enabled =
    schedulerData?.enabled ??
    (formEnabled === true || formEnabled === 'true');
  if (elements.schedulerEnabledChip) {
    elements.schedulerEnabledChip.textContent = enabled ? 'Automation enabled' : 'Automation disabled';
    elements.schedulerEnabledChip.className = `automation-status ${enabled ? 'enabled' : 'disabled'}`;
  }
  if (elements.schedulerNextAction) {
    if (state.schedulerLoading) {
      elements.schedulerNextAction.textContent = 'Calculating schedule...';
    } else if (schedulerData?.nextAction && schedulerData?.nextActionTime) {
      const action = schedulerData.nextAction === 'close' ? 'Close' : 'Open';
      elements.schedulerNextAction.textContent =
        `${action} at ${formatSchedulerTime(schedulerData.nextActionTime)}`;
    } else {
      elements.schedulerNextAction.textContent =
        'No automation events scheduled for the remainder of today.';
    }
  }
  if (elements.schedulerSunriseTime) {
    elements.schedulerSunriseTime.textContent = formatSchedulerTime(schedulerData?.sunriseTime);
  }
  if (elements.schedulerSunsetTime) {
    elements.schedulerSunsetTime.textContent = formatSchedulerTime(schedulerData?.sunsetTime);
  }
  if (elements.schedulerOpenTime) {
    elements.schedulerOpenTime.textContent = formatSchedulerTime(schedulerData?.sunriseActionTime);
  }
  if (elements.schedulerCloseTime) {
    elements.schedulerCloseTime.textContent = formatSchedulerTime(schedulerData?.sunsetActionTime);
  }
  if (elements.schedulerLastOpen) {
    elements.schedulerLastOpen.textContent = formatSchedulerDateTime(schedulerData?.lastOpenAction);
  }
  if (elements.schedulerLastClose) {
    elements.schedulerLastClose.textContent = formatSchedulerDateTime(schedulerData?.lastCloseAction);
  }
  if (elements.schedulerMessage) {
    const showMessage = Boolean(state.schedulerMessage);
    elements.schedulerMessage.hidden = !showMessage;
    if (showMessage) {
      elements.schedulerMessage.textContent = state.schedulerMessage;
    }
  }
  if (elements.schedulerError) {
    const errorText = state.schedulerError || (state.schedulerLoading ? 'Loading schedule...' : '');
    const showError = Boolean(errorText);
    elements.schedulerError.hidden = !showError;
    if (showError) {
      elements.schedulerError.textContent = errorText;
    }
  }
}

function renderGeoSuggest() {
  if (!elements.geoSuggest) {
    return;
  }
  const settingsActive = state.activeTab === 'settings';
  if (!settingsActive) {
    elements.geoSuggest.hidden = true;
    elements.geoSuggest.innerHTML = '';
    return;
  }
  const container = elements.geoSuggest;
  const query = (state.geocodeQuery || '').trim();
  const open = state.geocodeOpen && query.length >= 2;
  if (!open) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  if (state.geocodeLoading) {
    container.innerHTML = '<div class="loading">Searching...</div>';
    return;
  }
  const results = Array.isArray(state.geocodeResults) ? state.geocodeResults : [];
  if (!results.length) {
    const message = state.geocodeError || 'No matches found.';
    container.innerHTML = `<div class="empty">${message}</div>`;
    return;
  }
  let activeIndex = typeof state.geocodeActiveIndex === 'number' ? state.geocodeActiveIndex : -1;
  if (activeIndex < 0) {
    activeIndex = 0;
  } else if (activeIndex >= results.length) {
    activeIndex = results.length - 1;
  }
  const items = results.map((place, idx) => {
    const parts = [place.name, place.admin1, place.country].filter(Boolean);
    const label = parts.join(', ');
    const lat = typeof place.latitude === 'number' ? place.latitude.toFixed(5) : '';
    const lon = typeof place.longitude === 'number' ? place.longitude.toFixed(5) : '';
    const classes = idx === activeIndex ? 'item active' : 'item';
    return `<div class="${classes}" data-geo-item data-geo-idx="${idx}" data-lat="${lat}" data-lon="${lon}" data-label="${label}">${label} — ${lat}, ${lon}</div>`;
  }).join('');
  container.innerHTML = items;
}

let geocodeTimerId = null;
async function fetchGeocodeSuggestions(query) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) {
    setState({
      geocodeLoading: false,
      geocodeResults: [],
      geocodeError: '',
      geocodeActiveIndex: -1
    });
    return;
  }
  setState({ geocodeLoading: true, geocodeError: '' });
  try {
    let url =
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=8&language=en&format=json`;
    const country = (state.geocodeCountry || '').trim();
    if (country) {
      url += `&country=${encodeURIComponent(country)}`;
    }
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json();
    const results = Array.isArray(body?.results) ? body.results : [];
    setState({
      geocodeLoading: false,
      geocodeResults: results,
      geocodeError: '',
      geocodeActiveIndex: results.length ? 0 : -1
    });
  } catch (error) {
    console.error(error);
    setState({
      geocodeLoading: false,
      geocodeResults: [],
      geocodeError: 'Unable to load suggestions.',
      geocodeActiveIndex: -1
    });
  }
}

function formatCurrentTime(date) {
  return date ? date.toLocaleTimeString() : '--';
}

function formatOverrideCountdown(ms) {
  if (ms == null) {
    return '--:--';
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
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

function formatHumidity(value) {
  return value == null ? '--' : `${Number(value).toFixed(1)}%`;
}

function formatVoltage(value) {
  return value == null ? '--' : `${Number(value).toFixed(2)} V`;
}

function formatRssi(value) {
  return value == null ? '--' : `${value} dBm`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let bytes = value;
  let unitIndex = 0;
  while (bytes >= 1024 && unitIndex < units.length - 1) {
    bytes /= 1024;
    unitIndex += 1;
  }
  const decimals = bytes >= 100 || unitIndex === 0 ? 0 : 1;
  return `${bytes.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatSchedulerTime(value) {
  if (typeof value !== 'number' || value <= 0) {
    return '--';
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSchedulerDateTime(value) {
  if (typeof value !== 'number' || value <= 0) {
    return '--';
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

function normalizePowerSavingStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const toNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const minSleep = toNumber(payload.minSleepSeconds) ?? POWER_SAVE_MIN_SECONDS;
  const maxSleep = toNumber(payload.maxSleepSeconds) ?? POWER_SAVE_MAX_SECONDS;
  const minAwake = toNumber(payload.minAwakeSeconds) ?? POWER_SAVE_MIN_AWAKE_SECONDS;
  let sleepSeconds = toNumber(payload.sleepSeconds) ?? POWER_SAVE_DEFAULT_SLEEP_SECONDS;
  sleepSeconds = Math.min(Math.max(sleepSeconds, minSleep), maxSleep);
  const secondsUntilSleepRaw = toNumber(payload.secondsUntilSleep);
  const secondsUntilSleep =
    secondsUntilSleepRaw != null ? Math.max(0, secondsUntilSleepRaw) : null;
  const uptimeSeconds = toNumber(payload.uptimeSeconds);
  return {
    enabled: payload.enabled === true || payload.enabled === 'true',
    sleepSeconds,
    minSleepSeconds: minSleep,
    maxSleepSeconds: maxSleep,
    minAwakeSeconds: minAwake,
    secondsUntilSleep,
    uptimeSeconds,
    ready: payload.ready === true,
    blockers: Array.isArray(payload.blockers) ? payload.blockers : []
  };
}

function normalizeModemSleepStatus(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  return {
    enabled: payload.enabled === true || payload.enabled === 'true'
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

function formatSecondsShort(seconds) {
  if (!Number.isFinite(seconds)) {
    return '--';
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  return `${Math.max(0, Math.round(seconds))}s`;
}

function formatPowerBlockers(blockers) {
  if (!Array.isArray(blockers) || !blockers.length) {
    return '';
  }
  const labels = {
    door_motion: 'Door motion',
    config_portal: 'Wi-Fi setup portal',
    user_activity: 'Active web session'
  };
  const parts = blockers.map((entry) => labels[entry] ?? entry?.toString()?.replace(/_/g, ' '));
  return `Blocked by ${parts.join(', ')}`;
}

async function fetchDoorHistory() {
  const requestId = ++latestHistoryRequestId;
  try {
    const response = await fetch(buildEndpoint('/api/history'), { cache: 'no-cache' });
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
    const response = await fetch(buildEndpoint('/api/timezone'), { cache: 'no-cache' });
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
      cache: 'no-cache'
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

function applySchedulerConfig(payload, options = {}) {
  const nextState = {
    schedulerLoading: false,
    schedulerError: '',
    schedulerStatus: payload
  };
  const shouldUpdateForm = !state.schedulerDirty || options.forceFormUpdate;
  if (shouldUpdateForm) {
    nextState.schedulerForm = {
      enabled: undefined,
      latitude: payload?.latitude == null ? '' : String(payload.latitude),
      longitude: payload?.longitude == null ? '' : String(payload.longitude),
      sunriseOffsetMinutes:
        payload?.sunriseOffsetMinutes == null ? '' : String(payload.sunriseOffsetMinutes),
      sunsetOffsetMinutes:
        payload?.sunsetOffsetMinutes == null ? '' : String(payload.sunsetOffsetMinutes)
    };
    nextState.schedulerDirty = false;
  }
  if (state.status) {
    nextState.status = { ...state.status, scheduler: payload };
  }
  setState(nextState);
  const persistedLat = Number(payload?.latitude);
  const persistedLon = Number(payload?.longitude);
  if (Number.isFinite(persistedLat) && Number.isFinite(persistedLon)) {
    persistSchedulerCoords({ latitude: persistedLat, longitude: persistedLon });
  }
  syncOverrideCountdownFromStatus(payload?.override);
}

async function fetchSchedulerConfig(force = false) {
  if (state.schedulerLoading && !force) {
    return;
  }
  setState({
    schedulerLoading: true,
    schedulerError: '',
    schedulerMessage: ''
  });
  try {
    const response = await fetch(buildEndpoint('/api/schedule'), { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Schedule request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    applySchedulerConfig(payload);
  } catch (error) {
    console.error(error);
    setState({
      schedulerLoading: false,
      schedulerError: error?.message ?? 'Unable to load schedule.'
    });
  }
}

function updateSchedulerFormField(field, value) {
  setState({
    schedulerForm: { ...state.schedulerForm, [field]: value },
    schedulerDirty: true,
    schedulerMessage: '',
    schedulerError: ''
  });
}

function buildSchedulerPayload() {
  const form = state.schedulerForm ?? {};
  const formEnabledValue = form.enabled;
  const enabled =
    formEnabledValue === undefined ||
    formEnabledValue === null ||
    formEnabledValue === ''
      ? Boolean(state.schedulerStatus?.enabled)
      : formEnabledValue === true || formEnabledValue === 'true';
  const latitude = parseFloat(form.latitude);
  const longitude = parseFloat(form.longitude);
  const sunriseOffset = parseInt(form.sunriseOffsetMinutes, 10);
  const sunsetOffset = parseInt(form.sunsetOffsetMinutes, 10);
  return {
    enabled,
    latitude,
    longitude,
    sunriseOffsetMinutes: sunriseOffset,
    sunsetOffsetMinutes: sunsetOffset
  };
}

function validateSchedulerPayload(payload) {
  if (!Number.isFinite(payload.latitude) || payload.latitude < -89 || payload.latitude > 89) {
    throw new Error('Latitude must be between -89 and 89 degrees.');
  }
  if (!Number.isFinite(payload.longitude) || payload.longitude < -180 || payload.longitude > 180) {
    throw new Error('Longitude must be between -180 and 180 degrees.');
  }
  if (!Number.isFinite(payload.sunriseOffsetMinutes) ||
      payload.sunriseOffsetMinutes < MIN_SUN_OFFSET ||
      payload.sunriseOffsetMinutes > MAX_SUN_OFFSET) {
    throw new Error('Sunrise offset must stay within ±12 hours.');
  }
  if (!Number.isFinite(payload.sunsetOffsetMinutes) ||
      payload.sunsetOffsetMinutes < MIN_SUN_OFFSET ||
      payload.sunsetOffsetMinutes > MAX_SUN_OFFSET) {
    throw new Error('Sunset offset must stay within ±12 hours.');
  }
}

async function handleSchedulerSubmit(event) {
  if (event) {
    event.preventDefault();
  }
  if (state.schedulerSaving || state.schedulerLoading) {
    return;
  }
  let payload;
  try {
    payload = buildSchedulerPayload();
    validateSchedulerPayload(payload);
  } catch (validationError) {
    setState({ schedulerError: validationError.message });
    return;
  }
  setState({ schedulerSaving: true, schedulerError: '', schedulerMessage: '' });
  try {
    const response = await fetch(buildEndpoint('/api/schedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-cache'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error ?? `Schedule update failed with HTTP ${response.status}`);
    }
    applySchedulerConfig(body, { forceFormUpdate: true });
    setState({
      schedulerSaving: false,
      schedulerDirty: false,
      schedulerMessage: 'Schedule updated.'
    });
  } catch (error) {
    console.error(error);
    setState({
      schedulerSaving: false,
      schedulerError: error?.message ?? 'Unable to update schedule.'
    });
  }
}

function activateTab(tabName) {
  if (state.activeTab === tabName) {
    return;
  }
  const nextState = { activeTab: tabName };
  if (tabName !== 'settings') {
    nextState.wifiScanRequested = false;
    nextState.timezonePickerOpen = false;
    nextState.geocodeOpen = false;
  }
  setState(nextState);
  if (tabName === 'settings' && !state.wifiConfig && !state.wifiConfigLoading) {
    fetchWifiConfig();
  }
  if (tabName === 'settings' && !state.timezoneConfig && !state.timezoneLoading) {
    fetchTimezoneConfig();
  }
  if (tabName === 'settings' && !state.schedulerStatus && !state.schedulerLoading) {
    fetchSchedulerConfig();
  }
}

async function fetchWifiConfig() {
  if (state.wifiConfigLoading) {
    return;
  }
  setState({ wifiConfigLoading: true, wifiMessage: '', wifiMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/wifi/config'), { cache: 'no-cache' });
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
      cache: 'no-cache'
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
    const response = await fetch(buildEndpoint('/api/wifi/scan'), { cache: 'no-cache' });
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
  const incomingPower = normalizePowerSavingStatus(payload?.powerSaving);
  const normalizedPower = incomingPower ?? normalizePowerSavingStatus(state.powerSaving);
  const incomingModem = normalizeModemSleepStatus(payload?.modemSleep);
  const normalizedModem = incomingModem ?? normalizeModemSleepStatus(state.modemSleep);
  const mergedStatus = { ...payload };
  if (normalizedPower) {
    mergedStatus.powerSaving = normalizedPower;
  } else if (state.powerSaving) {
    mergedStatus.powerSaving = state.powerSaving;
  }
  if (normalizedModem) {
    mergedStatus.modemSleep = normalizedModem;
  } else if (state.modemSleep) {
    mergedStatus.modemSleep = state.modemSleep;
  }
  const shouldSyncPowerForm = !state.powerSavingDirty && normalizedPower;
  const nextPowerForm = shouldSyncPowerForm
    ? {
        enabled: normalizedPower?.enabled ?? false,
        sleepSeconds:
          normalizedPower?.sleepSeconds != null
            ? String(normalizedPower.sleepSeconds)
            : state.powerSavingForm?.sleepSeconds ?? String(POWER_SAVE_DEFAULT_SLEEP_SECONDS)
      }
    : state.powerSavingForm ?? {
        enabled: normalizedPower?.enabled ?? false,
        sleepSeconds: normalizedPower?.sleepSeconds != null
          ? String(normalizedPower.sleepSeconds)
          : String(POWER_SAVE_DEFAULT_SLEEP_SECONDS)
      };
  const shouldSyncModemForm = !state.modemSleepDirty && normalizedModem;
  const nextModemForm = shouldSyncModemForm
    ? { enabled: normalizedModem?.enabled ?? false }
    : state.modemSleepForm ?? { enabled: normalizedModem?.enabled ?? false };
  setState({
    status: mergedStatus,
    powerSaving: normalizedPower ?? state.powerSaving,
    powerSavingForm: nextPowerForm,
    powerSavingDirty: shouldSyncPowerForm ? false : state.powerSavingDirty,
    modemSleep: normalizedModem ?? state.modemSleep,
    modemSleepForm: nextModemForm,
    modemSleepDirty: shouldSyncModemForm ? false : state.modemSleepDirty,
    schedulerStatus: payload?.scheduler ?? state.schedulerStatus,
    lastUpdated: new Date(),
    initialized: true
  });
  syncCountdownFromStatus();
  syncOverrideCountdownFromStatus(payload?.scheduler?.override);
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

function syncOverrideCountdownFromStatus(overrideSource) {
  const overrideData =
    overrideSource ??
    state.status?.scheduler?.override ??
    state.schedulerStatus?.override;
  if (overrideData?.active && Number.isFinite(overrideData.remainingSeconds)) {
    const ms = Math.max(0, overrideData.remainingSeconds * 1000);
    setState({ overrideMs: ms });
    startOverrideCountdownLoop();
  } else {
    if (state.overrideMs != null) {
      setState({ overrideMs: null });
    }
    stopOverrideCountdownLoop();
  }
}

function startOverrideCountdownLoop() {
  if (overrideTimerId) {
    return;
  }
  overrideTimerId = setInterval(() => {
    if (state.overrideMs == null) {
      stopOverrideCountdownLoop();
      return;
    }
    const nextValue = Math.max(0, state.overrideMs - 1000);
    setState({ overrideMs: nextValue });
    if (nextValue === 0) {
      stopOverrideCountdownLoop();
    }
  }, 1000);
}

function stopOverrideCountdownLoop() {
  if (overrideTimerId) {
    clearInterval(overrideTimerId);
    overrideTimerId = null;
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
    const response = await fetch(buildEndpoint('/api/status'), { cache: 'no-cache' });
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
      cache: 'no-cache'
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
fetchFirmwareStatus(true);

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
if (elements.powerForm) {
  elements.powerForm.addEventListener('submit', handlePowerFormSubmit);
}
if (elements.powerToggle) {
  elements.powerToggle.addEventListener('change', (event) => {
    updatePowerFormField('enabled', event.target.checked);
  });
}
if (elements.powerSleepInput) {
  elements.powerSleepInput.addEventListener('input', (event) => {
    updatePowerFormField('sleepSeconds', event.target.value);
  });
}
if (elements.powerResetButton) {
  elements.powerResetButton.addEventListener('click', resetPowerForm);
}
if (elements.modemSaveButton) {
  elements.modemSaveButton.addEventListener('click', handleModemFormSubmit);
}
if (elements.modemToggle) {
  elements.modemToggle.addEventListener('change', (event) => {
    updateModemFormField(event.target.checked);
  });
}
if (elements.modemResetButton) {
  elements.modemResetButton.addEventListener('click', resetModemForm);
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
if (elements.schedulerForm) {
  elements.schedulerForm.addEventListener('submit', handleSchedulerSubmit);
}
if (elements.schedulerEnabledSelect) {
  elements.schedulerEnabledSelect.addEventListener('change', (event) => {
    const value = event.target.value;
    if (!value) {
      updateSchedulerFormField('enabled', undefined);
      return;
    }
    const enabled = value === 'true';
    updateSchedulerFormField('enabled', enabled);
  });
}
if (elements.schedulerLatitudeInput) {
  elements.schedulerLatitudeInput.addEventListener('input', (event) => {
    updateSchedulerFormField('latitude', event.target.value);
  });
}
if (elements.schedulerLongitudeInput) {
  elements.schedulerLongitudeInput.addEventListener('input', (event) => {
    updateSchedulerFormField('longitude', event.target.value);
  });
}
if (elements.schedulerSunriseOffsetInput) {
  elements.schedulerSunriseOffsetInput.addEventListener('input', (event) => {
    updateSchedulerFormField('sunriseOffsetMinutes', event.target.value);
  });
}
if (elements.schedulerSunsetOffsetInput) {
  elements.schedulerSunsetOffsetInput.addEventListener('input', (event) => {
    updateSchedulerFormField('sunsetOffsetMinutes', event.target.value);
  });
}
if (elements.schedulerRefreshButton) {
  elements.schedulerRefreshButton.addEventListener('click', () => fetchSchedulerConfig(true));
}

if (elements.geoInput) {
  elements.geoInput.addEventListener('input', (event) => {
    const value = event.target.value || '';
    const trimmed = value.trim();
    setState({
      geocodeQuery: value,
      geocodeOpen: trimmed.length > 0,
      geocodeActiveIndex: -1
    });
    if (geocodeTimerId) {
      clearTimeout(geocodeTimerId);
      geocodeTimerId = null;
    }
    if (trimmed.length < 2) {
      setState({
        geocodeResults: [],
        geocodeError: '',
        geocodeLoading: false,
        geocodeActiveIndex: -1
      });
      return;
    }
    geocodeTimerId = setTimeout(() => {
      fetchGeocodeSuggestions(value);
    }, GEOCODE_DEBOUNCE_MS);
  });

  elements.geoInput.addEventListener('keydown', (event) => {
    if (!state.geocodeOpen) {
      return;
    }
    const results = Array.isArray(state.geocodeResults) ? state.geocodeResults : [];
    if (!results.length) {
      return;
    }
    let idx = typeof state.geocodeActiveIndex === 'number' ? state.geocodeActiveIndex : -1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      idx = Math.min(results.length - 1, idx < 0 ? 0 : idx + 1);
      setState({ geocodeActiveIndex: idx });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      idx = Math.max(0, idx < 0 ? results.length - 1 : idx - 1);
      setState({ geocodeActiveIndex: idx });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      idx = Math.max(0, Math.min(idx < 0 ? 0 : idx, results.length - 1));
      const choice = results[idx];
      if (choice) {
        const lat = typeof choice.latitude === 'number' ? choice.latitude.toFixed(5) : '';
        const lon = typeof choice.longitude === 'number' ? choice.longitude.toFixed(5) : '';
        const label = [choice.name, choice.admin1, choice.country].filter(Boolean).join(', ');
        updateSchedulerFormField('latitude', lat);
        updateSchedulerFormField('longitude', lon);
        if (elements.geoInput) {
          elements.geoInput.value = label;
        }
        setState({
          geocodeOpen: false,
          geocodeActiveIndex: -1,
          geocodeQuery: label
        });
      }
      return;
    }
    if (event.key === 'Escape') {
      setState({ geocodeOpen: false, geocodeActiveIndex: -1 });
    }
  });
}

if (elements.geoSuggest) {
  elements.geoSuggest.addEventListener('click', (event) => {
    const item = event.target.closest('[data-geo-item]');
    if (!item) {
      return;
    }
    const lat = item.getAttribute('data-lat') || '';
    const lon = item.getAttribute('data-lon') || '';
    const label = item.getAttribute('data-label') || '';
    if (lat) {
      updateSchedulerFormField('latitude', lat);
    }
    if (lon) {
      updateSchedulerFormField('longitude', lon);
    }
    if (elements.geoInput) {
      elements.geoInput.value = label;
    }
    setState({
      geocodeOpen: false,
      geocodeActiveIndex: -1,
      geocodeQuery: label
    });
  });
}

if (elements.geoCountry) {
  elements.geoCountry.addEventListener('change', (event) => {
    const country = (event.target.value || '').trim();
    setState({ geocodeCountry: country });
    const query = (state.geocodeQuery || '').trim();
    if (query.length >= 2) {
      fetchGeocodeSuggestions(query);
    }
  });
}

document.addEventListener('click', (event) => {
  const nextPatch = {};
  if (state.timezonePickerOpen && !elements.timezoneSection?.contains(event.target)) {
    nextPatch.timezonePickerOpen = false;
  }
  if (state.geocodeOpen) {
    const geoContainer = elements.geoInput?.closest('.geo-controls');
    if (geoContainer && !geoContainer.contains(event.target)) {
      nextPatch.geocodeOpen = false;
      nextPatch.geocodeActiveIndex = -1;
    }
  }
  if (Object.keys(nextPatch).length > 0) {
    setState(nextPatch);
  }
});

window.addEventListener('beforeunload', () => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(historyPollTimer);
  stopCountdownLoop();
  stopOverrideCountdownLoop();
});
