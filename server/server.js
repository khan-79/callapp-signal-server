const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// room -> Map(socketId -> displayName)
const rooms = new Map();

// Serve the call UI itself (renderer/) so phones/laptops can open this same
// URL in a plain browser and use the app with no install at all. This folder
// lives one level up from server.js (project_root/renderer).
const clientDir = path.join(__dirname, '..', 'renderer');
app.use(express.static(clientDir));

// Simple health check, separate from the main page.
app.get('/health', (req, res) => {
  res.send('CallApp signaling server is running.');
});

io.on('connection', (socket) => {
  let currentRoom = null;
  let displayName = null;

  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') return;

    currentRoom = room;
    displayName = (name || 'Guest').slice(0, 40);

    if (!rooms.has(room)) rooms.set(room, new Map());
    const members = rooms.get(room);

    // Tell the newcomer who is already in the room
    const existingPeers = Array.from(members.entries()).map(([id, n]) => ({ id, name: n }));
    socket.emit('existing-peers', existingPeers);

    members.set(socket.id, displayName);
    socket.join(room);

    // Tell everyone else a new peer joined
    socket.to(room).emit('peer-joined', { id: socket.id, name: displayName });
  });

  // Relay WebRTC signaling data (offer / answer / ICE candidate) to a specific peer
  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Simple room-wide text chat
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    io.to(currentRoom).emit('chat-message', {
      from: socket.id,
      name: displayName,
      text: String(text).slice(0, 2000),
      ts: Date.now()
    });
  });

  socket.on('media-state', ({ audio, video }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('media-state', { id: socket.id, audio, video });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
