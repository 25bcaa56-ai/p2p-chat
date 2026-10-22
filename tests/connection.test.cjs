const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function serverHarness() {
  let connected;
  class Server { on(event, fn) { connected = fn; } }
  vm.runInNewContext(source('server/server.js'), {
    require(name) {
      if (name === 'express') return () => ({});
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      if (name === 'socket.io') return { Server };
    }, process: { env: {} }, console
  });
  return () => {
    const handlers = {}, events = [], relays = [];
    const socket = {
      id: Math.random().toString(),
      on: (event, fn) => handlers[event] = fn,
      emit: (event, data) => events.push({ event, data }),
      join() {}, to: room => ({ emit: (event, data) => relays.push({ room, event, data }) })
    };
    connected(socket);
    return { handlers, events, relays };
  };
}

test('server rejects malformed joins and duplicate joins do not consume room slots', () => {
  const connect = serverHarness(), a = connect(), b = connect(), c = connect();
  for (const value of [null, {}, {roomId: {}, username: 'A'}, {roomId: 'r', username: ' '.repeat(2)}]) a.handlers['join-room'](value);
  assert.equal(a.events.filter(e => e.event === 'join-error').length, 4);
  a.handlers['join-room']({roomId: 'r', username: 'A'});
  a.handlers['join-room']({roomId: 'r', username: 'A'});
  b.handlers['join-room']({roomId: 'r', username: 'B'});
  assert.equal(b.events.at(-1).data.isInitiator, true);
  c.handlers['join-room']({roomId: 'r', username: 'C'});
  assert.equal(c.events.at(-1).event, 'room-full');
  b.handlers.disconnect();
  c.handlers['join-room']({roomId: 'r', username: 'C'});
  assert.equal(c.events.at(-1).event, 'joined');
});

test('server only relays signaling from members to their own room', () => {
  const a = serverHarness()();
  a.handlers.signal({roomId: 'other', data: {type: 'offer'}});
  assert.equal(a.relays.length, 0);
  a.handlers['join-room']({roomId: 'r', username: 'A'});
  a.relays.length = 0;
  a.handlers.signal(null);
  a.handlers.signal({roomId: 'other', data: {type: 'offer'}});
  a.handlers.signal({roomId: 'r', data: {type: 'chat'}});
  assert.equal(a.relays.length, 0);
  a.handlers.signal({roomId: 'r', data: {type: 'offer'}});
  assert.equal(a.relays.length, 1);
  assert.equal(a.relays[0].room, 'r');
});

function clientHarness() {
  const elements = new Map(), sockets = [], peers = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'chat-screen' ? ['hidden'] : []);
      elements.set(id, {
        value: '', textContent: '', innerHTML: '', disabled: false, handlers: {}, dataset: {},
        classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v), toggle(v, on) { if (on) classes.add(v); else classes.delete(v); } },
        addEventListener(event, fn) { this.handlers[event] = fn; },
        querySelector: () => element('send'), querySelectorAll: () => [],
        appendChild() {}, focus() {},
      });
    }
    return elements.get(id);
  }
  class Peer {
    constructor() { peers.push(this); this.signalingState = 'stable'; this.candidates = []; }
    createDataChannel() { return {readyState: 'connecting', close() {this.readyState = 'closed';}}; }
    getSenders() { return []; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate(c) { assert.ok(this.remoteDescription); this.candidates.push(c); }
    async createAnswer() { return {type: 'answer', sdp: 'answer'}; }
    async setLocalDescription(sdp) { this.localDescription = sdp; }
  }
  const context = vm.createContext({
    document: { getElementById: element, createElement: () => element('new'), querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    RTCPeerConnection: Peer,
    io: () => {
      const socket = {handlers: {}, sent: [], on(event, fn) {this.handlers[event] = fn;}, emit(event, data) {this.sent.push({event, data});}, disconnect() {this.handlers.disconnect?.();}};
      sockets.push(socket); return socket;
    },
    console, setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, window: {}
  });
  vm.runInContext(source('client/app.js'), context);
  return { context, elements, sockets, peers, run: code => vm.runInContext(code, context) };
}

test('client rejoins on signaling reconnect and buffers ICE until SDP arrives', async () => {
  const h = clientHarness();
  h.run('username = "A"; roomId = "r"; startConnection();');
  const s = h.sockets[0];
  s.handlers.connect();
  s.handlers.joined({isInitiator: false});
  const p = h.peers[0];
  s.handlers.signal({data: {type: 'candidate', candidate: {candidate: 'test'}}});
  await h.run('signalQueue');
  assert.equal(p.candidates.length, 0);
  s.handlers.signal({data: {type: 'offer', sdp: {type: 'offer', sdp: 'test'}}});
  await h.run('signalQueue');
  assert.equal(p.candidates.length, 1);
  assert.equal(s.sent.at(-1).data.data.type, 'answer');
  s.handlers.disconnect(); s.handlers.connect();
  assert.equal(s.sent.filter(e => e.event === 'join-room').length, 2);
  assert.equal(p.connectionState, 'closed');
});

test('client waits for data channel and replaces departed peer connection', () => {
  const h = clientHarness();
  h.run('username = "A"; roomId = "r"; startConnection();');
  const s = h.sockets[0];
  s.handlers.joined({isInitiator: true});
  h.run('setConnected(true)');
  assert.equal(h.elements.get('send').disabled, true);
  h.run('dataChannel.readyState = "open"; dataChannel.onopen()');
  assert.equal(h.elements.get('send').disabled, false);
  s.handlers['peer-left']({username: 'B'});
  assert.equal(h.peers[0].connectionState, 'closed');
  assert.equal(h.peers.length, 2);
  assert.equal(h.elements.get('send').disabled, true);
});
