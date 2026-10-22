# P2P Chat

A real-time, peer-to-peer chat app. Messages travel **directly between browsers**
over WebRTC — the server is only used briefly to help two peers find each other.

## How it works

1. Two people open the client and enter the same **room code**.
2. The **signaling server** (Node + Socket.IO) introduces them to each other —
   it relays a WebRTC "offer/answer" handshake and ICE candidates, nothing more.
3. Once connected, a **WebRTC DataChannel** opens directly between the two
   browsers. All chat messages flow through that — the server never sees them.
4. Each browser saves its chat history to `localStorage`, keyed by room code,
   so refreshing the page keeps your messages.

Currently supports **2 people per room** (keeps the WebRTC handshake simple).
See "Extending to group chat" below if you want more.

## 1. Run the signaling server

```bash
cd server
npm install
npm start
```

This starts the server on `http://localhost:3001`.

## 2. Run the client

The client is plain HTML/CSS/JS — no build step. Simplest way to serve it locally:

```bash
cd client
npx serve .
# or: python3 -m http.server 5500
```

Then open the printed URL (e.g. `http://localhost:3000` or `http://localhost:5500`)
in **two different browser tabs/windows** (or two different devices on the same network).

In each tab:
- Enter a name
- Enter the *same* room code in both tabs
- Click "Join Room"

You should see "connected" appear, and messages sent from one tab appear
instantly in the other — via a direct P2P connection.

## Deploying for real use (not just localhost)

- **Signaling server**: deploy `server/` anywhere that runs Node (Render, Railway,
  Fly.io, a VPS, etc). Update `SIGNALING_SERVER_URL` in `client/app.js` to point
  to that deployed URL.
- **Client**: it's static files — deploy to Vercel, Netlify, GitHub Pages, or
  any static host.
- **NAT traversal**: the public Google STUN server (used by default) works for
  most home/office networks. For strict corporate networks or symmetric NATs,
  you may need a TURN server (e.g. via [Twilio](https://www.twilio.com/stun-turn)
  or [coturn](https://github.com/coturn/coturn)) as a relay fallback — add it to
  `ICE_SERVERS` in `client/app.js`.
- **HTTPS**: WebRTC requires HTTPS in production (localhost is exempt). Most
  static hosts give you this for free.

## Extending to group chat (3+ people)

The current design does a simple 1-to-1 handshake. To support groups, the most
common approach is a **full mesh**: each new peer opens a separate
RTCPeerConnection + DataChannel with every existing peer in the room. The
signaling server already supports N people joining a room (`rooms.get(roomId)`);
you'd extend the `join-room`/`signal` handlers to broadcast to *all* existing
peers (not just one), and have the client keep a `Map` of peerId → RTCPeerConnection
instead of a single `pc` variable.

## Project structure

```
p2p-chat/
├── server/
│   ├── package.json
│   └── server.js       # signaling only — never sees chat messages
├── client/
│   ├── index.html
│   ├── style.css
│   └── app.js           # WebRTC + Socket.IO + localStorage logic
└── README.md
```

## Connection reliability update

- Rejoin the room whenever Socket.IO reconnects.
- Process signaling in order and buffer ICE candidates until remote SDP exists.
- Close departed peer connections before allowing a replacement peer.
- Enable messaging and calls only after the data channel opens.
- Display waiting, server failure, timeout, and retry states.
- Reject malformed joins, duplicate memberships, and cross-room signaling.
- Add an accessible message label and improve narrow-screen layouts.

Run the dependency-free regression checks from the repository root:

```bash
node --test tests/connection.test.cjs
node --check client/app.js
node --check server/server.js
```

These checks use simulated browser and signaling objects. They do not verify
actual WebRTC connectivity, TURN availability, file transfers, or media calls.
Test those in two real devices on different networks before release.

Deploy both components: update the Node signaling service from `server/` and
publish `client/` to Netlify. This source update does not change either live deployment.

### Remaining security work

The existing client contains static TURN credentials. Treat those as public,
rotate them at the provider, and replace long-lived credentials with a
server-issued short-lived credential flow. A room code is also an invitation,
not authenticated user identity. Use unpredictable room codes and do not treat
this prototype as a hardened private messaging service.
