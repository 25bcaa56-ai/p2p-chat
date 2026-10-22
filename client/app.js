// ── Config ──────────────────────────────────────────────────────────
const SIGNALING_SERVER_URL = "https://p2p-chat-fgkl.onrender.com"; // <-- change to your deployed server URL

const ICE_SERVERS = [
  { urls: "stun:stun.relay.metered.ca:80" },
  {
    urls: "turn:global.relay.metered.ca:80",
    username: "4c3927c1790c3beb7c652008",
    credential: "eFKT1+FTU+Zt218D"
  },
  {
    urls: "turn:global.relay.metered.ca:80?transport=tcp",
    username: "4c3927c1790c3beb7c652008",
    credential: "eFKT1+FTU+Zt218D"
  },
  {
    urls: "turn:global.relay.metered.ca:443",
    username: "4c3927c1790c3beb7c652008",
    credential: "eFKT1+FTU+Zt218D"
  },
  {
    urls: "turns:global.relay.metered.ca:443?transport=tcp",
    username: "4c3927c1790c3beb7c652008",
    credential: "eFKT1+FTU+Zt218D"
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
const callTimerEl = document.getElementById("call-timer");

const outgoingCallOverlay = document.getElementById("outgoing-call-overlay");
const outgoingCallLabel = document.getElementById("outgoing-call-label");
const cancelCallBtn = document.getElementById("cancel-call-btn");

const incomingCallOverlay = document.getElementById("incoming-call-overlay");
const incomingCallLabel = document.getElementById("incoming-call-label");
const acceptCallBtn = document.getElementById("accept-call-btn");
const declineCallBtn = document.getElementById("decline-call-btn");

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
let pendingCandidates = [];
let signalQueue = Promise.resolve();
let connectionTimer = null;

let localStream = null;
let inCall = false;
let callHasVideo = false;
let micOn = true;
let camOn = true;

// callState: "idle" | "calling" (we rang them) | "ringing" (they rang us) | "connected"
let callState = "idle";
let pendingCallId = null;
let pendingCallType = null; // "voice" | "video"
let ringAudioCtx = null;
let ringIntervalId = null;
let callTimerIntervalId = null;
let callStartTime = null;

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

function setConnected(isConnected, status = "Connecting to peer…") {
  const ready = isConnected && dataChannel?.readyState === "open";
  connStatus.textContent = ready ? "Connected" : status;
  connStatus.classList.toggle("connected", ready);
  messageInput.disabled = !ready;
  sendBtn.disabled = !ready;
  fileBtn.disabled = !ready;
  voiceCallBtn.disabled = !ready;
  videoCallBtn.disabled = !ready;
  document.getElementById("retry-btn").hidden = ready;
  if (ready) {
    clearTimeout(connectionTimer);
    messageInput.focus();
  }
}

function resetPeer() {
  clearTimeout(connectionTimer);
  hangUp(false);
  if (dataChannel) {
    dataChannel.onclose = null;
    dataChannel.close();
  }
  if (pc) {
    pc.onnegotiationneeded = null;
    pc.onconnectionstatechange = null;
    pc.onicecandidate = null;
    pc.close();
  }
  pc = null;
  dataChannel = null;
  pendingCandidates = [];
  makingOffer = false;
  ignoreOffer = false;
  receivingFile = null;
  clearTimeout(typingTimeout);
  setPeerTyping(false);
}

// ── Join flow ───────────────────────────────────────────────────────
joinBtn.addEventListener("click", () => {
  username = usernameInput.value.trim();
  roomId = roomInput.value.trim();
  if (!username || !roomId) {
    joinStatus.textContent = "Please enter both a name and a room code.";
    return;
  }
  joinStatus.textContent = "Contacting server… This may take a moment.";
  startConnection();
});

function startConnection() {
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.disconnect();
  }
  resetPeer();
  setConnected(false, "Contacting server…");
  joinBtn.disabled = true;
  const activeSocket = socket = io(SIGNALING_SERVER_URL);

  // Socket.IO reconnects with a new socket ID, so membership must be restored.
  socket.on("connect", () => {
    if (socket !== activeSocket) return;
    socket.emit("join-room", { roomId, username });
  });
  socket.on("disconnect", () => {
    if (socket !== activeSocket) return;
    resetPeer();
    setConnected(false, "Server disconnected — reconnecting…");
  });
  socket.on("connect_error", () => {
    if (socket !== activeSocket) return;
    joinBtn.disabled = false;
    joinStatus.textContent = "Cannot reach the server. Check your connection and try again.";
    setConnected(false, "Cannot reach server — retry");
  });
  const rejectJoin = (message) => {
    joinBtn.disabled = false;
    joinStatus.textContent = message;
    setConnected(false, message);
    if (socket === activeSocket) socket = null;
    activeSocket.disconnect();
  };
  socket.on("room-full", () => rejectJoin("That room already has 2 people. Try another room code."));
  socket.on("join-error", () => rejectJoin("Enter a valid name and room code."));
  socket.on("joined", ({ isInitiator: initiatorFlag }) => {
    if (socket !== activeSocket) return;
    resetPeer();
    isInitiator = initiatorFlag;
    polite = !isInitiator;
    joinBtn.disabled = false;
    if (chatScreen.classList.contains("hidden")) showChatScreen();
    createPeerConnection();
    setConnected(false, isInitiator ? "Connecting to peer…" : "Waiting for another person…");
    if (isInitiator) {
      dataChannel = pc.createDataChannel("chat");
      setupDataChannel();
    }
  });
  socket.on("peer-joined", ({ username: peerName }) => {
    addSystemMessage(`${peerName} joined the room.`);
    setConnected(false);
  });
  socket.on("peer-left", ({ username: peerName }) => {
    addSystemMessage(`${peerName} left the room.`);
    resetPeer();
    polite = true;
    createPeerConnection();
    setConnected(false, "Peer left — waiting for another person…");
  });
  socket.on("signal", ({ data }) => {
    // Serialize SDP/ICE work; async event callbacks otherwise race each other.
    const target = pc;
    signalQueue = signalQueue.then(async () => {
      if (!target || target !== pc || socket !== activeSocket) return;
      if (data.type === "offer" || data.type === "answer") {
        const collision = data.type === "offer" && (makingOffer || target.signalingState !== "stable");
        ignoreOffer = !polite && collision;
        if (ignoreOffer) return;
        await target.setRemoteDescription(data.sdp);
        if (target !== pc || socket !== activeSocket) return;
        for (const candidate of pendingCandidates.splice(0)) await target.addIceCandidate(candidate);
        if (data.type === "offer") {
          const answer = await target.createAnswer();
          if (target !== pc || socket !== activeSocket) return;
          await target.setLocalDescription(answer);
          if (target !== pc || socket !== activeSocket) return;
          activeSocket.emit("signal", { roomId, data: { type: "answer", sdp: target.localDescription } });
        }
      } else if (data.type === "candidate" && data.candidate && !ignoreOffer) {
        if (target.remoteDescription) await target.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    }).catch((err) => {
      console.error("Signal handling error", err);
      if (target === pc) setConnected(false, "Connection setup failed — retry");
    });
  });
}

document.getElementById("retry-btn").addEventListener("click", startConnection);

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
  const target = pc;
  const activeSocket = socket;

  pc.onicecandidate = (event) => {
    if (event.candidate && target === pc && socket === activeSocket) {
      activeSocket.emit("signal", { roomId, data: { type: "candidate", candidate: event.candidate } });
    }
  };

  pc.onnegotiationneeded = async () => {
    try {
      clearTimeout(connectionTimer);
      connectionTimer = setTimeout(() => {
        if (dataChannel?.readyState !== "open") setConnected(false, "Connection timed out — retry");
      }, 30000);
      makingOffer = true;
      const offer = await target.createOffer();
      if (target !== pc || socket !== activeSocket) return;
      await target.setLocalDescription(offer);
      if (target !== pc || socket !== activeSocket) return;
      activeSocket.emit("signal", { roomId, data: { type: "offer", sdp: target.localDescription } });
    } catch (err) {
      console.error("Negotiation error", err);
    } finally {
      if (target === pc) makingOffer = false;
    }
  };

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    // Call panel visibility/state is driven by the ring → accept flow above,
    // not directly by track arrival, so an incoming-call popup always shows
    // before any audio/video appears.
  };

  pc.onconnectionstatechange = () => {
    if (target !== pc) return;
    if (target.connectionState === "connected") setConnected(true);
    if (["disconnected", "failed", "closed"].includes(target.connectionState)) {
      setConnected(false, "Peer connection lost — retry");
    }
  };
}

