// ── Config ──────────────────────────────────────────────────────────
const SIGNALING_SERVER_URL = "http://localhost:3001"; // <-- change to your deployed server URL

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // Free public TURN server (Open Relay Project) — relays traffic when a
  // direct P2P connection isn't possible, e.g. one side is on mobile data.
  { urls: "stun:stun.relay.metered.ca:80" },
  {
    urls: "turn:relay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:relay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:relay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject"
  }
];

const FILE_CHUNK_SIZE = 16 * 1024;       // 16KB per chunk, safe for most browsers
const MAX_FILE_SIZE = 50 * 1024 * 1024;  // 50MB cap — everything held in memory
const TYPING_TIMEOUT_MS = 2500;

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
const sendBtn = messageForm.querySelector("button[type=submit]");
const typingIndicator = document.getElementById("typing-indicator");

const fileBtn = document.getElementById("file-btn");
const fileInput = document.getElementById("file-input");
const emojiBtn = document.getElementById("emoji-btn");
const emojiPicker = document.getElementById("emoji-picker");

const voiceCallBtn = document.getElementById("voice-call-btn");
const videoCallBtn = document.getElementById("video-call-btn");
const callPanel = document.getElementById("call-panel");
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const toggleMicBtn = document.getElementById("toggle-mic-btn");
const toggleCamBtn = document.getElementById("toggle-cam-btn");
const endCallBtn = document.getElementById("end-call-btn");

// ── State ───────────────────────────────────────────────────────────
let socket = null;
let pc = null;
let dataChannel = null;
let username = "";
let roomId = "";
let isInitiator = false;
let polite = false;       // perfect-negotiation role
let makingOffer = false;
let ignoreOffer = false;

let localStream = null;
let inCall = false;
let callHasVideo = false;
let micOn = true;
let camOn = true;

let typingTimeout = null;
let peerIsTyping = false;

let receivingFile = null; // { id, name, mime, size, chunks: [], received }

// ── Persistence ─────────────────────────────────────────────────────
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

function persistHistory(room, history) {
  try {
    // Don't blow up localStorage with big base64 files — cap what we persist.
    const trimmed = history.slice(-300);
    localStorage.setItem(historyKey(room), JSON.stringify(trimmed));
  } catch (err) {
    console.warn("Could not persist chat history (storage full?)", err);
  }
}

function saveMessage(entry) {
  const history = loadHistory(roomId);
  history.push(entry);
  persistHistory(roomId, history);
}

