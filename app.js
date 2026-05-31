'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────────

const state = {
  view: 'boot',
  profile: null,
  bt: { device: null, char: null, connected: false },
  workout: null,
  pendingSummary: null,
  history: [],
  restDuration: 120,
  restTimerRef: null,
  restTimerActive: false,
};

// ─── STORAGE ──────────────────────────────────────────────────────────────────

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('pth_profile')) || null; } catch { return null; }
}
function saveProfile(p) {
  localStorage.setItem('pth_profile', JSON.stringify(p));
  state.profile = p;
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem('pth_history')) || []; } catch { return []; }
}
function saveWorkoutToHistory(w) {
  state.history.unshift(w);
  localStorage.setItem('pth_history', JSON.stringify(state.history));
}
function deleteWorkoutFromHistory(id) {
  state.history = state.history.filter(w => w.id !== id);
  localStorage.setItem('pth_history', JSON.stringify(state.history));
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

function navigate(view) {
  state.view = view;
  const nav = document.getElementById('bottom-nav');

  // Views that hide the nav bar
  const noNav = ['onboarding', 'connect', 'workout', 'summary'];
  if (noNav.includes(view)) {
    nav.classList.add('hidden');
  } else {
    nav.classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
  }

  const app = document.getElementById('app');

  if (view === 'onboarding') { app.innerHTML = renderOnboarding(); bindOnboarding(); }
  else if (view === 'home')   { app.innerHTML = renderHome();       bindHome(); }
  else if (view === 'connect'){ app.innerHTML = renderConnect();    bindConnect(); }
  else if (view === 'workout'){ showWorkoutView(); }
  else if (view === 'summary'){ app.innerHTML = renderSummary();    bindSummary(); }
  else if (view === 'history'){ app.innerHTML = renderHistory();    bindHistory(); }
  else if (view === 'profile'){ app.innerHTML = renderProfile();    bindProfile(); }
}

// ─── BLUETOOTH ────────────────────────────────────────────────────────────────

async function connectPolar() {
  setConnectStatus('connecting', 'Verbinden…');
  try {
    state.bt.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Polar' }],
      optionalServices: ['heart_rate'],
    });
    state.bt.device.addEventListener('gattserverdisconnected', onBtDisconnect);

    const server = await state.bt.device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    state.bt.char = await service.getCharacteristic('heart_rate_measurement');
    await state.bt.char.startNotifications();
    state.bt.char.addEventListener('characteristicvaluechanged', onHRData);
    state.bt.connected = true;
    setConnectStatus('connected', `${state.bt.device.name} verbunden`);
    document.getElementById('start-workout-btn').disabled = false;
  } catch (err) {
    const msg = err.name === 'NotFoundError' ? 'Kein Gerät ausgewählt.' : 'Verbindung fehlgeschlagen.';
    setConnectStatus('error', msg);
    console.error(err);
  }
}

function setConnectStatus(type, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (!dot || !txt) return;
  dot.className = 'status-dot ' + type;
  txt.textContent = text;
}

function onBtDisconnect() {
  state.bt.connected = false;
  if (state.workout) updateSignal(false);
}

function onHRData(event) {
  const view = event.target.value;
  const flags = view.getUint8(0);
  const hr = (flags & 0x01) ? view.getUint16(1, true) : view.getUint8(1);
  if (state.workout) updateWorkoutHR(hr);
}

function disconnectBt() {
  if (state.bt.char) {
    state.bt.char.removeEventListener('characteristicvaluechanged', onHRData);
    state.bt.char = null;
  }
  if (state.bt.device?.gatt.connected) {
    state.bt.device.gatt.disconnect();
  }
  state.bt.connected = false;
}

// ─── WORKOUT ──────────────────────────────────────────────────────────────────

const ZONE_COLORS = ['#6b7280', '#22c55e', '#D4A843', '#f97316', '#ef4444'];
const ZONE_NAMES  = ['Zone 1 – Erholung', 'Zone 2 – Fettverbrennung', 'Zone 3 – Ausdauer', 'Zone 4 – Anaerob', 'Zone 5 – Maximum'];
const ZONE_SHORT  = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];

