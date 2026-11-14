const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const {closeWebSocket} = require('../socket_lifecycle');

test('stopping during a websocket handshake cancels without an unhandled error or reconnect', async () => {
  const socket = new WebSocket('ws://127.0.0.1:1');
  let reconnected = false;
  socket.on('close', () => { reconnected = true; });
  closeWebSocket(socket);
  await new Promise(resolve => socket.once('close', resolve));
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(reconnected, false);
  assert.equal(socket.listenerCount('error'), 0);
});
