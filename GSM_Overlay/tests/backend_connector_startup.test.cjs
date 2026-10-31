const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const BackendConnector = require('../backend_connector');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; sockets.push(this); }
    close() {}
    send() {}
  }
  const backend = new BackendConnector(null, () => null, { WebSocket: Socket });
  t.after(() => backend.destroy());
  backend.connect('ws://127.0.0.1:7275/overlay');
  return { backend, sockets };
}

test('retries promptly while the backend starts and avoids duplicate error/close timers', (t) => {
  const { backend, sockets } = setup(t);
  sockets[0].emit('error', new Error('ECONNREFUSED'));
  sockets[0].emit('close');
  t.mock.timers.tick(249);
  assert.equal(sockets.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 2);
  sockets[1].emit('open');
  assert.equal(backend.connected, true);
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 2);
});

test('backs off after sustained failure and resets after a successful connection', (t) => {
  const { sockets } = setup(t);
  for (let attempt = 0; attempt < 20; attempt++) {
    sockets.at(-1).emit('close');
    t.mock.timers.tick(1000);
    assert.equal(sockets.length, attempt + 2);
  }
  sockets.at(-1).emit('close');
  t.mock.timers.tick(4999);
  assert.equal(sockets.length, 21);
  t.mock.timers.tick(1);
  assert.equal(sockets.length, 22);
  sockets.at(-1).emit('open');
  sockets.at(-1).emit('close');
  t.mock.timers.tick(250);
  assert.equal(sockets.length, 23);
});

test('stopping the connector cancels pending startup retries', (t) => {
  const { backend, sockets } = setup(t);
  sockets[0].emit('close');
  backend.destroy();
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 1);
});
