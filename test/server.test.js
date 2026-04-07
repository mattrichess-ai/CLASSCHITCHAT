'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// Import the server module without starting it automatically
const { server, rooms } = require('../server.js');

// ── Helpers ───────────────────────────────────────────────────
let baseURL;

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseURL = `ws://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Open a WS connection and wait for it to be OPEN */
function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseURL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Collect the next JSON message from a socket */
function nextJSON(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data, isBinary) => {
      if (isBinary) return reject(new Error('Expected JSON, got binary'));
      resolve(JSON.parse(data.toString()));
    });
    ws.once('error', reject);
  });
}

/** Join a room and return the room_info message */
async function joinRoom(ws, username, room = 'general') {
  const infoPromise = nextJSON(ws);
  ws.send(JSON.stringify({ type: 'join', username, room }));
  return infoPromise;
}

/** Wait for ms milliseconds */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tests ─────────────────────────────────────────────────────
describe('server — join / room management', () => {
  it('sends room_info on join', async () => {
    const ws = await openWS();
    const info = await joinRoom(ws, 'Alice', 'testroom1');
    assert.equal(info.type, 'room_info');
    assert.equal(info.room, 'testroom1');
    assert.ok(info.users.includes('Alice'));
    ws.close();
  });

  it('broadcasts user_joined to existing members', async () => {
    const ws1 = await openWS();
    await joinRoom(ws1, 'Bob', 'testroom2');

    // ws1 should receive user_joined when Alice joins
    const joinedPromise = nextJSON(ws1);
    const ws2 = await openWS();
    await joinRoom(ws2, 'Alice', 'testroom2');

    const joined = await joinedPromise;
    assert.equal(joined.type, 'user_joined');
    assert.equal(joined.username, 'Alice');
    assert.ok(joined.users.includes('Bob'));
    assert.ok(joined.users.includes('Alice'));

    ws1.close();
    ws2.close();
  });

  it('broadcasts user_left when a client disconnects', async () => {
    const ws1 = await openWS();
    await joinRoom(ws1, 'Carol', 'testroom3');

    const ws2 = await openWS();
    const joinedMsg = nextJSON(ws1); // consume user_joined for ws2
    await joinRoom(ws2, 'Dave', 'testroom3');
    await joinedMsg;

    // ws1 should receive user_left after ws2 closes
    const leftPromise = nextJSON(ws1);
    ws2.close();
    const left = await leftPromise;
    assert.equal(left.type, 'user_left');
    assert.equal(left.username, 'Dave');
    assert.ok(!left.users.includes('Dave'));

    ws1.close();
  });

  it('rejects empty username (no join message sent back)', async () => {
    const ws = await openWS();
    ws.send(JSON.stringify({ type: 'join', username: '', room: 'emptytest' }));
    // Give server time to process; no room should be created
    await wait(100);
    assert.ok(!rooms.has('emptytest'), 'Room should not have been created for empty username');
    ws.close();
  });
});

describe('server — push-to-talk channel locking', () => {
  it('broadcasts transmit_start and transmit_end', async () => {
    const room = 'ptt1';
    const ws1 = await openWS();
    await joinRoom(ws1, 'Eve', room);
    const ws2 = await openWS();
    const joinedForWs2 = nextJSON(ws1); // consume user_joined
    await joinRoom(ws2, 'Frank', room);
    await joinedForWs2;

    // ws2 listens for transmit_start from ws1
    const startPromise = nextJSON(ws2);
    ws1.send(JSON.stringify({ type: 'transmit_start' }));
    const startMsg = await startPromise;
    assert.equal(startMsg.type, 'transmit_start');
    assert.equal(startMsg.username, 'Eve');

    // ws2 listens for transmit_end from ws1
    const endPromise = nextJSON(ws2);
    ws1.send(JSON.stringify({ type: 'transmit_end' }));
    const endMsg = await endPromise;
    assert.equal(endMsg.type, 'transmit_end');
    assert.equal(endMsg.username, 'Eve');

    ws1.close();
    ws2.close();
  });

  it('returns channel_busy when second user tries to transmit', async () => {
    const room = 'ptt2';
    const ws1 = await openWS();
    await joinRoom(ws1, 'Grace', room);
    const ws2 = await openWS();

    const joinNotify = nextJSON(ws1);
    await joinRoom(ws2, 'Hank', room);
    await joinNotify; // consume user_joined

    // ws1 starts transmitting; broadcast goes to ws2 — consume it
    const startAtWs2 = nextJSON(ws2);
    ws1.send(JSON.stringify({ type: 'transmit_start' }));
    await startAtWs2;

    // ws2 tries to transmit while ws1 holds the channel
    const busyPromise = nextJSON(ws2);
    ws2.send(JSON.stringify({ type: 'transmit_start' }));
    const busyMsg = await busyPromise;
    assert.equal(busyMsg.type, 'channel_busy');
    assert.equal(busyMsg.username, 'Grace');

    ws1.close();
    ws2.close();
  });

  it('forwards binary audio only from the transmitting client', async () => {
    const room = 'ptt3';
    const [ws1, ws2] = await Promise.all([openWS(), openWS()]);
    await joinRoom(ws1, 'Iris', room);
    const notify = nextJSON(ws1);
    await joinRoom(ws2, 'Jake', room);
    await notify;

    // ws1 starts transmitting; consume the broadcast at ws2
    const startAtWs2 = nextJSON(ws2);
    ws1.send(JSON.stringify({ type: 'transmit_start' }));
    await startAtWs2;

    // ws2 should receive binary audio sent by ws1
    const audioPromise = new Promise((resolve, reject) => {
      ws2.once('message', (data, isBinary) => {
        if (!isBinary) return reject(new Error('Expected binary'));
        resolve(data);
      });
    });

    ws1.send(Buffer.from([1, 2, 3]));
    const received = await audioPromise;
    assert.deepEqual(Buffer.from(received), Buffer.from([1, 2, 3]));

    ws1.close();
    ws2.close();
  });

  it('does not forward binary audio if client is not transmitting', async () => {
    const room = 'ptt4';
    const [ws1, ws2] = await Promise.all([openWS(), openWS()]);
    await joinRoom(ws1, 'Kim', room);
    const notify = nextJSON(ws1);
    await joinRoom(ws2, 'Leo', room);
    await notify;

    let gotBinary = false;
    ws2.on('message', (_data, isBinary) => {
      if (isBinary) gotBinary = true;
    });

    // ws1 sends binary WITHOUT starting transmit
    ws1.send(Buffer.from([4, 5, 6]));

    await wait(150);
    assert.ok(!gotBinary, 'Should NOT have received binary audio');

    ws1.close();
    ws2.close();
  });
});
