'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomName, Set<WebSocket>>
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.isTransmitting = false;
  ws.username = null;
  ws.room = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Raw audio chunk — forward to room peers
      forwardAudio(ws, data);
    } else {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleControl(ws, msg);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

function handleControl(ws, msg) {
  switch (msg.type) {
    case 'join': {
      const username = String(msg.username || '').trim().slice(0, 32);
      const room = String(msg.room || 'general').trim().slice(0, 64);
      if (!username) return;

      ws.username = username;
      ws.room = room;

      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);

      // Tell the joining client who is already here
      sendJSON(ws, {
        type: 'room_info',
        room,
        users: getRoomUsers(room),
      });

      // Tell everyone else in the room about the new arrival
      broadcast(room, { type: 'user_joined', username, users: getRoomUsers(room) }, ws);
      break;
    }

    case 'transmit_start': {
      if (!ws.room) return;
      const room = rooms.get(ws.room);
      if (!room) return;

      // Only one person may transmit at a time (walkie-talkie rule)
      for (const client of room) {
        if (client !== ws && client.isTransmitting) {
          sendJSON(ws, { type: 'channel_busy', username: client.username });
          return;
        }
      }

      ws.isTransmitting = true;
      broadcast(ws.room, { type: 'transmit_start', username: ws.username });
      break;
    }

    case 'transmit_end': {
      if (!ws.room) return;
      ws.isTransmitting = false;
      broadcast(ws.room, { type: 'transmit_end', username: ws.username });
      break;
    }

    default:
      break;
  }
}

function forwardAudio(ws, data) {
  if (!ws.isTransmitting || !ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  for (const client of room) {
    if (client !== ws && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function handleDisconnect(ws) {
  if (!ws.room) return;
  ws.isTransmitting = false;
  const room = rooms.get(ws.room);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    rooms.delete(ws.room);
  } else {
    broadcast(ws.room, {
      type: 'user_left',
      username: ws.username,
      users: getRoomUsers(ws.room),
    });
  }
  ws.room = null;
}

function broadcast(roomName, msg, exclude = null) {
  const room = rooms.get(roomName);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const client of room) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendJSON(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getRoomUsers(roomName) {
  const room = rooms.get(roomName);
  if (!room) return [];
  return Array.from(room)
    .map((c) => c.username)
    .filter(Boolean);
}

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ClassChitChat running on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, wss, rooms };