function getMaxHR(age) { return 220 - age; }

function getZone(hr, maxHR) {
  const p = hr / maxHR;
  if (p >= 0.90) return 4;
  if (p >= 0.80) return 3;
  if (p >= 0.70) return 2;
  if (p >= 0.60) return 1;
  return 0;
}

function calcCalPerSec(hr, profile) {
  const { age, weight, gender } = profile;
  const f = (-20.4022 + 0.4472 * hr - 0.1263 * weight + 0.074 * age) / 4.184;
  const m = (-55.0969 + 0.6309 * hr + 0.1988 * weight + 0.2017 * age) / 4.184;
  const kcalPerMin = gender === 'female' ? f : gender === 'male' ? m : (f + m) / 2;
  return Math.max(0, kcalPerMin) / 60;
}

function startWorkout() {
  const maxHR = getMaxHR(state.profile.age);
  state.workout = {
    startTime: Date.now(),
    elapsed: 0,         // seconds
    hr: 0,
    hrHistory: [],      // { t, hr } samples
    calories: 0,
    maxHR_used: maxHR,
    zoneTimes: [0, 0, 0, 0, 0], // seconds per zone
    currentZone: 0,
    lastHRTime: null,
    timerRef: null,
    noSignalSince: null,
  };
  state.workout.timerRef = setInterval(tickWorkout, 1000);
}

function tickWorkout() {
  const w = state.workout;
  if (!w) return;

  w.elapsed++;
  updateTimerDisplay(w.elapsed);

  // Track zone time only when we have a valid HR
  if (w.hr > 0 && w.lastHRTime && (Date.now() - w.lastHRTime) < 4000) {
    w.zoneTimes[w.currentZone]++;
  }

  // Detect no signal
  const noSig = !w.hr || !w.lastHRTime || (Date.now() - w.lastHRTime) > 4000;
  updateSignal(!noSig);
  if (noSig) {
    const el = document.getElementById('hr-value');
    if (el) { el.textContent = '--'; el.className = 'hr-value no-signal'; }
  }
}

function updateWorkoutHR(hr) {
  const w = state.workout;
  if (!w) return;
  w.hr = hr;
  w.lastHRTime = Date.now();
  w.currentZone = getZone(hr, w.maxHR_used);
  w.hrHistory.push({ t: w.elapsed, hr });
  w.calories += calcCalPerSec(hr, state.profile);

  // Update UI
  const hrEl = document.getElementById('hr-value');
  if (hrEl) {
    hrEl.textContent = hr;
    hrEl.className = 'hr-value';
    hrEl.style.color = ZONE_COLORS[w.currentZone];
  }
  const zoneEl = document.getElementById('zone-pill');
  if (zoneEl) {
    zoneEl.textContent = ZONE_NAMES[w.currentZone];
    zoneEl.style.background = ZONE_COLORS[w.currentZone];
    zoneEl.style.color = w.currentZone >= 1 ? '#141414' : '#f0f0f0';
  }
  const calEl = document.getElementById('cal-value');
  if (calEl) calEl.textContent = Math.round(w.calories);

  const maxHREl = document.getElementById('maxhr-value');
  if (maxHREl) {
    const currentMax = parseInt(maxHREl.textContent) || 0;
    if (hr > currentMax) maxHREl.textContent = hr;
  }

  updateZoneBars(w);
}

function updateZoneBars(w) {
  const total = w.elapsed || 1;
  for (let i = 0; i < 5; i++) {
    const bar = document.getElementById('zbar-' + i);
    if (bar) {
      const pct = Math.min(100, (w.zoneTimes[i] / total) * 100);
      bar.style.height = Math.max(3, pct * 0.9) + 'px';
      bar.style.maxHeight = '32px';
    }
  }
}

function updateTimerDisplay(seconds) {
  const el = document.getElementById('workout-timer');
  if (el) el.textContent = formatDuration(seconds);
}

