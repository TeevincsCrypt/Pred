// One demo per browser session, so concurrent visitors (e.g. judges on a
// public deployment) never step through each other's scenario. Sessions are
// created lazily, evicted after inactivity, and capped.

import { createDemo } from './runner.js';

export function createDemoSessions({ max = 40, ttlMs = 30 * 60_000, demoOpts = {} } = {}) {
  const sessions = new Map();

  function wire(s) {
    s.unsub?.();
    s.unsub = s.demo.engine.onChange(() => s.notify());
  }

  function evict() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > ttlMs && !s.listeners.size) drop(id);
    while (sessions.size > max) {
      const idle = [...sessions.entries()].filter(([, s]) => !s.listeners.size).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) break;
      drop(idle[0]);
    }
  }

  function drop(id) {
    const s = sessions.get(id);
    if (!s) return;
    s.demo.autoplay(false);
    s.unsub?.();
    sessions.delete(id);
  }

  const timer = setInterval(evict, 60_000);
  timer.unref?.();

  return {
    get size() {
      return sessions.size;
    },
    get(id) {
      const key = /^[a-zA-Z0-9_-]{6,64}$/.test(id || '') ? id : 'shared';
      let s = sessions.get(key);
      if (!s) {
        s = {
          id: key,
          demo: createDemo(demoOpts),
          listeners: new Set(),
          lastUsed: Date.now(),
          notify() {
            for (const fn of s.listeners) fn();
          },
        };
        wire(s);
        sessions.set(key, s);
        evict();
      }
      s.lastUsed = Date.now();
      return s;
    },
    reset(s) {
      s.demo.reset();
      wire(s);
      s.notify();
    },
  };
}
