const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

// The login field was intentionally removed from the phone UI.
// This must match REMOTE_TOKEN on Render and in the Windows agent.
const REMOTE_TOKEN = '1234';
const DEVICE_ID = 'my-laptop';

const remotePanel = $('#remotePanel');
const restartBtn = $('#restartBtn');
const shutdownBtn = $('#shutdownBtn');
const statusEl = $('#status');
const deviceLabel = $('#deviceLabel');
const trackpad = $('#trackpad');
const textInput = $('#textInput');
const sensitivity = $('#sensitivity');
const sensitivityValue = $('#sensitivityValue');
const volumeSlider = $('#volumeSlider');
const volumeValue = $('#volumeValue');
const muteToggleBtn = $('#muteToggleBtn');
const scrollpad = $('#scrollpad');
const scrollKnob = $('#scrollKnob');
const scrollTrack = $('#scrollTrack');
const joystickBase = $('#joystickBase');
const joystickKnob = $('#joystickKnob');
const holdBtn = $('#holdBtn');
const holdBtnText = $('#holdBtnText');
const passwordModal = $('#passwordModal');
const actionPassword = $('#actionPassword');
const passwordError = $('#passwordError');
const passwordTitle = $('#passwordTitle');
const passwordDescription = $('#passwordDescription');
const confirmActionBtn = $('#confirmActionBtn');
const cancelActionBtn = $('#cancelActionBtn');

let socket = null;
let authenticated = false;
let agentOnline = false;
let reconnectTimer = null;
let savedDeviceId = null;
let mouseHeld = false;
let pendingProtectedAction = null;
let requestCounter = 0;
const pendingRequests = new Map();

let joystickPointerId = null;
let joystickOrigin = null;
let joystickVector = { x: 0, y: 0 };
let joystickFrame = null;
let lastJoystickSend = 0;
let touchStart = null;
let moved = false;
let scrollPointerId = null;
let scrollAmount = 0;
let scrollFrame = null;
let lastScrollSend = 0;

const JOYSTICK_DEAD_ZONE = 8;
const JOYSTICK_RADIUS = 90;
const JOYSTICK_MAX_STEP = 24;
const JOYSTICK_SEND_INTERVAL = 1000 / 30;
const SCROLL_DEAD_ZONE = 10;
const SCROLL_MAX_STEP = 20;
const SCROLL_SEND_INTERVAL = 1000 / 60;

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function setStatus(text, online) {
  statusEl.textContent = text;
  statusEl.classList.toggle('online', online);
  statusEl.classList.toggle('offline', !online);
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !authenticated) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function command(commandPayload) {
  return send({ type: 'command', command: commandPayload });
}

function requestCommand(commandPayload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = `r${Date.now()}-${++requestCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('No response from laptop.'));
    }, timeoutMs);
    pendingRequests.set(requestId, { resolve, reject, timer });
    if (!command({ ...commandPayload, requestId })) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(new Error('Laptop is not connected.'));
    }
  });
}

function resetHoldUi() {
  mouseHeld = false;
  holdBtn?.classList.remove('active');
  if (holdBtnText) holdBtnText.textContent = 'Hold';
}

function connect({ silent = false } = {}) {
  clearTimeout(reconnectTimer);
  const deviceId = DEVICE_ID;
  savedDeviceId = deviceId;
  if (!silent) setStatus('Connecting...', false);
  authenticated = false;
  socket = new WebSocket(wsUrl());

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'auth', role: 'controller', deviceId, token: REMOTE_TOKEN }));
  });

  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }

    if (message.type === 'auth_ok') {
      authenticated = true;
      agentOnline = Boolean(message.agentOnline);
      deviceLabel.textContent = message.deviceId;
      setStatus(agentOnline ? 'Laptop online' : 'Waiting for laptop', agentOnline);
      return;
    }

    if (message.type === 'auth_error') {
      authenticated = false;
      setStatus(message.message || 'Relay authentication failed', false);
      return;
    }

    if (message.type === 'agent_status') {
      agentOnline = Boolean(message.online);
      if (!agentOnline) resetHoldUi();
      setStatus(agentOnline ? 'Laptop online' : 'Waiting for laptop', agentOnline);
      return;
    }

    if (message.type === 'status' && typeof message.message === 'string') {
      setStatus(message.message, true);
      return;
    }

    if (message.type === 'ack' && message.requestId && pendingRequests.has(message.requestId)) {
      const pending = pendingRequests.get(message.requestId);
      clearTimeout(pending.timer);
      pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.message || 'Action was rejected.'));
    }
  });

  socket.addEventListener('close', event => {
    const wasConnected = authenticated;
    authenticated = false;
    agentOnline = false;
    resetHoldUi();
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed.'));
      pendingRequests.delete(id);
    }

    setStatus('Reconnecting...', false);
    if (savedDeviceId) {
      reconnectTimer = setTimeout(() => connect({ silent: true }), 2000);
    }
  });

  socket.addEventListener('error', () => setStatus('Server connection error', false));
}

function localDisconnect() {
  savedDeviceId = null;
  clearTimeout(reconnectTimer);
  authenticated = false;
  resetHoldUi();
  if (socket) socket.close(1000, 'User disconnected');
  socket = null;
  setStatus('Disconnected', false);
}


function csvRows(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  return lines.slice(1).map(line => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cells.push(current.trim()); current = '';
      } else current += ch;
    }
    cells.push(current.trim());
    return cells;
  });
}

function parseWebsiteShortcutCsv(text) {
  return csvRows(text).map(([name, url]) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      return { name: name || parsed.hostname, url };
    } catch { return null; }
  }).filter(Boolean);
}

function parsePcShortcutCsv(text) {
  return csvRows(text).map(([name, app, iconUrl = '']) => {
    const cleanApp = String(app || '').trim();
    if (!/^[A-Za-z0-9_.-]+\.exe$/i.test(cleanApp)) return null;
    return { name: String(name || cleanApp).trim(), app: cleanApp, iconUrl: String(iconUrl || '').trim() };
  }).filter(Boolean);
}

function faviconUrl(url) {
  try {
    const parsed = new URL(url);
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(parsed.hostname)}.ico`;
  } catch { return ''; }
}