function updateSignal(ok) {
  const el = document.getElementById('signal-dot');
  if (el) {
    el.style.background = ok ? '#22c55e' : '#ef4444';
  }
}

function endWorkout() {
  const w = state.workout;
  if (!w) return;
  clearInterval(w.timerRef);
  stopRestTimer();

  const hrSamples = w.hrHistory.map(s => s.hr);
  const avgHR = hrSamples.length
    ? Math.round(hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length) : 0;
  const maxHRReached = hrSamples.length ? Math.max(...hrSamples) : 0;

  const savedWorkout = {
    id: Date.now(),
    date: new Date().toISOString(),
    duration: w.elapsed,
    calories: Math.round(w.calories),
    avgHR,
    maxHR: maxHRReached,
    zoneTimes: [...w.zoneTimes],
  };

  saveWorkoutToHistory(savedWorkout);
  state.pendingSummary = savedWorkout;
  state.workout = null;
  disconnectBt();
  navigate('summary');
}

// ─── REST TIMER ───────────────────────────────────────────────────────────────

function setRestDuration(sec) {
  state.restDuration = sec;
  localStorage.setItem('pth_rest_duration', sec);
  document.querySelectorAll('.rest-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.sec) === sec);
  });
  if (!state.restTimerActive) updateRestDisplay(sec, sec);
}

function startRestTimer() {
  if (state.restTimerActive) { stopRestTimer(); return; }
  const duration = state.restDuration || 120;
  let remaining = duration;
  state.restTimerActive = true;
  const startBtn = document.getElementById('rest-start-btn');
  const presets  = document.getElementById('rest-presets');
  if (startBtn) startBtn.textContent = 'Stopp';
  if (presets)  presets.style.opacity = '0.4';
  updateRestDisplay(remaining, duration);
  state.restTimerRef = setInterval(() => {
    remaining--;
    updateRestDisplay(remaining, duration);
    if (remaining <= 0) {
      stopRestTimer();
      if ('vibrate' in navigator) navigator.vibrate([400, 150, 400, 150, 400]);
      const rv = document.getElementById('rest-value');
      if (rv) { rv.textContent = '✓'; rv.style.color = '#22c55e'; }
      if (presets) presets.style.opacity = '1';
      setTimeout(() => updateRestDisplay(state.restDuration, state.restDuration), 2000);
    }
  }, 1000);
}

function stopRestTimer() {
  if (state.restTimerRef) { clearInterval(state.restTimerRef); state.restTimerRef = null; }
  state.restTimerActive = false;
  const startBtn = document.getElementById('rest-start-btn');
  const presets  = document.getElementById('rest-presets');
  if (startBtn) startBtn.textContent = 'Start';
  if (presets)  presets.style.opacity = '1';
}

function updateRestDisplay(remaining, total) {
  const el = document.getElementById('rest-value');
  if (!el) return;
  el.textContent = remaining;
  const pct = total ? remaining / total : 1;
  el.style.color = pct > 0.5 ? 'var(--text)' : pct > 0.25 ? '#D4A843' : '#ef4444';
}

function switchWorkoutView(view) {
  const calView   = document.getElementById('wview-calories');
  const pauseView = document.getElementById('wview-pause');
  const tabCal    = document.getElementById('tab-calories');
  const tabPause  = document.getElementById('tab-pause');
  if (view === 'calories') {
    calView?.classList.remove('hidden');
    pauseView?.classList.add('hidden');
    tabCal?.classList.add('active');
    tabPause?.classList.remove('active');
  } else {
    calView?.classList.add('hidden');
    pauseView?.classList.remove('hidden');
    tabCal?.classList.remove('active');
    tabPause?.classList.add('active');
  }
}

// ─── WORKOUT VIEW (full-screen overlay) ───────────────────────────────────────

