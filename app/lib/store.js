'use strict';
// Tiny JSON-file persistence: atomic writes (tmp + rename), optional debounced writes.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.pending = new Map(); // name -> { timer, get }
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name);
  }

  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`store: could not read ${name}:`, e.message);
      return fallback;
    }
  }

  write(name, data) {
    const file = this.file(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  /** Coalesce frequent writes (e.g. every vote) into one write per `delay` ms. */
  writeSoon(name, get, delay = 300) {
    const p = this.pending.get(name);
    if (p) {
      p.get = get;
      return;
    }
    const entry = { get, timer: null };
    entry.timer = setTimeout(() => {
      this.pending.delete(name);
      this.write(name, entry.get());
    }, delay);
    this.pending.set(name, entry);
  }

  flush() {
    for (const [name, p] of this.pending) {
      clearTimeout(p.timer);
      this.write(name, p.get());
    }
    this.pending.clear();
  }
}

module.exports = { JsonStore };