function updateStoredMessage(id, updates) {
  const history = loadHistory(roomId);
  const idx = history.findIndex((m) => m.id === id);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    persistHistory(roomId, history);
  }
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── UI: messages ────────────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessage(entry) {
  const self = entry.sender === username;
  const div = document.createElement("div");
  div.className = `msg ${entry.sender === "system" ? "system" : self ? "me" : "them"}`;
  div.dataset.id = entry.id || "";

  if (entry.sender === "system") {
    div.textContent = entry.text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  let body = "";

  if (entry.file) {
    if (entry.file.mime && entry.file.mime.startsWith("image/") && entry.file.url) {
      body += `<img class="chat-image" src="${entry.file.url}" alt="${escapeHtml(entry.file.name)}" />`;
    } else if (entry.file.url) {
      body += `<div class="file-chip">📄 <a href="${entry.file.url}" download="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</a> <span>(${formatBytes(entry.file.size)})</span></div>`;
    } else {
      body += `<div class="file-chip">📄 ${escapeHtml(entry.file.name)} <span class="file-progress">sending… ${entry.file.progress || 0}%</span></div>`;
    }
  }

  if (entry.text) {
    body += `<div>${escapeHtml(entry.text)}</div>`;
  }

  const ticks = self
    ? `<span class="ticks ${entry.read ? "read" : ""}">${entry.read ? "✓✓" : "✓"}</span>`
    : "";

  body += `<span class="meta">${self ? "You" : escapeHtml(entry.sender)} · ${formatTime(entry.timestamp)}${ticks}</span>`;
  body += `<span class="react-trigger" data-id="${entry.id}">➕</span>`;
  body += `<div class="reactions"></div>`;

  div.innerHTML = body;
  messagesEl.appendChild(div);
  renderReactions(entry.id, entry.reactions || {});
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

function renderReactions(messageId, reactions) {
  const el = messagesEl.querySelector(`.msg[data-id="${messageId}"] .reactions`);
  if (!el) return;
  el.innerHTML = "";
  Object.entries(reactions).forEach(([emoji, senders]) => {
    if (!senders.length) return;
    const span = document.createElement("span");
    span.textContent = `${emoji} ${senders.length}`;
    el.appendChild(span);
  });
}

function addSystemMessage(text) {
  renderMessage({ sender: "system", text });
}

function setConnected(isConnected) {
  connStatus.textContent = isConnected ? "connected" : "connecting…";
  connStatus.classList.toggle("connected", isConnected);
  messageInput.disabled = !isConnected;
  sendBtn.disabled = !isConnected;
  voiceCallBtn.disabled = !isConnected;
  videoCallBtn.disabled = !isConnected;
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

  socket.on("joined", async ({ isInitiator: initiatorFlag }) => {
    isInitiator = initiatorFlag;
    polite = !isInitiator; // the peer who joins second (initiator) is "impolite"; first is "polite"
    showChatScreen();
    createPeerConnection();

    if (isInitiator) {
      dataChannel = pc.createDataChannel("chat");
      setupDataChannel();
    }
  });

  socket.on("peer-joined", ({ username: peerName }) => {
    addSystemMessage(`${peerName} joined the room.`);
  });

  socket.on("peer-left", ({ username: peerName }) => {
    addSystemMessage(`${peerName} left the room.`);
    setConnected(false);
    endCall(false);
  });

  socket.on("signal", async ({ data }) => {
    try {
      if (data.type === "offer" || data.type === "answer") {
        const offerCollision =
          data.type === "offer" && (makingOffer || pc.signalingState !== "stable");

        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) return;

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        if (data.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { roomId, data: { type: "answer", sdp: answer } });
        }
      } else if (data.type === "candidate" && data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          if (!ignoreOffer) console.warn("Failed to add ICE candidate", err);
        }
      }
    } catch (err) {
      console.error("Signal handling error", err);
    }
  });

  socket.emit("join-room", { roomId, username });
}

function showChatScreen() {
  joinScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  roomLabel.textContent = `Room: ${roomId}`;

  const history = loadHistory(roomId);
  history.forEach((entry) => renderMessage(entry));
}

// ── WebRTC setup (perfect negotiation, supports adding media later) ──
function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", { roomId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { roomId, data: { type: "offer", sdp: offer } });
    } catch (err) {
      console.error("Negotiation error", err);
    } finally {
      makingOffer = false;
    }
  };

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    callPanel.classList.remove("hidden");
    inCall = true;
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") setConnected(true);
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) setConnected(false);
  };
}

// ── Data channel: multiplexed JSON control + binary file chunks ─────
function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";
  dataChannel.onopen = () => setConnected(true);
  dataChannel.onclose = () => setConnected(false);

  dataChannel.onmessage = (event) => {
    if (typeof event.data === "string") {
      const payload = JSON.parse(event.data);
      handleControlMessage(payload);
    } else {
      handleIncomingChunk(event.data);
    }
  };
}