function makeShortcutButton({ name, iconUrl = '', onClick, app = false }) {
  const button = document.createElement('button');
  button.className = `site-shortcut${app ? ' pc-shortcut' : ''}`;
  button.type = 'button';

  if (iconUrl) {
    const icon = document.createElement('img');
    icon.alt = '';
    icon.loading = 'lazy';
    icon.src = iconUrl;
    icon.addEventListener('error', () => { icon.style.display = 'none'; button.classList.add('icon-failed'); });
    button.appendChild(icon);
  } else {
    const fallback = document.createElement('span');
    fallback.className = 'shortcut-app-icon';
    fallback.textContent = app ? '▣' : '↗';
    button.appendChild(fallback);
  }

  const label = document.createElement('span');
  label.className = 'shortcut-label';
  label.textContent = name;
  button.appendChild(label);
  button.addEventListener('click', onClick);
  return button;
}

function closeShortcutMenu() {
  document.getElementById('shortcutMenu')?.classList.remove('open');
  document.getElementById('shortcutToggle')?.setAttribute('aria-expanded', 'false');
}

async function loadWebsiteShortcuts() {
  const grid = $('#shortcutGrid');
  if (!grid) return;
  try {
    const response = await fetch(`/shortcuts.csv?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('shortcuts.csv could not be loaded');
    const shortcuts = parseWebsiteShortcutCsv(await response.text());
    grid.innerHTML = '';
    if (!shortcuts.length) {
      grid.innerHTML = '<div class="shortcut-loading muted">No website shortcuts.</div>';
      return;
    }
    for (const shortcut of shortcuts) {
      grid.appendChild(makeShortcutButton({
        name: shortcut.name,
        iconUrl: faviconUrl(shortcut.url),
        onClick: () => { command({ type: 'navigate_url', url: shortcut.url }); closeShortcutMenu(); }
      }));
    }
  } catch (error) {
    grid.innerHTML = `<div class="shortcut-loading muted">${error.message}</div>`;
  }
}

async function loadPcShortcuts() {
  const grid = $('#pcShortcutGrid');
  if (!grid) return;
  try {
    const response = await fetch(`/pc-shortcuts.csv?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('pc-shortcuts.csv could not be loaded');
    const shortcuts = parsePcShortcutCsv(await response.text());
    grid.innerHTML = '';
    if (!shortcuts.length) {
      grid.innerHTML = '<div class="shortcut-loading muted">No PC shortcuts.</div>';
      return;
    }
    for (const shortcut of shortcuts) {
      grid.appendChild(makeShortcutButton({
        name: shortcut.name,
        iconUrl: shortcut.iconUrl,
        app: true,
        onClick: () => { command({ type: 'launch_app', app: shortcut.app }); closeShortcutMenu(); }
      }));
    }
  } catch (error) {
    grid.innerHTML = `<div class="shortcut-loading muted">${error.message}</div>`;
  }
}

async function loadShortcuts() {
  await Promise.all([loadPcShortcuts(), loadWebsiteShortcuts()]);
}

const shortcutToggle = $('#shortcutToggle');
const shortcutMenu = $('#shortcutMenu');
if (shortcutToggle && shortcutMenu) {
  shortcutToggle.addEventListener('click', event => {
    event.stopPropagation();
    const open = shortcutMenu.classList.toggle('open');
    shortcutToggle.setAttribute('aria-expanded', String(open));
  });
  shortcutMenu.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => {
    shortcutMenu.classList.remove('open');
    shortcutToggle.setAttribute('aria-expanded', 'false');
  });
}

