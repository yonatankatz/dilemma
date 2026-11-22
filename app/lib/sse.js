'use strict';
// Server-Sent Events hub. Each client gets its own computed view (phones see only their
// own state). Notifications are coalesced so a burst of votes causes one push per client.

class SseHub {
  /**
   * @param {object} views
   * @param {(pid: string) => object} views.public
   * @param {() => object} views.host
   */
  constructor(views, { throttleMs = 150, heartbeatMs = 20000 } = {}) {
    this.views = views;
    this.clients = new Set();
    this.throttleMs = throttleMs;
    this.pendingScope = null;
    this.timer = null;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  /** @param {'public'|'host'} kind */
  connect(req, res, kind, pid) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const client = { res, kind, pid };
    this.clients.add(client);
    this.send(client);
    req.on('close', () => this.clients.delete(client));
  }

  send(client) {
    const view = client.kind === 'host' ? this.views.host() : this.views.public(client.pid);
    client.res.write(`data: ${JSON.stringify(view)}\n\n`);
  }

  /** @param {'all'|'hosts'} scope */
  notify(scope) {
    this.pendingScope = this.pendingScope === 'all' || scope === 'all' ? 'all' : 'hosts';
    if (this.timer) return;
    this.timer = setTimeout(() => {
      const s = this.pendingScope;
      this.timer = null;
      this.pendingScope = null;
      let hostView;
      for (const c of this.clients) {
        if (c.kind === 'host') {
          hostView = hostView || JSON.stringify(this.views.host());
          c.res.write(`data: ${hostView}\n\n`);
        } else if (s === 'all') {
          this.send(c);
        }
      }
    }, this.throttleMs);
  }

  counts() {
    let host = 0;
    for (const c of this.clients) if (c.kind === 'host') host++;
    return { host, public: this.clients.size - host };
  }
}

module.exports = { SseHub };
