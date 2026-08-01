// Signaling server for P2P chat.
// IMPORTANT: this server never sees chat messages. It only helps two
// browsers find each other and exchange the info needed to open a
// direct WebRTC connection (offer, answer, ICE candidates). Once that
// connection is open, all chat traffic flows browser-to-browser.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // tighten this to your client's origin in production
});

const PORT = process.env.PORT || 3001;

// roomId -> array of { socketId, username }
const rooms = new Map();

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentUsername = null;

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !username) return;

    const existing = rooms.get(roomId) || [];

    if (existing.length >= 2) {
      socket.emit("room-full");
      return;
    }

    currentRoom = roomId;
    currentUsername = username;
    socket.join(roomId);
    existing.push({ socketId: socket.id, username });
    rooms.set(roomId, existing);

    const isInitiator = existing.length === 2;

    // Tell this client whether it should create the WebRTC offer.
    socket.emit("joined", { isInitiator, username });

    // Tell the other peer (if any) that someone joined.
    socket.to(roomId).emit("peer-joined", { username });
  });

  // Relay WebRTC signaling data verbatim between the two peers in a room.
  socket.on("signal", ({ roomId, data }) => {
    socket.to(roomId).emit("signal", { data, from: currentUsername });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom) || [];
    const remaining = peers.filter((p) => p.socketId !== socket.id);

    if (remaining.length === 0) {
      rooms.delete(currentRoom);
    } else {
      rooms.set(currentRoom, remaining);
    }

    socket.to(currentRoom).emit("peer-left", { username: currentUsername });
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