$$('[data-click]').forEach(button => button.addEventListener('click', () => command({ type: 'click', button: button.dataset.click })));
$$('[data-key]').forEach(button => button.addEventListener('click', () => command({ type: 'key', key: button.dataset.key })));
$$('[data-hotkey]').forEach(button => button.addEventListener('click', () => command({ type: 'hotkey', keys: button.dataset.hotkey.split(',') })));

function scrollToRemoteSection(targetId) {
  if (targetId === 'mouseSection') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const target = document.getElementById(targetId);
  if (!target) return;
  const header = document.querySelector('.topbar-v3');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const extraClearance = 24;
  const top = Math.max(0, window.scrollY + target.getBoundingClientRect().top - headerHeight - extraClearance);
  window.scrollTo({ top, behavior: 'smooth' });
}

$$('[data-scroll-to]').forEach(button => {
  button.addEventListener('click', () => scrollToRemoteSection(button.dataset.scrollTo));
});

$('#searchBtn').addEventListener('click', () => {
  command({ type: 'hotkey', keys: ['ctrl', 'l'] });
  scrollToRemoteSection('keyboardSection');
  setTimeout(() => textInput.focus({ preventScroll: true }), 450);
});

holdBtn.addEventListener('click', () => {
  if (!mouseHeld) {
    if (command({ type: 'mouse_down', button: 'left' })) {
      mouseHeld = true;
      holdBtn.classList.add('active');
      holdBtnText.textContent = 'Release';
    }
  } else {
    command({ type: 'mouse_up', button: 'left' });
    resetHoldUi();
  }
});

function sendText(withEnter = false) {
  const text = textInput.value;
  if (!text) return;
  if (command({ type: 'type', text, enter: withEnter })) textInput.value = '';
}

$('#sendTextBtn').addEventListener('click', () => sendText(false));
$('#sendTextEnterBtn').addEventListener('click', () => sendText(true));
$('#centerMouseBtn').addEventListener('click', () => command({ type: 'center_mouse' }));

sensitivity.addEventListener('input', () => {
  sensitivityValue.textContent = `${Number(sensitivity.value).toFixed(1)}×`;
});

let volumeSendTimer = null;
function sendVolumeValue() {
  if (!volumeSlider) return;
  command({ type: 'volume_set', value: Number(volumeSlider.value) });
}

if (volumeSlider && volumeValue) {
  volumeSlider.addEventListener('input', () => {
    volumeValue.textContent = `${Math.round(Number(volumeSlider.value))}%`;
    clearTimeout(volumeSendTimer);
    volumeSendTimer = setTimeout(sendVolumeValue, 180);
  });
  volumeSlider.addEventListener('change', () => {
    clearTimeout(volumeSendTimer);
    sendVolumeValue();
  });
}

muteToggleBtn?.addEventListener('click', () => command({ type: 'volume_mute_toggle' }));

function openProtectedAction(action) {
  pendingProtectedAction = action;
  passwordError.textContent = '';
  actionPassword.value = '';
  const config = {
    restart: ['Restart computer?', 'Enter your password. The PC will restart immediately after confirmation.', 'Restart PC'],
    shutdown: ['Shut down computer?', 'Enter your password. The PC will shut down immediately after confirmation.', 'Shut down PC']
  }[action];
  passwordTitle.textContent = config[0];
  passwordDescription.textContent = config[1];
  confirmActionBtn.textContent = config[2];
  confirmActionBtn.classList.toggle('strong-danger', action === 'shutdown');
  passwordModal.classList.remove('hidden');
  setTimeout(() => actionPassword.focus(), 50);
}

