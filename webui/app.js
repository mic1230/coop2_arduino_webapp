const POLL_INTERVAL_MS = 5000;
const COUNTDOWN_TICK_MS = 250;
const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
const DEFAULT_DOOR_TRAVEL_TIME_SECONDS = DEFAULT_DOOR_TRAVEL_TIME_MS / 1000;
const MIN_DOOR_TRAVEL_TIME_SECONDS = 1;
const MAX_DOOR_TRAVEL_TIME_SECONDS = 600;
const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS;
const HISTORY_POLL_INTERVAL_MS = 15000;
const HISTORY_DISPLAY_LIMIT = 30;
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
  overrideMs: null,
  pinConfig: null,
  pinForm: {
    openPin: '',
    closePin: '',
    sensorPin: '',
    travelTimeSeconds: String(DEFAULT_DOOR_TRAVEL_TIME_SECONDS)
  },
  pinFormDirty: false,
  pinAvailablePins: [],
  pinLoading: false,
  pinSaving: false,
  pinMessage: '',
  pinMessageType: '',
  firmwareInfo: null,
  otaStatus: null,
  otaStatusLoading: false,
  otaUploading: false,
  otaUploadProgressBytes: 0,
  otaUploadProgressTotal: 0,
  otaMessage: '',
  otaMessageType: '',
  otaSelectedFileName: '',
  otaSelectedFileSize: 0
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
  timezoneOffset: document.querySelector('[data-timezone-offset]'),
  pinForm: document.querySelector('[data-pin-form]'),
  pinOpenInput: document.querySelector('[data-pin-open-input]'),
  pinCloseInput: document.querySelector('[data-pin-close-input]'),
  pinSensorInput: document.querySelector('[data-pin-sensor-input]'),
  pinTravelTimeInput: document.querySelector('[data-pin-travel-time-input]'),
  pinSubmitButton: document.querySelector('[data-pin-submit]'),
  pinMessage: document.querySelector('[data-pin-message]'),
  pinAvailableList: document.querySelector('[data-pin-available-list]'),
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
  geoCountry: document.querySelector('[data-geo-country]'),
  firmwareCard: document.querySelector('[data-firmware-card]'),
  firmwareDevice: document.querySelector('[data-firmware-device]'),
  firmwareBuild: document.querySelector('[data-firmware-build]'),
  firmwareSketch: document.querySelector('[data-firmware-sketch]'),
  firmwareSpace: document.querySelector('[data-firmware-space]'),
  firmwarePartition: document.querySelector('[data-firmware-partition]'),
  firmwareNext: document.querySelector('[data-firmware-next]'),
  firmwareHash: document.querySelector('[data-firmware-hash]'),
  otaStatusChip: document.querySelector('[data-ota-status-chip]'),
  otaForm: document.querySelector('[data-ota-form]'),
  otaFileInput: document.querySelector('[data-ota-file]'),
  otaFileMeta: document.querySelector('[data-ota-file-meta]'),
  otaUploadButton: document.querySelector('[data-ota-upload]'),
  otaClearButton: document.querySelector('[data-ota-clear]'),
  otaProgressBar: document.querySelector('[data-ota-progress]'),
  otaProgressFill: document.querySelector('[data-ota-progress-fill]'),
  otaProgressLabel: document.querySelector('[data-ota-progress-label]'),
  otaMessage: document.querySelector('[data-ota-message]')
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

  const firmwareInfo = state.firmwareInfo ?? state.status?.firmware ?? null;
  const otaStatus = state.otaStatus ?? state.status?.ota ?? null;
  if (elements.firmwareDevice) {
    elements.firmwareDevice.textContent = firmwareInfo?.device ?? '--';
  }
  if (elements.firmwareBuild) {
    elements.firmwareBuild.textContent = formatFirmwareBuild(firmwareInfo);
  }
  if (elements.firmwareSketch) {
    elements.firmwareSketch.textContent = formatBytes(firmwareInfo?.sketchSize);
  }
  if (elements.firmwareSpace) {
    elements.firmwareSpace.textContent = formatBytes(firmwareInfo?.freeSpace);
  }
  if (elements.firmwarePartition) {
    elements.firmwarePartition.textContent = firmwareInfo?.currentPartition || '--';
  }
  if (elements.firmwareNext) {
    elements.firmwareNext.textContent = firmwareInfo?.nextPartition || '--';
  }
  if (elements.firmwareHash) {
    elements.firmwareHash.textContent = firmwareInfo?.sketchMD5 || '--';
  }
  const otaChip = deriveOtaStatusChip(otaStatus, state.otaUploading);
  if (elements.otaStatusChip) {
    elements.otaStatusChip.textContent = otaChip.label;
    elements.otaStatusChip.className = `chip ${otaChip.tone}`;
  }
  if (elements.otaFileMeta) {
    elements.otaFileMeta.textContent = state.otaSelectedFileName
      ? `${state.otaSelectedFileName} (${formatBytes(state.otaSelectedFileSize)})`
      : 'No firmware selected.';
  }
  if (elements.otaFileInput) {
    elements.otaFileInput.disabled = !settingsActive || state.otaUploading;
  }
  if (elements.otaUploadButton) {
    const hasFile = Boolean(state.otaSelectedFileName);
    const locked = !settingsActive || state.otaUploading;
    elements.otaUploadButton.disabled = locked || !hasFile;
    elements.otaUploadButton.textContent = state.otaUploading ? 'Uploading...' : 'Upload firmware';
  }
  if (elements.otaClearButton) {
    const hasFile = Boolean(state.otaSelectedFileName);
    elements.otaClearButton.disabled = state.otaUploading || !hasFile;
  }
  if (elements.otaProgressBar) {
    const total = state.otaUploadProgressTotal || 0;
    const showProgress = state.otaUploading && total > 0;
    elements.otaProgressBar.hidden = !showProgress;
    if (showProgress) {
      const loaded = Math.min(state.otaUploadProgressBytes, total);
      const percent = Math.min(100, Math.round((loaded / total) * 100));
      if (elements.otaProgressFill) {
        elements.otaProgressFill.style.width = `${percent}%`;
      }
      if (elements.otaProgressLabel) {
        elements.otaProgressLabel.textContent = `${percent}%`;
      }
    }
  }
  if (elements.otaMessage) {
    let messageText = state.otaMessage;
    let messageType = state.otaMessageType || 'info';
    if (!messageText) {
      if (state.otaUploading) {
        messageText = 'Uploading firmware...';
        messageType = 'info';
      } else if (otaStatus?.rebootPending) {
        messageText = 'Upload complete. Waiting for reboot...';
        messageType = 'info';
      } else if (otaStatus?.result === 'error' && otaStatus?.error) {
        messageText = otaStatus.error;
        messageType = 'error';
      } else if (otaStatus?.result === 'success' && otaStatus?.filename) {
        messageText = `Last update: ${otaStatus.filename}`;
        messageType = 'success';
      }
    }
    const showMessage = Boolean(messageText);
    elements.otaMessage.hidden = !showMessage;
    if (showMessage) {
      elements.otaMessage.textContent = messageText;
      elements.otaMessage.classList.remove('info', 'error', 'success');
      elements.otaMessage.classList.add(messageType === 'error' ? 'error' :
        messageType === 'success' ? 'success' : 'info');
    }
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

  renderWifiScanResults();
  renderPinSettings();
  renderDoorHistory();
  renderTimezonePicker();
  renderSchedulerPanel();
  renderGeoSuggest();
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

function renderPinSettings() {
  if (!elements.pinForm) {
    return;
  }
  const settingsActive = state.activeTab === 'settings';
  const loading = state.pinLoading;
  const saving = state.pinSaving;
  const locked = !settingsActive || saving;
  const availablePins = Array.isArray(state.pinAvailablePins) ? state.pinAvailablePins : [];
  const form =
    state.pinForm ?? { openPin: '', closePin: '', sensorPin: '', travelTimeSeconds: '' };
  const shouldSyncInputs = !state.pinFormDirty;
  const inputMap = [
    { element: elements.pinOpenInput, field: 'openPin' },
    { element: elements.pinCloseInput, field: 'closePin' },
    { element: elements.pinSensorInput, field: 'sensorPin' },
    { element: elements.pinTravelTimeInput, field: 'travelTimeSeconds' }
  ];
  inputMap.forEach(({ element, field }) => {
    if (!element) {
      return;
    }
    const nextValue = form[field] ?? '';
    if (shouldSyncInputs && element.value !== nextValue) {
      element.value = nextValue;
    }
    element.disabled = locked || loading;
  });
  if (elements.pinAvailableList) {
    let availableText = '';
    if (loading && !availablePins.length) {
      availableText = 'Loading available pins...';
    } else if (availablePins.length) {
      availableText = `Available pins: ${availablePins.join(', ')}`;
    } else {
      availableText = 'Controller did not report any available GPIOs.';
    }
    elements.pinAvailableList.hidden = !settingsActive;
    if (settingsActive) {
      elements.pinAvailableList.textContent = availableText;
    }
  }
  if (elements.pinSubmitButton) {
    const fieldsFilled = inputMap.every(({ field }) => Boolean((form[field] ?? '').trim()));
    const canSubmit =
      settingsActive && fieldsFilled && state.pinFormDirty && !loading && !saving;
    elements.pinSubmitButton.disabled = !canSubmit;
    elements.pinSubmitButton.textContent = saving ? 'Saving...' : 'Save settings';
  }
  if (elements.pinMessage) {
    let messageText = state.pinMessage;
    let messageType = state.pinMessageType || 'info';
    if (!messageText && loading && settingsActive) {
      messageText = 'Loading pin configuration...';
      messageType = 'info';
    }
    const showMessage = settingsActive && Boolean(messageText);
    elements.pinMessage.hidden = !showMessage;
    if (showMessage) {
      elements.pinMessage.textContent = messageText;
      elements.pinMessage.className = `banner ${messageType}`;
    }
  }
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

function formatFirmwareBuild(info) {
  if (!info) {
    return '--';
  }
  if (info.appVersion && info.projectName) {
    return `${info.appVersion} (${info.projectName})`;
  }
  if (info.appVersion) {
    return info.appVersion;
  }
  return info.buildTimestamp || info.buildDate || '--';
}

function deriveOtaStatusChip(status, uploading) {
  if (uploading || status?.inProgress) {
    return { label: 'Uploading', tone: 'warning' };
  }
  if (status?.rebootPending) {
    return { label: 'Reboot pending', tone: 'warning' };
  }
  if (status?.result === 'success') {
    return { label: 'Updated', tone: 'success' };
  }
  if (status?.result === 'error') {
    return { label: 'Failed', tone: 'danger' };
  }
  return { label: 'Idle', tone: 'info' };
}

function describePinError(code) {
  switch (code) {
    case 'invalid_open_pin':
      return 'Select a supported GPIO for the open relay pin.';
    case 'invalid_close_pin':
      return 'Select a supported GPIO for the close relay pin.';
    case 'invalid_sensor_pin':
      return 'Select a supported GPIO for the sensor pin.';
    case 'pin_conflict':
      return 'Each pin must be unique.';
    case 'missing_body':
      return 'Request body is missing.';
    case 'invalid_json':
      return 'Pin update payload is invalid.';
    case 'no_changes':
      return 'Adjust a pin value before saving.';
    case 'invalid_travel_time':
      return `Door travel time must be between ${MIN_DOOR_TRAVEL_TIME_SECONDS} and ${MAX_DOOR_TRAVEL_TIME_SECONDS} seconds.`;
    default:
      return 'Unable to update pin configuration.';
  }
}

function formatTravelTimeInputValue(travelTimeMs) {
  const numeric = Number(travelTimeMs);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '';
  }
  const seconds = numeric / 1000;
  const rounded = Math.round(seconds * 1000) / 1000;
  let text = rounded.toString();
  if (text.includes('.')) {
    text = text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return text;
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

function applyPinConfig(payload, options = {}) {
  const availablePins = Array.isArray(payload?.availablePins)
    ? payload.availablePins
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : state.pinAvailablePins;
  const nextState = {
    pinConfig: payload,
    pinAvailablePins: availablePins,
    pinLoading: false
  };
  const shouldSyncForm = !state.pinFormDirty || options.forceFormUpdate;
  if (shouldSyncForm) {
    const travelTimeMs = Number(payload?.travelTimeMs);
    nextState.pinForm = {
      openPin: payload?.openPin == null ? '' : String(payload.openPin),
      closePin: payload?.closePin == null ? '' : String(payload.closePin),
      sensorPin: payload?.sensorPin == null ? '' : String(payload.sensorPin),
      travelTimeSeconds:
        Number.isFinite(travelTimeMs) && travelTimeMs > 0
          ? formatTravelTimeInputValue(travelTimeMs)
          : String(DEFAULT_DOOR_TRAVEL_TIME_SECONDS)
    };
    nextState.pinFormDirty = false;
  }
  setState(nextState);
}

async function fetchPinConfig(force = false) {
  if (state.pinLoading && !force) {
    return;
  }
  setState({ pinLoading: true, pinMessage: '', pinMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/pins'), { cache: 'no-cache' });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (parseError) {
        throw new Error('Unable to parse pin configuration.');
      }
    }
    if (!response.ok) {
      const message = payload?.error
        ? describePinError(payload.error)
        : `Pin request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    if (!payload) {
      throw new Error('Pin configuration payload missing.');
    }
    applyPinConfig(payload, { forceFormUpdate: !state.pinFormDirty });
  } catch (error) {
    console.error(error);
    setState({
      pinLoading: false,
      pinMessage: error?.message ?? 'Unable to load pin configuration.',
      pinMessageType: 'error'
    });
  }
}

function updatePinFormField(field, value) {
  const nextValue = value == null ? '' : String(value).trim();
  if (state.pinForm?.[field] === nextValue && state.pinFormDirty) {
    return;
  }
  setState({
    pinForm: { ...state.pinForm, [field]: nextValue },
    pinFormDirty: true,
    pinMessage: '',
    pinMessageType: ''
  });
}

async function handlePinFormSubmit(event) {
  event.preventDefault();
  if (state.pinSaving) {
    return;
  }
  const form = state.pinForm ?? {};
  const fields = ['openPin', 'closePin', 'sensorPin'];
  const payload = {};
  for (const field of fields) {
    const value = (form[field] ?? '').trim();
    if (!value) {
      setState({
        pinMessage: 'Specify all door GPIO pins.',
        pinMessageType: 'error'
      });
      return;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      setState({
        pinMessage: 'Pins must be numeric GPIO values.',
        pinMessageType: 'error'
      });
      return;
    }
    payload[field] = parsed;
  }
  const travelTimeValue = (form.travelTimeSeconds ?? '').trim();
  if (!travelTimeValue) {
    setState({
      pinMessage: 'Enter the door travel time.',
      pinMessageType: 'error'
    });
    return;
  }
  const travelSeconds = Number(travelTimeValue);
  if (!Number.isFinite(travelSeconds)) {
    setState({
      pinMessage: 'Door travel time must be a number in seconds.',
      pinMessageType: 'error'
    });
    return;
  }
  if (
    travelSeconds < MIN_DOOR_TRAVEL_TIME_SECONDS ||
    travelSeconds > MAX_DOOR_TRAVEL_TIME_SECONDS
  ) {
    setState({
      pinMessage: `Door travel time must be between ${MIN_DOOR_TRAVEL_TIME_SECONDS} and ${MAX_DOOR_TRAVEL_TIME_SECONDS} seconds.`,
      pinMessageType: 'error'
    });
    return;
  }
  payload.travelTimeMs = Math.round(travelSeconds * 1000);
  setState({ pinSaving: true, pinMessage: '', pinMessageType: '' });
  try {
    const response = await fetch(buildEndpoint('/api/pins'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-cache',
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (parseError) {
        throw new Error('Unable to parse controller response.');
      }
    }
    if (!response.ok) {
      const message = body?.error
        ? describePinError(body.error)
        : `Pin update failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    if (!body) {
      throw new Error('Controller did not return the updated pins.');
    }
    applyPinConfig(body, { forceFormUpdate: true });
    setState({
      pinSaving: false,
      pinMessage: 'Door settings saved.',
      pinMessageType: 'success',
      pinFormDirty: false
    });
  } catch (error) {
    console.error(error);
    setState({
      pinSaving: false,
      pinMessage: error?.message ?? 'Unable to save door settings.',
      pinMessageType: 'error'
    });
  }
}

function handleOtaFileChange(event) {
  const file = event?.target?.files?.[0];
  if (!file) {
    setState({
      otaSelectedFileName: '',
      otaSelectedFileSize: 0,
      otaUploadProgressBytes: 0,
      otaUploadProgressTotal: 0
    });
    return;
  }
  setState({
    otaSelectedFileName: file.name,
    otaSelectedFileSize: file.size,
    otaUploadProgressBytes: 0,
    otaUploadProgressTotal: 0,
    otaMessage: '',
    otaMessageType: ''
  });
}

function clearOtaSelection(event) {
  if (event) {
    event.preventDefault();
  }
  if (elements.otaFileInput) {
    elements.otaFileInput.value = '';
  }
  setState({
    otaSelectedFileName: '',
    otaSelectedFileSize: 0,
    otaUploadProgressBytes: 0,
    otaUploadProgressTotal: 0
  });
}

async function handleOtaUpload(event) {
  if (event) {
    event.preventDefault();
  }
  if (state.otaUploading) {
    return;
  }
  const file = elements.otaFileInput?.files?.[0];
  if (!file) {
    setState({
      otaMessage: 'Select a firmware bundle first.',
      otaMessageType: 'error'
    });
    return;
  }
  setState({
    otaUploading: true,
    otaMessage: '',
    otaMessageType: '',
    otaUploadProgressBytes: 0,
    otaUploadProgressTotal: file.size
  });
  try {
    await uploadFirmware(file);
    setState({
      otaUploading: false,
      otaMessage: 'Upload complete. Waiting for controller to reboot...',
      otaMessageType: 'info',
      otaSelectedFileName: '',
      otaSelectedFileSize: 0,
      otaUploadProgressBytes: file.size,
      otaUploadProgressTotal: file.size
    });
    if (elements.otaFileInput) {
      elements.otaFileInput.value = '';
    }
    fetchFirmwareStatus(true);
  } catch (error) {
    console.error(error);
    setState({
      otaUploading: false,
      otaMessage: error?.message ?? 'Unable to upload firmware.',
      otaMessageType: 'error'
    });
  }
}

function uploadFirmware(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let reportedComplete = false;
    xhr.open('POST', buildEndpoint('/api/ota/upload'), true);
    const formData = new FormData();
    formData.append('firmware', file, file.name);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      const loaded = event.lengthComputable ? event.loaded : Math.min(file.size, event.loaded ?? 0);
      if (loaded >= total) {
        reportedComplete = true;
      }
      setState({
        otaUploadProgressBytes: loaded,
        otaUploadProgressTotal: total
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      if (xhr.status === 0 && reportedComplete) {
        resolve();
        return;
      }
      let message = 'Upload failed.';
      try {
        const payload = JSON.parse(xhr.responseText || '{}');
        if (payload?.error) {
          message = payload.error;
        }
      } catch (parseError) {
        // ignore parse errors, use fallback message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => {
      if (reportedComplete) {
        resolve();
        return;
      }
      reject(new Error('Upload failed. Check your connection.'));
    };
    xhr.onabort = () => reject(new Error('Upload canceled.'));
    xhr.send(formData);
  });
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
  if (tabName === 'settings' && !state.pinConfig && !state.pinLoading) {
    fetchPinConfig();
  }
  if (tabName === 'settings' && !state.firmwareInfo && !state.otaStatusLoading) {
    fetchFirmwareStatus();
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

async function fetchFirmwareStatus(force = false) {
  if (state.otaStatusLoading && !force) {
    return;
  }
  setState({ otaStatusLoading: true });
  try {
    const response = await fetch(buildEndpoint('/api/ota'), { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Firmware status failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    applyOtaStatus(payload);
  } catch (error) {
    console.error(error);
    setState({ otaStatusLoading: false });
  }
}

function applyOtaStatus(payload) {
  const firmware = payload?.firmware ?? null;
  const ota = payload?.ota ?? null;
  setState({
    firmwareInfo: firmware ?? state.firmwareInfo,
    otaStatus: ota ?? state.otaStatus,
    otaStatusLoading: false
  });
}

function applyStatus(payload) {
  setState({
    status: payload,
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

if (elements.otaFileInput) {
  elements.otaFileInput.addEventListener('change', handleOtaFileChange);
}
if (elements.otaForm) {
  elements.otaForm.addEventListener('submit', handleOtaUpload);
}
if (elements.otaClearButton) {
  elements.otaClearButton.addEventListener('click', clearOtaSelection);
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

if (elements.pinForm) {
  elements.pinForm.addEventListener('submit', handlePinFormSubmit);
}
const pinFieldMap = [
  { element: elements.pinOpenInput, field: 'openPin' },
  { element: elements.pinCloseInput, field: 'closePin' },
  { element: elements.pinSensorInput, field: 'sensorPin' },
  { element: elements.pinTravelTimeInput, field: 'travelTimeSeconds' }
];
pinFieldMap.forEach(({ element, field }) => {
  if (!element) {
    return;
  }
  const handleFieldChange = (event) => {
    updatePinFormField(field, event.target.value);
  };
  // Listen for multiple events to capture changes across browsers and input types.
  ['input', 'change', 'keyup'].forEach((eventName) => {
    element.addEventListener(eventName, handleFieldChange);
  });
});

window.addEventListener('beforeunload', () => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
  clearInterval(historyPollTimer);
  stopCountdownLoop();
  stopOverrideCountdownLoop();
});