function handleControlMessage(payload) {
  switch (payload.type) {
    case "chat": {
      const entry = {
        id: payload.id,
        text: payload.text,
        sender: payload.sender,
        timestamp: payload.timestamp,
        read: false,
        reactions: {}
      };
      renderMessage(entry);
      saveMessage(entry);
      sendControl({ type: "read", id: entry.id });
      setPeerTyping(false);
      break;
    }
    case "typing":
      setPeerTyping(true);
      break;
    case "stop-typing":
      setPeerTyping(false);
      break;
    case "read": {
      updateStoredMessage(payload.id, { read: true });
      const el = messagesEl.querySelector(`.msg[data-id="${payload.id}"] .ticks`);
      if (el) { el.classList.add("read"); el.textContent = "✓✓"; }
      break;
    }
    case "reaction": {
      const history = loadHistory(roomId);
      const msg = history.find((m) => m.id === payload.id);
      if (msg) {
        msg.reactions = msg.reactions || {};
        msg.reactions[payload.emoji] = msg.reactions[payload.emoji] || [];
        if (!msg.reactions[payload.emoji].includes(payload.sender)) {
          msg.reactions[payload.emoji].push(payload.sender);
        }
        persistHistory(roomId, history);
        renderReactions(payload.id, msg.reactions);
      }
      break;
    }
    case "file-meta": {
      receivingFile = {
        id: payload.id,
        name: payload.name,
        mime: payload.mime,
        size: payload.size,
        chunks: [],
        received: 0
      };
      const entry = {
        id: payload.id,
        sender: payload.sender,
        timestamp: payload.timestamp,
        read: false,
        reactions: {},
        file: { name: payload.name, mime: payload.mime, size: payload.size } // no url yet
      };
      renderMessage(entry);
      saveMessage(entry);
      sendControl({ type: "read", id: entry.id });
      break;
    }
    case "file-end": {
      if (receivingFile && receivingFile.id === payload.id) {
        const blob = new Blob(receivingFile.chunks, { type: receivingFile.mime || "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        updateStoredMessage(receivingFile.id, { file: { name: receivingFile.name, mime: receivingFile.mime, size: receivingFile.size, url } });
        const el = messagesEl.querySelector(`.msg[data-id="${receivingFile.id}"]`);
        if (el) {
          const fileArea = receivingFile.mime.startsWith("image/")
            ? `<img class="chat-image" src="${url}" alt="${escapeHtml(receivingFile.name)}" />`
            : `<div class="file-chip">📄 <a href="${url}" download="${escapeHtml(receivingFile.name)}">${escapeHtml(receivingFile.name)}</a> <span>(${formatBytes(receivingFile.size)})</span></div>`;
          const oldChip = el.querySelector(".file-chip, .chat-image");
          if (oldChip) oldChip.remove();
          el.insertAdjacentHTML("afterbegin", fileArea);
        }
        receivingFile = null;
      }
      break;
    }
    default:
      break;
  }
}

function handleIncomingChunk(buffer) {
  if (!receivingFile) return;
  receivingFile.chunks.push(buffer);
  receivingFile.received += buffer.byteLength;

  const pct = Math.min(100, Math.round((receivingFile.received / receivingFile.size) * 100));
  const el = messagesEl.querySelector(`.msg[data-id="${receivingFile.id}"] .file-progress`);
  if (el) el.textContent = `receiving… ${pct}%`;

  if (receivingFile.received >= receivingFile.size) {
    handleControlMessage({ type: "file-end", id: receivingFile.id });
  }
}

function sendControl(obj) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(obj));
  }
}

// ── Sending chat messages ───────────────────────────────────────────
messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") return;

  const entry = { id: genId(), text, sender: username, timestamp: Date.now(), read: false, reactions: {} };
  sendControl({ type: "chat", ...entry });
  renderMessage(entry);
  saveMessage(entry);

  messageInput.value = "";
  sendControl({ type: "stop-typing" });
});

// ── Typing indicator ─────────────────────────────────────────────────
messageInput.addEventListener("input", () => {
  sendControl({ type: "typing" });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendControl({ type: "stop-typing" }), TYPING_TIMEOUT_MS);
});

function setPeerTyping(isTyping) {
  peerIsTyping = isTyping;
  if (isTyping) {
    typingIndicator.textContent = "typing…";
    typingIndicator.classList.remove("hidden");
  } else {
    typingIndicator.classList.add("hidden");
  }
}

// ── Reactions ─────────────────────────────────────────────────────────
messagesEl.addEventListener("click", (e) => {
  if (e.target.classList.contains("react-trigger")) {
    const id = e.target.dataset.id;
    showMiniEmojiPicker(e.target, id);
  }
});

function showMiniEmojiPicker(anchor, messageId) {
  document.querySelectorAll(".mini-emoji-picker").forEach((el) => el.remove());
  const picker = document.createElement("div");
  picker.className = "mini-emoji-picker";
  ["👍", "❤️", "😂", "😮", "😢", "🎉"].forEach((emoji) => {
    const span = document.createElement("span");
    span.textContent = emoji;
    span.addEventListener("click", () => {
      addReaction(messageId, emoji);
      picker.remove();
    });
    picker.appendChild(span);
  });
  document.body.appendChild(picker);
  const rect = anchor.getBoundingClientRect();
  picker.style.top = `${rect.bottom + window.scrollY}px`;
  picker.style.left = `${rect.left + window.scrollX}px`;

  setTimeout(() => {
    document.addEventListener("click", function closeOnce(ev) {
      if (!picker.contains(ev.target)) {
        picker.remove();
        document.removeEventListener("click", closeOnce);
      }
    });
  }, 0);
}

