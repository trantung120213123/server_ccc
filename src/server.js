import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'node:http';
import { Server } from 'socket.io';
import { compileAndRun } from './services/compiler.js';

const app = express();
const port = process.env.PORT || 8080;
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST']
  }
});
const collabRooms = new Map();
const maxCollabUpdates = 2000;

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));
app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'cpp-online-backend',
    ok: true,
    message: 'C++ compile server is awake.'
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), at: new Date().toISOString() });
});

app.post('/api/run', async (req, res) => {
  const { code, stdin = '', flags = '' } = req.body ?? {};

  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Code is required.' });
  }

  if (code.length > 120_000) {
    return res.status(413).json({ ok: false, error: 'Code is too large.' });
  }

  try {
    const result = await compileAndRun({ code, stdin, flags });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      phase: 'server',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

io.on('connection', (socket) => {
  socket.emit('terminal', { event: 'connected', message: 'Socket terminal connected.' });

  socket.on('run-code', async (payload = {}) => {
    const { code, stdin = '', flags = '' } = payload;

    if (typeof code !== 'string' || code.trim().length === 0) {
      socket.emit('run-result', { ok: false, phase: 'validate', error: 'Code is required.' });
      return;
    }

    if (code.length > 120_000) {
      socket.emit('run-result', { ok: false, phase: 'validate', error: 'Code is too large.' });
      return;
    }

    const onEvent = (entry) => socket.emit('terminal', entry);

    try {
      onEvent({ event: 'queue', message: 'Run request received.' });
      const result = await compileAndRun({ code, stdin, flags, onEvent });
      socket.emit('run-result', result);
    } catch (error) {
      socket.emit('run-result', {
        ok: false,
        phase: 'server',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  socket.on('collab:join', ({ roomId, user } = {}) => {
    const room = normalizeRoomId(roomId);
    if (!room) {
      socket.emit('collab:error', { message: 'Room ID is required.' });
      return;
    }

    socket.data.collabRoom = room;
    socket.data.collabUser = normalizeUser(user);
    socket.join(room);

    const updates = collabRooms.get(room) ?? [];
    for (const update of updates) socket.emit('collab:update', update);

    socket.to(room).emit('collab:presence', {
      type: 'join',
      id: socket.id,
      user: socket.data.collabUser
    });

    socket.emit('collab:ready', {
      roomId: room,
      users: getRoomUsers(room)
    });
  });

  socket.on('collab:update', (payload) => {
    const room = socket.data.collabRoom;
    if (!room || !payload) return;

    const updates = collabRooms.get(room) ?? [];
    updates.push(payload);
    if (updates.length > maxCollabUpdates) updates.splice(0, updates.length - maxCollabUpdates);
    collabRooms.set(room, updates);
    socket.to(room).emit('collab:update', payload);
  });

  socket.on('collab:cursor', (payload = {}) => {
    const room = socket.data.collabRoom;
    if (!room) return;
    socket.to(room).emit('collab:cursor', {
      id: socket.id,
      user: socket.data.collabUser,
      ...payload
    });
  });

  socket.on('disconnect', () => {
    const room = socket.data.collabRoom;
    if (!room) return;
    socket.to(room).emit('collab:presence', {
      type: 'leave',
      id: socket.id,
      user: socket.data.collabUser
    });
  });
});

function normalizeRoomId(value) {
  return String(value ?? '').trim().slice(0, 80).replace(/[^\w.-]/g, '-');
}

function normalizeUser(user = {}) {
  return {
    name: String(user.name || 'Guest').trim().slice(0, 32) || 'Guest',
    color: /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#4fc1ff'
  };
}

function getRoomUsers(room) {
  const sockets = io.sockets.adapter.rooms.get(room) ?? new Set();
  return [...sockets].map((id) => {
    const client = io.sockets.sockets.get(id);
    return {
      id,
      user: client?.data?.collabUser ?? normalizeUser()
    };
  });
}

server.listen(port, () => {
  console.log(`C++ compile server listening on ${port}`);
});