// ── Data channel: multiplexed JSON control + binary file chunks ─────
function setupDataChannel() {
  dataChannel.binaryType = "arraybuffer";
  dataChannel.onopen = () => setConnected(true);
  dataChannel.onclose = () => setConnected(false);

  dataChannel.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const payload = JSON.parse(event.data);
        if (payload && typeof payload.type === "string") handleControlMessage(payload);
      } catch (err) {
        console.warn("Invalid peer message", err);
      }
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
    case "call-request": {
      if (callState !== "idle") {
        // We're already busy — auto-decline.
        sendControl({ type: "call-reject", id: payload.id });
        return;
      }
      pendingCallId = payload.id;
      pendingCallType = payload.callType;
      callState = "ringing";
      incomingCallLabel.textContent = `${payload.from} is calling… (${payload.callType === "video" ? "video" : "voice"} call)`;
      incomingCallOverlay.classList.remove("hidden");
      playRingSound();
      break;
    }
    case "call-accept": {
      if (callState === "calling" && payload.id === pendingCallId) {
        handleCallAccepted();
      }
      break;
    }
    case "call-reject": {
      if (payload.id === pendingCallId) {
        addSystemMessage("Call declined.");
        resetCallUI();
      }
      break;
    }
    case "call-cancel": {
      if (payload.id === pendingCallId) {
        addSystemMessage("Missed call.");
        resetCallUI();
      }
      break;
    }
    case "call-end": {
      addSystemMessage("Call ended.");
      hangUp(false);
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

// ── Voice / video calls: proper ring → accept/decline → connect flow ─
//
// Flow:
//  1. Caller clicks call button -> sends "call-request" over the data
//     channel (no mic/camera access yet) -> shows "Calling..." overlay.
//  2. Callee sees an incoming-call popup with a ring sound and Accept/Decline.
//  3. Callee clicks Accept -> only now does their browser ask for mic/camera
//     permission -> sends "call-accept".
//  4. On receiving "call-accept", the caller also grabs their mic/camera and
//     adds tracks to the peer connection, which triggers WebRTC renegotiation
//     automatically (see onnegotiationneeded above).
//  5. Either side can send "call-end" to hang up; "call-reject"/"call-cancel"
//     handle declining or giving up before it connects.

voiceCallBtn.addEventListener("click", () => initiateCall("voice"));
videoCallBtn.addEventListener("click", () => initiateCall("video"));
cancelCallBtn.addEventListener("click", () => cancelOutgoingCall());
acceptCallBtn.addEventListener("click", () => acceptIncomingCall());
declineCallBtn.addEventListener("click", () => declineIncomingCall());
endCallBtn.addEventListener("click", () => hangUp(true));

function initiateCall(callType) {
  if (callState !== "idle") return; // already in/starting a call
  if (!dataChannel || dataChannel.readyState !== "open") {
    addSystemMessage("Not connected yet — can't start a call.");
    return;
  }

  pendingCallId = genId();
  pendingCallType = callType;
  callState = "calling";

  sendControl({ type: "call-request", id: pendingCallId, callType, from: username });

  outgoingCallLabel.textContent = `Calling… (${callType === "video" ? "video" : "voice"} call)`;
  outgoingCallOverlay.classList.remove("hidden");
}

function cancelOutgoingCall() {
  if (pendingCallId) sendControl({ type: "call-cancel", id: pendingCallId });
  resetCallUI();
}

function declineIncomingCall() {
  stopRingSound();
  if (pendingCallId) sendControl({ type: "call-reject", id: pendingCallId });
  resetCallUI();
}

async function acceptIncomingCall() {
  stopRingSound();
  const callType = pendingCallType;
  const callId = pendingCallId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "video"
    });
  } catch (err) {
    addSystemMessage("Couldn't access microphone/camera. Check browser permissions.");
    console.error(err);
    sendControl({ type: "call-reject", id: callId });
    resetCallUI();
    return;
  }

  callHasVideo = callType === "video";
  setupCallPanelUI();

  sendControl({ type: "call-accept", id: callId });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  incomingCallOverlay.classList.add("hidden");
  enterConnectedCallState();
}