function addReaction(messageId, emoji) {
  const history = loadHistory(roomId);
  const msg = history.find((m) => m.id === messageId);
  if (msg) {
    msg.reactions = msg.reactions || {};
    msg.reactions[emoji] = msg.reactions[emoji] || [];
    if (!msg.reactions[emoji].includes(username)) msg.reactions[emoji].push(username);
    persistHistory(roomId, history);
    renderReactions(messageId, msg.reactions);
  }
  sendControl({ type: "reaction", id: messageId, emoji, sender: username });
}

// ── Emoji picker for composing ─────────────────────────────────────
emojiBtn.addEventListener("click", () => emojiPicker.classList.toggle("hidden"));
emojiPicker.querySelectorAll("span").forEach((span) => {
  span.addEventListener("click", () => {
    messageInput.value += span.textContent;
    messageInput.focus();
    emojiPicker.classList.add("hidden");
  });
});

// ── File sending ─────────────────────────────────────────────────────
fileBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;

  if (!dataChannel || dataChannel.readyState !== "open") {
    addSystemMessage("Not connected yet — can't send file.");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    addSystemMessage(`"${file.name}" is too large (max ${formatBytes(MAX_FILE_SIZE)}).`);
    return;
  }

  const id = genId();
  const meta = { id, name: file.name, mime: file.type || "application/octet-stream", size: file.size, sender: username, timestamp: Date.now() };

  sendControl({ type: "file-meta", ...meta });

  // Show it locally too, with a local object URL (no need to wait for a round trip).
  const localUrl = URL.createObjectURL(file);
  const entry = { id, sender: username, timestamp: meta.timestamp, read: false, reactions: {}, file: { name: file.name, mime: file.type, size: file.size, url: localUrl } };
  renderMessage(entry);
  saveMessage(entry);

  await sendFileChunks(file);
  sendControl({ type: "file-end", id });
});

function sendFileChunks(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let offset = 0;

    function readNext() {
      const slice = file.slice(offset, offset + FILE_CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    }

    reader.onload = () => {
      try {
        dataChannel.send(reader.result);
      } catch (err) {
        reject(err);
        return;
      }
      offset += reader.result.byteLength;

      if (offset < file.size) {
        // Basic backpressure: wait if the send buffer is getting full.
        if (dataChannel.bufferedAmount > 4 * FILE_CHUNK_SIZE) {
          dataChannel.onbufferedamountlow = () => {
            dataChannel.onbufferedamountlow = null;
            readNext();
          };
        } else {
          readNext();
        }
      } else {
        resolve();
      }
    };

    reader.onerror = reject;
    readNext();
  });
}

// ── Voice / video calls ──────────────────────────────────────────────
voiceCallBtn.addEventListener("click", () => startCall(false));
videoCallBtn.addEventListener("click", () => startCall(true));
endCallBtn.addEventListener("click", () => endCall(true));

async function startCall(withVideo) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch (err) {
    addSystemMessage("Couldn't access microphone/camera. Check browser permissions.");
    console.error(err);
    return;
  }

  callHasVideo = withVideo;
  localVideo.srcObject = localStream;
  localVideo.classList.toggle("hidden", !withVideo);
  toggleCamBtn.classList.toggle("hidden", !withVideo);
  callPanel.classList.remove("hidden");
  inCall = true;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  // onnegotiationneeded fires automatically and handles the offer/answer exchange.
}

function endCall(notifyUI) {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (pc) {
    pc.getSenders().forEach((sender) => {
      if (sender.track) pc.removeTrack(sender);
    });
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  if (notifyUI) callPanel.classList.add("hidden");
  inCall = false;
}

toggleMicBtn.addEventListener("click", () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  toggleMicBtn.classList.toggle("muted", !micOn);
});

toggleCamBtn.addEventListener("click", () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
  toggleCamBtn.classList.toggle("muted", !camOn);
});

// ── Leaving ─────────────────────────────────────────────────────────
leaveBtn.addEventListener("click", () => {
  endCall(true);
  if (dataChannel) dataChannel.close();
  if (pc) pc.close();
  if (socket) socket.disconnect();

  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  messagesEl.innerHTML = "";
  joinStatus.textContent = "";
  setConnected(false);
});
