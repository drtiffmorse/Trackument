'use strict';
// A real Postgres engine for the tests: PGlite (Postgres compiled to
// WebAssembly, in memory) behind a local socket. server.js reaches it through
// the real pg driver, exactly the way it reaches Railway's Postgres, so every
// query in server.js runs unchanged against real Postgres behavior.

async function startDatabase() {
  const { PGlite } = require('@electric-sql/pglite');
  const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 100 });
  await socket.start();
  // sslmode=disable overrides the ssl setting in server.js, which is meant for
  // Railway's proxy and would refuse a local connection.
  const url = 'postgres://postgres:postgres@127.0.0.1:' + socket.port + '/postgres?sslmode=disable';
  return {
    url,
    async stop() {
      await socket.stop();
      await db.close();
    },
  };
}

// Lets a test hold or fail one specific query inside server.js. This is how
// the tests line up two requests at exactly the moment that matters, instead
// of hoping the timing works out.
function createQueryControl() {
  let rules = [];
  return {
    get active() { return rules.length > 0; },

    // Holds the next query whose SQL matches `pattern` until release() is
    // called. `reached` resolves when that query is being held.
    pauseBefore(pattern) {
      let reached;
      let release;
      const reachedPromise = new Promise(resolve => { reached = resolve; });
      const releasePromise = new Promise(resolve => { release = resolve; });
      rules.push({ pattern, kind: 'pause', reached, releasePromise });
      return { reached: reachedPromise, release };
    },

    // Makes the next query whose SQL matches `pattern` fail.
    failNext(pattern, error = new Error('Simulated database failure')) {
      rules.push({ pattern, kind: 'fail', error });
    },

    clear() { rules = []; },

    async before(sql) {
      const rule = rules.find(r => r.pattern.test(sql));
      if (!rule) return;
      rules = rules.filter(r => r !== rule);
      if (rule.kind === 'fail') throw rule.error;
      rule.reached();
      await rule.releasePromise;
    },
  };
}

// The pg module server.js receives: the real driver, with each query passing
// through the control above first. With no rule set, queries go straight
// through untouched.
function hookedPg(realPg, control, pools) {
  class Client extends realPg.Client {
    query(config, values, callback) {
      if (!control.active) return super.query(config, values, callback);
      if (typeof values === 'function') { callback = values; values = undefined; }
      const sql = typeof config === 'string' ? config : String((config && config.text) || '');
      const run = () => super.query(config, values, callback);
      const gate = control.before(sql);
      if (callback) { gate.then(run, callback); return undefined; }
      return gate.then(run);
    }
  }
  class Pool extends realPg.Pool {
    constructor(config = {}) {
      super({ ...config, Client });
      pools.push(this);
    }
  }
  return Object.assign(Object.create(realPg), { Pool, Client });
}

module.exports = { startDatabase, createQueryControl, hookedPg };