function showWorkoutView() {
  const existing = document.getElementById('view-workout');
  if (existing) existing.remove();
  const savedDuration = state.restDuration || 120;

  const el = document.createElement('div');
  el.id = 'view-workout';
  el.className = 'view active';
  el.innerHTML = `
    <div class="workout-header">
      <span id="workout-timer" class="workout-timer">00:00</span>
      <div class="workout-active-dot"></div>
      <div class="workout-signal">
        <span id="signal-dot" class="status-dot" style="background:#888"></span>
        <span>H10</span>
      </div>
    </div>

    <div id="wview-calories" class="workout-tab-content">
      <div class="hr-display">
        <div id="hr-value" class="hr-value no-signal">--</div>
        <div class="hr-unit">BPM</div>
      </div>
      <div id="zone-pill" class="zone-pill" style="background:var(--bg-elevated);color:var(--text-muted)">
        Warte auf Signal…
      </div>
      <div class="workout-stats">
        <div class="workout-stat">
          <div id="cal-value" class="workout-stat-value">0</div>
          <div class="workout-stat-label">kcal</div>
        </div>
        <div class="workout-stat">
          <div id="maxhr-value" class="workout-stat-value">--</div>
          <div class="workout-stat-label">Max BPM</div>
        </div>
      </div>
      <div class="zone-bars">
        ${[0,1,2,3,4].map(i => `
          <div class="zone-bar-wrap">
            <div id="zbar-${i}" class="zone-bar" style="height:3px;background:${ZONE_COLORS[i]}"></div>
            <div class="zone-bar-label">${ZONE_SHORT[i]}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div id="wview-pause" class="workout-tab-content hidden">
      <div class="rest-section">
        <div class="rest-label">PAUSENTIMER</div>
        <div class="rest-display">
          <span id="rest-value" class="rest-big">${savedDuration}</span>
          <span class="rest-unit">s</span>
        </div>
        <div class="rest-presets" id="rest-presets">
          ${[90,120,150,180].map(s => `
            <button class="rest-btn ${s === savedDuration ? 'active' : ''}" data-sec="${s}">${s}s</button>
          `).join('')}
        </div>
        <button class="btn btn-primary" id="rest-start-btn">Start</button>
      </div>
    </div>

    <div class="workout-tabs">
      <button class="workout-tab active" id="tab-calories">🔥 Kalorien</button>
      <button class="workout-tab" id="tab-pause">⏸ Pause</button>
    </div>

    <div class="workout-footer">
      <button class="btn btn-danger" id="end-workout-btn">Training beenden</button>
    </div>
  `;
  document.body.appendChild(el);

  document.getElementById('end-workout-btn').addEventListener('click', showEndConfirm);
  document.getElementById('tab-calories').addEventListener('click', () => switchWorkoutView('calories'));
  document.getElementById('tab-pause').addEventListener('click', () => switchWorkoutView('pause'));
  document.querySelectorAll('.rest-btn').forEach(btn => {
    btn.addEventListener('click', () => setRestDuration(parseInt(btn.dataset.sec)));
  });
  document.getElementById('rest-start-btn').addEventListener('click', startRestTimer);

  startWorkout();
}

function showEndConfirm() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>Training beenden?</h3>
      <p>Dein Workout wird automatisch gespeichert.</p>
      <div class="modal-actions">
        <button class="btn btn-primary" id="confirm-end">Ja, beenden</button>
        <button class="btn btn-secondary" id="cancel-end">Weiter trainieren</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('confirm-end').addEventListener('click', () => {
    overlay.remove();
    document.getElementById('view-workout')?.remove();
    endWorkout();
  });
  document.getElementById('cancel-end').addEventListener('click', () => overlay.remove());
}

// ─── RENDERERS ────────────────────────────────────────────────────────────────

function renderOnboarding() {
  return `
    <div class="onboarding-wrap">
      <div class="onboarding-top">
        <img src="icon.svg" class="onboarding-icon" alt="">
        <h1 class="onboarding-title">Dein<br><span>Krafttraining</span><br>Tracker.</h1>
        <p class="onboarding-sub">Verbindet sich mit deinem Polar H10 – Herzfrequenz, Zonen und Kalorien live.</p>
        <div class="spacer-lg"></div>
        <div class="onboarding-form">
          <div class="field-group">
            <div class="field-group-title">Dein Profil</div>
            <div class="field">
              <label>Name (optional)</label>
              <input type="text" id="ob-name" placeholder="z.B. Simone" autocomplete="off">
            </div>
            <div class="field">
              <label>Geschlecht</label>
              <select id="ob-gender">
                <option value="female">Weiblich</option>
                <option value="male">Männlich</option>
                <option value="other">Keine Angabe</option>
              </select>
            </div>
            <div class="field">
              <label>Alter</label>
              <input type="number" id="ob-age" placeholder="z.B. 28" min="15" max="99" inputmode="numeric">
            </div>
            <div class="field">
              <label>Gewicht (kg)</label>
              <input type="number" id="ob-weight" placeholder="z.B. 62" min="30" max="250" inputmode="decimal" step="0.1">
            </div>
            <div class="field">
              <label>Größe (cm)</label>
              <input type="number" id="ob-height" placeholder="z.B. 168" min="100" max="230" inputmode="numeric">
              <div class="field-note">Alter, Gewicht und Größe kannst du jederzeit aktualisieren.</div>
            </div>
          </div>
        </div>
      </div>
      <button class="btn btn-primary" id="ob-save-btn">Los geht's</button>
    </div>
  `;
}

function renderHome() {
  const p = state.profile;
  const last = state.history[0];
  const weekWorkouts = state.history.filter(w => {
    const d = new Date(w.date);
    const now = new Date();
    const diff = (now - d) / 1000 / 60 / 60 / 24;
    return diff <= 7;
  });
  const totalCal = state.history.reduce((s, w) => s + w.calories, 0);

  return `
    <div class="home-hero">
      ${p?.name ? `<div class="home-greeting">Hey, ${p.name}.</div>` : ''}
      <h1 class="home-title">Bereit für<br>dein <span>Training?</span></h1>
    </div>

    <div class="stats-strip">
      <div class="stat-chip">
        <div class="stat-chip-value">${state.history.length}</div>
        <div class="stat-chip-label">Workouts</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-value">${weekWorkouts.length}</div>
        <div class="stat-chip-label">Diese Woche</div>
      </div>
      <div class="stat-chip">
        <div class="stat-chip-value">${totalCal > 999 ? (totalCal/1000).toFixed(1)+'k' : totalCal}</div>
        <div class="stat-chip-label">kcal gesamt</div>
      </div>
    </div>

    <div class="start-btn-wrap">
      <button class="btn btn-primary" id="go-connect-btn">Training starten</button>
    </div>

    ${last ? `
      <div class="card last-workout-card">
        <div class="last-workout-title">Letztes Training · ${formatDate(last.date)}</div>
        <div class="last-workout-stats">
          <div>
            <div class="lw-stat-value">${last.avgHR}</div>
            <div class="lw-stat-label">Ø BPM</div>
          </div>
          <div>
            <div class="lw-stat-value">${last.calories}</div>
            <div class="lw-stat-label">kcal</div>
          </div>
          <div>
            <div class="lw-stat-value">${formatDuration(last.duration)}</div>
            <div class="lw-stat-label">Dauer</div>
          </div>
          <div>
            <div class="lw-stat-value">${last.maxHR}</div>
            <div class="lw-stat-label">Max BPM</div>
          </div>
        </div>
      </div>
    ` : `
      <div class="card" style="text-align:center;padding:32px 20px">
        <p style="color:var(--text-muted);font-size:15px;line-height:1.6">Verbinde deinen Polar H10<br>und starte dein erstes Training.</p>
      </div>
    `}
    <div class="spacer"></div>
  `;
}

function renderConnect() {
  const btSupported = 'bluetooth' in navigator;
  return `
    <div class="page-header">
      <button class="back-btn" id="connect-back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Zurück
      </button>
    </div>
    <div class="connect-wrap">
      <div class="connect-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11M12 2v4M12 18v4M2 12h4M18 12h4"/>
        </svg>
      </div>
      <div class="connect-text">
        <h2>Polar H10 verbinden</h2>
        <p>${btSupported
          ? 'Tippe auf Verbinden und wähle deinen Polar H10 aus der Liste aus.'
          : 'Bluetooth wird von diesem Browser nicht unterstützt. Öffne die App in Bluefy.'
        }</p>
      </div>
      <div class="connect-status">
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text">Nicht verbunden</span>
      </div>
      <div class="connect-btn-wrap" style="display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary" id="connect-btn" ${!btSupported ? 'disabled' : ''}>
          Verbinden
        </button>
        <button class="btn btn-primary" id="start-workout-btn" disabled>
          Training starten
        </button>
      </div>
    </div>
  `;
}

function renderSummary() {
  const w = state.pendingSummary;
  if (!w) return '<div class="empty-state"><p>Keine Daten.</p></div>';
  const totalZone = w.zoneTimes.reduce((s, t) => s + t, 0) || 1;

  return `
    <div class="summary-hero">
      <h2>Stark gemacht.</h2>
      <div class="summary-date">${formatDate(w.date)} · ${formatDuration(w.duration)}</div>
    </div>

    <div class="summary-grid">
      <div class="summary-stat">
        <div class="summary-stat-value">${w.avgHR}</div>
        <div class="summary-stat-label">Ø Herzfrequenz</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-value">${w.maxHR}</div>
        <div class="summary-stat-label">Max BPM</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-value">${w.calories}</div>
        <div class="summary-stat-label">kcal verbrannt</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-value">${formatDuration(w.duration)}</div>
        <div class="summary-stat-label">Dauer</div>
      </div>
    </div>

    <div class="zone-summary">
      <div class="zone-summary-title">Zeit pro Zone</div>
      ${w.zoneTimes.map((t, i) => `
        <div class="zone-row">
          <div class="zone-dot" style="background:${ZONE_COLORS[i]}"></div>
          <div class="zone-row-name">${ZONE_SHORT[i]}</div>
          <div class="zone-track">
            <div class="zone-fill" style="width:${(t/totalZone*100).toFixed(1)}%;background:${ZONE_COLORS[i]}"></div>
          </div>
          <div class="zone-row-time">${formatMinSec(t)}</div>
        </div>
      `).join('')}
    </div>

    <div class="summary-note">Workout gespeichert ✓</div>
    <div class="summary-actions">
      <button class="btn btn-danger" id="delete-btn">Löschen</button>
      <button class="btn btn-primary" id="ok-btn">Fertig</button>
    </div>
  `;
}

function renderHistory() {
  return `
    <div class="page-header">
      <span class="page-title">Verlauf</span>
    </div>
    <div class="spacer-sm"></div>
    ${state.history.length === 0 ? `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 12"/>
        </svg>
        <p>Noch keine Workouts gespeichert.<br>Starte dein erstes Training!</p>
      </div>
    ` : `
      <div class="history-list">
        ${state.history.map((w, idx) => `
          <div class="history-item" data-idx="${idx}">
            <div class="history-item-header">
              <span class="history-item-date">${formatDate(w.date)}</span>
              <span class="history-item-duration">${formatDuration(w.duration)}</span>
            </div>
            <div class="history-item-stats">
              <div class="history-stat">
                <div class="history-stat-value">${w.avgHR}</div>
                <div class="history-stat-label">Ø BPM</div>
              </div>
              <div class="history-stat">
                <div class="history-stat-value">${w.maxHR}</div>
                <div class="history-stat-label">Max BPM</div>
              </div>
              <div class="history-stat">
                <div class="history-stat-value">${w.calories}</div>
                <div class="history-stat-label">kcal</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `}
    <div class="spacer"></div>
  `;
}

function renderProfile() {
  const p = state.profile || {};
  return `
    <div class="page-header">
      <span class="page-title">Profil</span>
    </div>
    <div class="profile-form">
      <div class="field-group">
        <div class="field-group-title">Persönliche Daten</div>
        <div class="field">
          <label>Name (optional)</label>
          <input type="text" id="p-name" value="${p.name || ''}" placeholder="z.B. Simone" autocomplete="off">
        </div>
        <div class="field">
          <label>Geschlecht</label>
          <select id="p-gender">
            <option value="female" ${p.gender === 'female' ? 'selected' : ''}>Weiblich</option>
            <option value="male"   ${p.gender === 'male'   ? 'selected' : ''}>Männlich</option>
            <option value="other"  ${p.gender === 'other'  ? 'selected' : ''}>Keine Angabe</option>
          </select>
        </div>
        <div class="field">
          <label>Alter</label>
          <input type="number" id="p-age" value="${p.age || ''}" placeholder="z.B. 28" min="15" max="99" inputmode="numeric">
        </div>
      </div>
      <div class="field-group">
        <div class="field-group-title">Körperdaten</div>
        <div class="field">
          <label>Gewicht (kg)</label>
          <input type="number" id="p-weight" value="${p.weight || ''}" placeholder="z.B. 62" min="30" max="250" inputmode="decimal" step="0.1">
          <div class="field-note">Aktualisiere dein Gewicht jederzeit für genaue Kalorienberechnung.</div>
        </div>
        <div class="field">
          <label>Größe (cm)</label>
          <input type="number" id="p-height" value="${p.height || ''}" placeholder="z.B. 168" min="100" max="230" inputmode="numeric">
        </div>
      </div>
    </div>
    <div class="profile-save-wrap">
      <button class="btn btn-primary" id="profile-save-btn">Speichern</button>
    </div>
    <div class="spacer"></div>
  `;
}

// ─── BINDERS ──────────────────────────────────────────────────────────────────

function bindOnboarding() {
  document.getElementById('ob-save-btn').addEventListener('click', () => {
    const age    = parseInt(document.getElementById('ob-age').value);
    const weight = parseFloat(document.getElementById('ob-weight').value);
    const height = parseInt(document.getElementById('ob-height').value);
    if (!age || !weight || !height) {
      alert('Bitte Alter, Gewicht und Größe ausfüllen.');
      return;
    }
    saveProfile({
      name:   document.getElementById('ob-name').value.trim(),
      gender: document.getElementById('ob-gender').value,
      age, weight, height,
    });
    navigate('home');
  });
}

function bindHome() {
  document.getElementById('go-connect-btn').addEventListener('click', () => navigate('connect'));
}

function bindConnect() {
  document.getElementById('connect-back').addEventListener('click', () => navigate('home'));
  document.getElementById('connect-btn').addEventListener('click', connectPolar);
  document.getElementById('start-workout-btn').addEventListener('click', () => {
    navigate('workout');
  });
}

function bindSummary() {
  document.getElementById('ok-btn').addEventListener('click', () => {
    state.pendingSummary = null;
    navigate('home');
  });
  document.getElementById('delete-btn').addEventListener('click', () => {
    if (state.pendingSummary) {
      deleteWorkoutFromHistory(state.pendingSummary.id);
      state.pendingSummary = null;
    }
    navigate('home');
  });
}

function bindHistory() {
  // tap on item → show detail (future enhancement)
}

function bindProfile() {
  document.getElementById('profile-save-btn').addEventListener('click', () => {
    const age    = parseInt(document.getElementById('p-age').value);
    const weight = parseFloat(document.getElementById('p-weight').value);
    const height = parseInt(document.getElementById('p-height').value);
    if (!age || !weight || !height) {
      alert('Bitte Alter, Gewicht und Größe ausfüllen.');
      return;
    }
    saveProfile({
      name:   document.getElementById('p-name').value.trim(),
      gender: document.getElementById('p-gender').value,
      age, weight, height,
    });
    document.getElementById('profile-save-btn').textContent = 'Gespeichert ✓';
    setTimeout(() => {
      const el = document.getElementById('profile-save-btn');
      if (el) el.textContent = 'Speichern';
    }, 2000);
  });
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function formatMinSec(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── NAV EVENTS ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  state.profile = loadProfile();
  state.history = loadHistory();
  state.restDuration = parseInt(localStorage.getItem('pth_rest_duration')) || 120;

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'connect' && !state.workout) {
      navigate('home');
    }
  });

  navigate(state.profile ? 'home' : 'onboarding');
});
