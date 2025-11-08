<script>
  import { onMount, onDestroy } from 'svelte'

  const STATUS_ENDPOINT = '/api/status'
  const COMMAND_ENDPOINT = (action) => `/api/door/${action}`
  const POLL_INTERVAL_MS = 5000
  const COUNTDOWN_TICK_MS = 250
  const DEFAULT_DOOR_TRAVEL_TIME_MS = 50000 // adjust to match firmware's DOOR_TRAVEL_TIME_MS
  const DEFAULT_POMODORO_LENGTH_MS = DEFAULT_DOOR_TRAVEL_TIME_MS // adjust to tune UI countdown

  let status = null
  let loading = true
  let commandInFlight = ''
  let errorMessage = ''
  let lastUpdated = null
  let countdownMs = null
  let countdownTimerId = null
  let latestStatusRequestId = 0
  let manualReloading = false
  let currentTime = new Date()

  function hardReload() {
    if (manualReloading || typeof window === 'undefined') {
      return
    }
    manualReloading = true
    const url = new URL(window.location.href)
    url.searchParams.set('_ts', Date.now().toString())
    window.location.replace(url.toString())
  }

  function applyStatus(payload) {
    status = payload
    lastUpdated = new Date()
    syncCountdownFromStatus()
  }

  function formatCurrentTime(date) {
    return date ? date.toLocaleTimeString() : '--'
  }

  function isActionActive(action) {
    if (commandInFlight === action) {
      return true
    }
    const motion = doorMotion()
    if (action === 'open') {
      return motion === 'opening'
    }
    if (action === 'close') {
      return motion === 'closing'
    }
    return false
  }

  async function fetchStatus(initial = false) {
    const requestId = ++latestStatusRequestId
    if (initial) {
      loading = true
    }
    errorMessage = ''
    try {
      const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`Status request failed with HTTP ${response.status}`)
      }
      const payload = await response.json()
      if (requestId === latestStatusRequestId) {
        applyStatus(payload)
      }
    } catch (error) {
      if (requestId !== latestStatusRequestId) {
        return
      }
      console.error(error)
      errorMessage = error?.message ?? 'Unable to reach the controller.'
    } finally {
      if (requestId === latestStatusRequestId) {
        loading = false
      }
    }
  }

  async function sendDoorCommand(action) {
    if (!status?.door || commandInFlight) {
      return
    }
    commandInFlight = action
    errorMessage = ''
    try {
      const response = await fetch(COMMAND_ENDPOINT(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store'
      })
      if (!response.ok) {
        throw new Error(`Command failed with HTTP ${response.status}`)
      }
      const payload = await response.json()
      if (payload?.door) {
        updateDoorStatus(payload.door)
      }
    } catch (error) {
      console.error(error)
      errorMessage = error?.message ?? 'Command failed.'
    } finally {
      commandInFlight = ''
      hardReload()
    }
  }

  function updateDoorStatus(doorPayload, options = {}) {
    if (status) {
      status = { ...status, door: doorPayload }
    } else {
      status = { door: doorPayload }
    }
    lastUpdated = new Date()
    if (options.syncCountdown ?? true) {
      syncCountdownFromStatus()
    }
  }

  function settleDoorLocally() {
    if (!status?.door) {
      countdownMs = null
      stopCountdownLoop()
      return
    }
    const nextState = status.door.targetState ?? status.door.state
    const updatedDoor = {
      ...status.door,
      state: nextState,
      targetState: nextState,
      busy: false,
      motion: 'idle',
      motionRemainingMs: null
    }
    countdownMs = null
    stopCountdownLoop()
    updateDoorStatus(updatedDoor, { syncCountdown: false })
  }

  function formatTemp(value) {
    return value == null ? '--' : `${Number(value).toFixed(1)}\u00B0C`
  }

  function formatVoltage(value) {
    return value == null ? '--' : `${Number(value).toFixed(2)} V`
  }

  function formatRssi(value) {
    return value == null ? '--' : `${value} dBm`
  }

  function formatCountdown(ms) {
    if (ms == null) {
      return '--'
    }
    const totalSeconds = Math.ceil(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
  }

  function doorState() {
    return status?.door?.state ?? 'unknown'
  }

  function doorMotion() {
    return status?.door?.motion ?? 'idle'
  }

  function targetState() {
    return status?.door?.targetState ?? null
  }

  function doorChipLabel() {
    if (doorBusy) {
      const motion = doorMotion()
      if (motion && motion !== 'idle') {
        return motion
      }
    }
    return doorState()
  }

  function syncCountdownFromStatus() {
    if (status?.door?.busy) {
      let remaining = typeof status.door.motionRemainingMs === 'number'
        ? status.door.motionRemainingMs
        : status.door.travelTimeMs ?? DEFAULT_POMODORO_LENGTH_MS
      if (remaining == null) {
        remaining = DEFAULT_POMODORO_LENGTH_MS
      }
      countdownMs = remaining
      if (countdownMs != null) {
        startCountdownLoop()
      } else {
        stopCountdownLoop()
      }
    } else {
      countdownMs = null
      stopCountdownLoop()
    }
  }

  function startCountdownLoop() {
    if (countdownTimerId) {
      return
    }
    let previous = Date.now()
    countdownTimerId = setInterval(() => {
      if (countdownMs == null) {
        stopCountdownLoop()
        return
      }
      const now = Date.now()
      const delta = now - previous
      previous = now
      countdownMs = Math.max(0, countdownMs - delta)
      if (countdownMs === 0) {
        finalizeCountdown()
      }
    }, COUNTDOWN_TICK_MS)
  }

  function finalizeCountdown() {
    settleDoorLocally()
    fetchStatus()
    hardReload()
  }

  function stopCountdownLoop() {
    if (countdownTimerId) {
      clearInterval(countdownTimerId)
      countdownTimerId = null
    }
  }

  $: doorBusy = status?.door?.busy ?? false
  $: testMode = status?.door?.testMode ?? false
  $: travelTimeMs = status?.door?.travelTimeMs ?? DEFAULT_DOOR_TRAVEL_TIME_MS
  $: countdownPercent = countdownMs != null && travelTimeMs
    ? Math.min(100, Math.max(0, ((travelTimeMs - countdownMs) / travelTimeMs) * 100))
    : 0

  onMount(() => {
    fetchStatus(true)
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS)
    const clock = setInterval(() => {
      currentTime = new Date()
    }, 1000)
    return () => {
      clearInterval(interval)
      clearInterval(clock)
    }
  })

  onDestroy(() => {
    stopCountdownLoop()
  })
