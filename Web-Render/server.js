const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = Number(process.env.PORT || 3000);
// Relay authentication. The current package uses 1234 on both the phone UI and
// Windows agent. If Render still has an older REMOTE_TOKEN saved, we also accept
// that value so an existing deployment does not break during the upgrade.
const PACKAGE_RELAY_TOKEN = '1234';
const REMOTE_TOKEN = process.env.REMOTE_TOKEN || PACKAGE_RELAY_TOKEN;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'render-remote-relay' });
});

// One agent socket per device ID. Multiple controllers can connect to the same agent.
const agents = new Map();
const controllers = new Map();

function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function normalizeDeviceId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

function authenticate(message) {
  if (typeof message.token !== 'string') return false;
  return message.token === REMOTE_TOKEN || message.token === PACKAGE_RELAY_TOKEN;
}

function addController(deviceId, ws) {
  if (!controllers.has(deviceId)) controllers.set(deviceId, new Set());
  controllers.get(deviceId).add(ws);
}

function removeController(deviceId, ws) {
  const set = controllers.get(deviceId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) controllers.delete(deviceId);
}

function notifyControllers(deviceId, payload) {
  const set = controllers.get(deviceId);
  if (!set) return;
  for (const ws of set) safeSend(ws, payload);
}

function validateCommand(command) {
  if (!command || typeof command !== 'object') return false;

  const allowed = new Set([
    'move',
    'click',
    'scroll',
    'type',
    'navigate_url',
    'launch_app',
    'volume_set',
    'volume_mute_toggle',
    'key',
    'hotkey',
    'mouse_down',
    'mouse_up',
    'center_mouse',
    'verify_password',
    'system_action',
    'ping'
  ]);

  if (!allowed.has(command.type)) return false;

  if (command.type === 'move') {
    return Number.isFinite(command.dx) && Number.isFinite(command.dy) &&
      Math.abs(command.dx) <= 500 && Math.abs(command.dy) <= 500;
  }

  if (command.type === 'click') {
    return ['left', 'right', 'middle'].includes(command.button);
  }

  if (command.type === 'scroll') {
    return Number.isFinite(command.dy) && Math.abs(command.dy) <= 20;
  }

  if (command.type === 'type') {
    return typeof command.text === 'string' && command.text.length <= 2000;
  }

  if (command.type === 'navigate_url') {
    if (typeof command.url !== 'string' || command.url.length > 2048) return false;
    try {
      const parsed = new URL(command.url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  if (command.type === 'launch_app') {
    return typeof command.app === 'string' && /^[A-Za-z0-9_.-]+\.exe$/.test(command.app) && command.app.length <= 100;
  }

  if (command.type === 'volume_set') {
    return Number.isFinite(command.value) && command.value >= 0 && command.value <= 100;
  }

  if (command.type === 'volume_mute_toggle') return true;

  if (command.type === 'key') {
    return typeof command.key === 'string' && command.key.length <= 40;
  }

  if (command.type === 'hotkey') {
    return Array.isArray(command.keys) && command.keys.length >= 2 && command.keys.length <= 5 &&
      command.keys.every(key => typeof key === 'string' && key.length <= 40);
  }

  if (command.type === 'mouse_down' || command.type === 'mouse_up') {
    return ['left', 'right', 'middle'].includes(command.button);
  }

  if (command.type === 'center_mouse') return true;

  if (command.type === 'verify_password') {
    return typeof command.password === 'string' && command.password.length <= 128 &&
      (!command.requestId || (typeof command.requestId === 'string' && command.requestId.length <= 100));
  }

  if (command.type === 'system_action') {
    return ['shutdown', 'restart'].includes(command.action) &&
      typeof command.password === 'string' && command.password.length <= 128 &&
      (!command.requestId || (typeof command.requestId === 'string' && command.requestId.length <= 100));
  }

  return command.type === 'ping';
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = null;
  ws.deviceId = null;
  ws.authenticated = false;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return safeSend(ws, { type: 'error', message: 'Invalid JSON.' });
    }

    if (!ws.authenticated) {
      if (message.type !== 'auth') {
        return safeSend(ws, { type: 'error', message: 'Authenticate first.' });
      }

      const deviceId = normalizeDeviceId(message.deviceId);
      const role = message.role;

      if (!authenticate(message) || !deviceId || !['agent', 'controller'].includes(role)) {
        safeSend(ws, { type: 'auth_error', message: !deviceId ? 'Invalid device ID.' : 'Relay credentials do not match.' });
        return ws.close(4001, 'Unauthorized');
      }

      ws.authenticated = true;
      ws.role = role;
      ws.deviceId = deviceId;

      if (role === 'agent') {
        const previous = agents.get(deviceId);
        if (previous && previous !== ws) {
          safeSend(previous, { type: 'replaced', message: 'A newer agent connection replaced this one.' });
          previous.close(4002, 'Replaced');
        }
        agents.set(deviceId, ws);
        notifyControllers(deviceId, { type: 'agent_status', online: true });
      } else {
        addController(deviceId, ws);
      }

      safeSend(ws, {
        type: 'auth_ok',
        role,
        deviceId,
        agentOnline: agents.get(deviceId)?.readyState === WebSocket.OPEN
      });
      return;
    }

    if (ws.role === 'controller') {
      if (message.type !== 'command' || !validateCommand(message.command)) {
        return safeSend(ws, { type: 'error', message: 'Invalid command.' });
      }

      const agent = agents.get(ws.deviceId);
      if (!agent || agent.readyState !== WebSocket.OPEN) {
        return safeSend(ws, { type: 'agent_status', online: false });
      }

      safeSend(agent, {
        type: 'command',
        command: message.command
      });
      return;
    }

    if (ws.role === 'agent') {
      // The future laptop agent can send status/ack messages back to the phone.
      if (message.type === 'status' || message.type === 'ack') {
        notifyControllers(ws.deviceId, message);
      }
    }
  });

  ws.on('close', () => {
    if (!ws.authenticated || !ws.deviceId) return;

    if (ws.role === 'agent') {
      if (agents.get(ws.deviceId) === ws) {
        agents.delete(ws.deviceId);
        notifyControllers(ws.deviceId, { type: 'agent_status', online: false });
      }
    } else if (ws.role === 'controller') {
      removeController(ws.deviceId, ws);
    }
  });

  ws.on('error', err => {
    console.error('WebSocket error:', err.message);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Remote relay listening on 0.0.0.0:${PORT}`);
});