async function handleCallAccepted() {
  // Caller's side: the other person accepted, now we grab our own media.
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: pendingCallType === "video"
    });
  } catch (err) {
    addSystemMessage("Couldn't access microphone/camera. Check browser permissions.");
    console.error(err);
    sendControl({ type: "call-end", id: pendingCallId });
    resetCallUI();
    return;
  }

  callHasVideo = pendingCallType === "video";
  setupCallPanelUI();
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  outgoingCallOverlay.classList.add("hidden");
  enterConnectedCallState();
}

function setupCallPanelUI() {
  localVideo.srcObject = localStream;
  localVideo.classList.toggle("hidden", !callHasVideo);
  toggleCamBtn.classList.toggle("hidden", !callHasVideo);
  callPanel.classList.remove("hidden");
}

function enterConnectedCallState() {
  callState = "connected";
  inCall = true;
  callStartTime = Date.now();
  callTimerIntervalId = setInterval(updateCallTimer, 1000);
  updateCallTimer();
}

function updateCallTimer() {
  const secs = Math.floor((Date.now() - callStartTime) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  callTimerEl.textContent = `${mm}:${ss}`;
}

function hangUp(notifyPeer) {
  if (notifyPeer && callState !== "idle") {
    sendControl({ type: "call-end", id: pendingCallId });
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (pc) {
    pc.getSenders().forEach((sender) => {
      if (sender.track) pc.removeTrack(sender);
    });
  }
  resetCallUI();
}

function resetCallUI() {
  stopRingSound();
  clearInterval(callTimerIntervalId);
  callTimerIntervalId = null;
  callTimerEl.textContent = "00:00";

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  callPanel.classList.add("hidden");
  outgoingCallOverlay.classList.add("hidden");
  incomingCallOverlay.classList.add("hidden");

  callState = "idle";
  pendingCallId = null;
  pendingCallType = null;
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

// ── Ring sound (simple beeping tone, no audio file needed) ──────────
function playRingSound() {
  try {
    ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      if (!ringAudioCtx) return;
      const osc = ringAudioCtx.createOscillator();
      const gain = ringAudioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ringAudioCtx.currentTime);
      osc.connect(gain);
      gain.connect(ringAudioCtx.destination);
      osc.start();
      osc.stop(ringAudioCtx.currentTime + 0.3);
    };
    beep();
    ringIntervalId = setInterval(beep, 1200);
  } catch (err) {
    console.warn("Could not play ring sound", err);
  }
}

function stopRingSound() {
  clearInterval(ringIntervalId);
  ringIntervalId = null;
  if (ringAudioCtx) {
    ringAudioCtx.close();
    ringAudioCtx = null;
  }
}

// ── Leaving ─────────────────────────────────────────────────────────
leaveBtn.addEventListener("click", () => {
  if (socket) {
    const previousSocket = socket;
    socket = null;
    previousSocket.disconnect();
  }
  resetPeer();
  joinBtn.disabled = false;

  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  messagesEl.innerHTML = "";
  joinStatus.textContent = "";
  setConnected(false, "Waiting for another person…");
});