</script>

<main class="page">
  <header class="page-header">
    <div>
      <h1>Coop Door</h1>
      <p class="subtle">
        {#if lastUpdated}
          Last updated {lastUpdated.toLocaleTimeString()}
        {:else}
          Waiting for controller&hellip;
        {/if}
      </p>
    </div>
    <div class="header-actions">
      <button class="ghost" disabled={loading || manualReloading} on:click={hardReload}>
        {manualReloading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </header>

  {#if loading}
    <section class="loading-wrapper">
      <div class="spinner" aria-hidden="true"></div>
      <p>Connecting to the coop controller...</p>
    </section>
  {:else}
    {#if errorMessage}
      <div class="banner error">
        {errorMessage}
      </div>
    {/if}

    <section class="cards">
      <article class="card door-card">
        <div class="card-header">
          <h2>Door status</h2>
          <span class={`status-chip ${doorChipLabel()}`}>{doorChipLabel()}</span>
        </div>
        <dl class="key-values single">
          <div>
            <dt>Current time</dt>
            <dd>{formatCurrentTime(currentTime)}</dd>
          </div>
        </dl>
        {#if doorBusy && countdownMs != null}
          <div class="countdown">
            <div class="countdown-header">
              <span class="label">Countdown</span>
              <strong>{formatCountdown(countdownMs)}</strong>
            </div>
            {#if travelTimeMs}
              <div class="countdown-bar">
                <div class="fill" style={`width: ${countdownPercent}%`}></div>
              </div>
            {/if}
            <small class="subtle">
              Targeting {targetState() ?? '--'}
              {#if travelTimeMs}
                &middot; {Math.round(travelTimeMs / 1000)}s total travel
              {/if}
            </small>
          </div>
        {/if}
        {#if testMode}
          <p class="chip warning">Test mode is enabled &mdash; relays are not energized.</p>
        {/if}
        <div class="actions">
          <button
            class="action-button"
            class:active-action={isActionActive('open')}
            on:click={() => sendDoorCommand('open')}
            disabled={doorBusy || commandInFlight === 'close'}>
            {commandInFlight === 'open' ? 'Opening...' : 'Open door'}
          </button>
          <button
            class="action-button"
            class:active-action={isActionActive('close')}
            on:click={() => sendDoorCommand('close')}
            disabled={doorBusy || commandInFlight === 'open'}>
            {commandInFlight === 'close' ? 'Closing...' : 'Close door'}
          </button>
        </div>
      </article>

      <article class="card sensor-card">
        <div class="card-header">
          <h2>Sensors</h2>
        </div>
        <div class="sensor-grid">
          <div>
            <span class="label">Battery temp</span>
            <strong>{formatTemp(status?.sensors?.batteryTempC)}</strong>
          </div>
          <div>
            <span class="label">Greenhouse temp</span>
            <strong>{formatTemp(status?.sensors?.greenhouseTempC)}</strong>
          </div>
          <div>
            <span class="label">Battery voltage</span>
            <strong>{formatVoltage(status?.sensors?.batteryVoltage)}</strong>
          </div>
        </div>
      </article>

      <article class="card wifi-card">
        <div class="card-header">
          <h2>Wi-Fi</h2>
        </div>
        {#if status?.wifi}
          <dl class="key-values">
            <div>
              <dt>SSID</dt>
              <dd>{status.wifi.ssid}</dd>
            </div>
            <div>
              <dt>IP address</dt>
              <dd>{status.wifi.ip}</dd>
            </div>
            <div>
              <dt>Signal</dt>
              <dd>{formatRssi(status.wifi.rssi)}</dd>
            </div>
          </dl>
        {:else}
          <p class="subtle">Not connected.</p>
        {/if}
      </article>
    </section>
  {/if}
</main>
