// Lightweight background task manager
// Provides: registerTask(fn, intervalMs, opts) -> id
//            unregisterTask(id)
//            start()
//            stop()
// Tasks are simple records with lastRun timestamps; a single loop runs every tickMs
const { setInterval, clearInterval } = global;

class BackgroundManager {
  constructor(tickMs = 250) {
    this.tickMs = tickMs;
    this.tasks = new Map();
    this.nextId = 1;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this._tick(), this.tickMs);
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  registerTask(fn, intervalMs, opts = {}) {
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      fn,
      intervalMs: Math.max(0, Math.floor(intervalMs)),
      lastRun: 0,
      running: false,
      opts
    });
    return id;
  }

  unregisterTask(id) {
    return this.tasks.delete(id);
  }

  async _tick() {
    const now = Date.now();
    for (const task of Array.from(this.tasks.values())) {
      try {
        if (task.intervalMs === 0) continue; // disabled
        if (now - task.lastRun >= task.intervalMs) {
          task.lastRun = now;
          // run but don't await to avoid blocking others
          const res = task.fn();
          if (res && res.then) {
            // swallow errors
            res.catch((e) => { console.error('Background task error', e); });
          }
        }
      } catch (e) {
        console.error('Error running background task', e);
      }
    }
  }
}

module.exports = new BackgroundManager(250);
