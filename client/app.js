// ── Config ──────────────────────────────────────────────────────────
// Point this at your signaling server (see /server folder).
const SIGNALING_SERVER_URL = "http://localhost:3001";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" } // free public STUN server, just for NAT traversal
];

// ── DOM refs ────────────────────────────────────────────────────────
const joinScreen = document.getElementById("join-screen");
const chatScreen = document.getElementById("chat-screen");
const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const joinStatus = document.getElementById("join-status");
const roomLabel = document.getElementById("room-label");
const connStatus = document.getElementById("conn-status");
const leaveBtn = document.getElementById("leave-btn");
const messagesEl = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendBtn = messageForm.querySelector("button");

// ── State ───────────────────────────────────────────────────────────
let socket = null;
let pc = null;          // RTCPeerConnection
let dataChannel = null; // the actual P2P chat pipe
let username = "";
let roomId = "";

// ── Persistence (per-room, per-browser) ────────────────────────────
function historyKey(room) {
  return `p2p-chat-history:${room}`;
}

function loadHistory(room) {
  try {
    const raw = localStorage.getItem(historyKey(room));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveMessage(room, entry) {
  const history = loadHistory(room);
  history.push(entry);
  localStorage.setItem(historyKey(room), JSON.stringify(history));
}

// ── UI helpers ──────────────────────────────────────────────────────
function addMessageToUI({ text, sender, self, timestamp }) {
  const div = document.createElement("div");
  div.className = `msg ${sender === "system" ? "system" : self ? "me" : "them"}`;

  if (sender === "system") {
    div.textContent = text;
  } else {
    const time = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.innerHTML = `${escapeHtml(text)}<span class="meta">${self ? "You" : escapeHtml(sender)} · ${time}</span>`;
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function setConnected(isConnected) {
  connStatus.textContent = isConnected ? "connected" : "connecting…";
  connStatus.classList.toggle("connected", isConnected);
  messageInput.disabled = !isConnected;
  sendBtn.disabled = !isConnected;
  if (isConnected) messageInput.focus();
}

// ── Join flow ───────────────────────────────────────────────────────
joinBtn.addEventListener("click", () => {
  username = usernameInput.value.trim();
  roomId = roomInput.value.trim();

  if (!username || !roomId) {
    joinStatus.textContent = "Please enter both a name and a room code.";
    return;
  }

  joinStatus.textContent = "";
  startConnection();
});

function startConnection() {
  socket = io(SIGNALING_SERVER_URL);

  socket.on("connect_error", () => {
    joinStatus.textContent = "Could not reach signaling server. Is it running?";
  });

  socket.on("room-full", () => {
    joinStatus.textContent = "That room already has 2 people. Try another room code.";
  });

  socket.on("joined", async ({ isInitiator }) => {
    showChatScreen();
    createPeerConnection();

    if (isInitiator) {
      // Second person to arrive creates the data channel + offer.
      dataChannel = pc.createDataChannel("chat");
      setupDataChannel();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { roomId, data: { type: "offer", sdp: offer } });
    }
  });

  socket.on("peer-joined", ({ username: peerName }) => {
    addMessageToUI({ text: `${peerName} joined the room.`, sender: "system" });
  });

  socket.on("peer-left", ({ username: peerName }) => {
    addMessageToUI({ text: `${peerName} left the room.`, sender: "system" });
    setConnected(false);
  });

  socket.on("signal", async ({ data }) => {
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { roomId, data: { type: "answer", sdp: answer } });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "candidate" && data.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn("Failed to add ICE candidate", err);
      }
    }
  });

  socket.emit("join-room", { roomId, username });
}

function showChatScreen() {
  joinScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  roomLabel.textContent = `Room: ${roomId}`;

  // Load and render any saved history for this room.
  const history = loadHistory(roomId);
  history.forEach((entry) => addMessageToUI({ ...entry, self: entry.sender === username }));
}

// ── WebRTC setup ────────────────────────────────────────────────────
function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { roomId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") setConnected(true);
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) setConnected(false);
  };
}

function setupDataChannel() {
  dataChannel.onopen = () => setConnected(true);
  dataChannel.onclose = () => setConnected(false);

  dataChannel.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    const entry = { text: payload.text, sender: payload.sender, timestamp: payload.timestamp };
    addMessageToUI({ ...entry, self: false });
    saveMessage(roomId, entry);
  };
}

// ── Sending messages ────────────────────────────────────────────────
messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;

  const entry = { text, sender: username, timestamp: Date.now() };
  dataChannel.send(JSON.stringify(entry));

  addMessageToUI({ ...entry, self: true });
  saveMessage(roomId, entry);

  messageInput.value = "";
});

// ── Leaving ─────────────────────────────────────────────────────────
leaveBtn.addEventListener("click", () => {
  if (dataChannel) dataChannel.close();
  if (pc) pc.close();
  if (socket) socket.disconnect();

  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  messagesEl.innerHTML = "";
  joinStatus.textContent = "";
  setConnected(false);
});