function closeProtectedAction() {
  passwordModal.classList.add('hidden');
  pendingProtectedAction = null;
  actionPassword.value = '';
  passwordError.textContent = '';
}

async function confirmProtectedAction() {
  const action = pendingProtectedAction;
  const password = actionPassword.value;
  if (!action || !password) {
    passwordError.textContent = 'Enter your password.';
    return;
  }

  confirmActionBtn.disabled = true;
  passwordError.textContent = '';
  try {
    await requestCommand({ type: 'system_action', action, password }, 7000);
    closeProtectedAction();
    setStatus(action === 'restart' ? 'Restart command sent' : 'Shutdown command sent', true);
  } catch (error) {
    passwordError.textContent = error.message || 'Action failed.';
    actionPassword.select();
  } finally {
    confirmActionBtn.disabled = false;
  }
}

restartBtn.addEventListener('click', () => openProtectedAction('restart'));
shutdownBtn.addEventListener('click', () => openProtectedAction('shutdown'));
cancelActionBtn.addEventListener('click', closeProtectedAction);
confirmActionBtn.addEventListener('click', confirmProtectedAction);
actionPassword.addEventListener('keydown', event => {
  if (event.key === 'Enter') confirmProtectedAction();
  if (event.key === 'Escape') closeProtectedAction();
});
passwordModal.addEventListener('pointerdown', event => {
  if (event.target === passwordModal) closeProtectedAction();
});

// Dedicated one-finger continuous scroll bar.
function setScrollVisual(clientY = null, active = false) {
  if (!scrollpad || !scrollKnob || !scrollTrack) return;
  scrollpad.classList.toggle('active', active);
  if (clientY === null) { scrollKnob.style.top = '50%'; return; }
  const rect = scrollTrack.getBoundingClientRect();
  const knobHalf = scrollKnob.offsetHeight / 2;
  const minY = knobHalf;
  const maxY = rect.height - knobHalf;
  const localY = Math.max(minY, Math.min(maxY, clientY - rect.top));
  scrollKnob.style.top = `${localY}px`;
}

function updateScrollAmount(clientY) {
  if (!scrollTrack || !scrollKnob) return;
  const rect = scrollTrack.getBoundingClientRect();
  const knobHalf = scrollKnob.offsetHeight / 2;
  const centerY = rect.top + rect.height / 2;
  const maxDistance = Math.max(1, rect.height / 2 - knobHalf);
  const offset = Math.max(-maxDistance, Math.min(maxDistance, clientY - centerY));
  if (Math.abs(offset) <= SCROLL_DEAD_ZONE) { scrollAmount = 0; return; }
  const usableDistance = Math.max(1, maxDistance - SCROLL_DEAD_ZONE);
  const intensity = Math.min(1, (Math.abs(offset) - SCROLL_DEAD_ZONE) / usableDistance);
  scrollAmount = Math.sign(offset) * Math.max(1, Math.round(SCROLL_MAX_STEP * Math.pow(intensity, 0.78)));
}

function scrollLoop(timestamp) {
  if (scrollPointerId === null) { scrollFrame = null; return; }
  if (scrollAmount !== 0 && timestamp - lastScrollSend >= SCROLL_SEND_INTERVAL) {
    command({ type: 'scroll', dy: -scrollAmount });
    lastScrollSend = timestamp;
  }
  scrollFrame = requestAnimationFrame(scrollLoop);
}

function stopScrollController() {
  const pointerId = scrollPointerId;
  if (pointerId !== null && scrollpad) {
    try { if (scrollpad.hasPointerCapture(pointerId)) scrollpad.releasePointerCapture(pointerId); } catch {}
  }
  scrollPointerId = null;
  scrollAmount = 0;
  lastScrollSend = 0;
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
  setScrollVisual(null, false);
}

scrollpad.addEventListener('pointerdown', event => {
  if (scrollPointerId !== null) return;
  event.preventDefault(); event.stopPropagation();
  scrollPointerId = event.pointerId;
  lastScrollSend = 0;
  scrollpad.setPointerCapture(event.pointerId);
  setScrollVisual(event.clientY, true);
  updateScrollAmount(event.clientY);
  if (scrollFrame === null) scrollFrame = requestAnimationFrame(scrollLoop);
});
scrollpad.addEventListener('pointermove', event => {
  if (event.pointerId !== scrollPointerId) return;
  event.preventDefault(); event.stopPropagation();
  setScrollVisual(event.clientY, true);
  updateScrollAmount(event.clientY);
});
scrollpad.addEventListener('pointerup', event => { if (event.pointerId === scrollPointerId) { event.preventDefault(); event.stopPropagation(); stopScrollController(); } });
scrollpad.addEventListener('pointercancel', event => { if (scrollPointerId === null || event.pointerId === scrollPointerId) { event.stopPropagation(); stopScrollController(); } });

function setJoystickVisual(origin, dx = 0, dy = 0, visible = true) {
  if (!joystickBase || !joystickKnob) return;
  if (!visible || !origin) {
    joystickBase.classList.remove('active');
    joystickKnob.style.transform = 'translate(-50%, -50%)';
    return;
  }
  const rect = trackpad.getBoundingClientRect();
  joystickBase.style.left = `${origin.x - rect.left}px`;
  joystickBase.style.top = `${origin.y - rect.top}px`;
  joystickBase.classList.add('active');
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

function stopJoystick() {
  const pointerId = joystickPointerId;
  if (pointerId !== null) {
    try { if (trackpad.hasPointerCapture(pointerId)) trackpad.releasePointerCapture(pointerId); } catch {}
  }
  joystickPointerId = null;
  joystickOrigin = null;
  joystickVector = { x: 0, y: 0 };
  lastJoystickSend = 0;
  if (joystickFrame !== null) cancelAnimationFrame(joystickFrame);
  joystickFrame = null;
  setJoystickVisual(null, 0, 0, false);
}

function joystickLoop(timestamp) {
  if (joystickPointerId === null) { joystickFrame = null; return; }
  if (timestamp - lastJoystickSend >= JOYSTICK_SEND_INTERVAL) {
    const { x, y } = joystickVector;
    const distance = Math.hypot(x, y);
    if (distance > JOYSTICK_DEAD_ZONE) {
      const intensity = Math.min(1, (distance - JOYSTICK_DEAD_ZONE) / (JOYSTICK_RADIUS - JOYSTICK_DEAD_ZONE));
      const curvedIntensity = Math.pow(intensity, 1.35);
      const scale = Number(sensitivity.value);
      const step = JOYSTICK_MAX_STEP * curvedIntensity * scale;
      command({ type: 'move', dx: (x / distance) * step, dy: (y / distance) * step });
    }
    lastJoystickSend = timestamp;
  }
  joystickFrame = requestAnimationFrame(joystickLoop);
}

trackpad.addEventListener('pointerdown', event => {
  if (joystickPointerId !== null) return;
  event.preventDefault();
  joystickPointerId = event.pointerId;
  trackpad.setPointerCapture(event.pointerId);
  joystickOrigin = { x: event.clientX, y: event.clientY };
  joystickVector = { x: 0, y: 0 };
  touchStart = { x: event.clientX, y: event.clientY, time: performance.now() };
  moved = false;
  lastJoystickSend = 0;
  setJoystickVisual(joystickOrigin);
  if (joystickFrame === null) joystickFrame = requestAnimationFrame(joystickLoop);
});
trackpad.addEventListener('pointermove', event => {
  if (event.pointerId !== joystickPointerId || !joystickOrigin) return;
  event.preventDefault();
  let dx = event.clientX - joystickOrigin.x;
  let dy = event.clientY - joystickOrigin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > JOYSTICK_RADIUS) { const ratio = JOYSTICK_RADIUS / distance; dx *= ratio; dy *= ratio; }
  joystickVector = { x: dx, y: dy };
  setJoystickVisual(joystickOrigin, dx, dy);
  if (Math.hypot(dx, dy) > JOYSTICK_DEAD_ZONE) moved = true;
});
trackpad.addEventListener('pointerup', event => {
  if (event.pointerId !== joystickPointerId) return;
  if (touchStart) {
    const elapsed = performance.now() - touchStart.time;
    const distance = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
    if (!moved && elapsed < 350 && distance < 10) command({ type: 'click', button: 'left' });
  }
  stopJoystick();
  touchStart = null;
  moved = false;
});
trackpad.addEventListener('pointercancel', event => {
  if (joystickPointerId !== null && event.pointerId !== joystickPointerId) return;
  stopJoystick(); touchStart = null; moved = false;
});

window.addEventListener('pagehide', () => {
  if (mouseHeld) command({ type: 'mouse_up', button: 'left' });
});

// Open directly on the remote and connect automatically.
loadShortcuts();
connect();
