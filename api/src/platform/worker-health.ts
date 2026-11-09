import { createServer, type Server } from 'node:http';
import { setInterval, clearInterval } from 'node:timers';
import type { Database } from './database';

export class WorkerHealth {
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private server?: Server;
  private stopping = false;
  private lastHeartbeat = 0;
  private lastMaintenance = 0;
  constructor(
    readonly db: Database,
    readonly id: string,
  ) {}
  ready() {
    return (
      !this.stopping &&
      Date.now() - this.lastHeartbeat < 90_000 &&
      Date.now() - this.lastMaintenance < 300_000
    );
  }
  async start(port: number, host: string) {
    await this.beat();
    this.timer = setInterval(() => {
      if (!this.flight && !this.stopping) {
        this.flight = this.beat()
          .catch(() => {
            process.stderr.write('{"event":"worker.heartbeat-failed"}\n');
          })
          .finally(() => {
            this.flight = undefined;
          });
      }
    }, 10_000);
    this.server = createServer((request, response) => {
      if (request.method !== 'GET' || !['/health/live', '/health/ready'].includes(request.url ?? '')) {
        response.writeHead(404).end();
        return;
      }
      const ready = request.url === '/health/live' ? !this.stopping : this.ready();
      response
        .writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ status: ready ? 'ready' : 'not-ready' }));
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(port, host, () => resolve());
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Worker health listener unavailable.');
    return address.port;
  }
  private async beat() {
    await this.db.query(
      'INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET seen_at=clock_timestamp()',
      [this.id],
    );
    this.lastHeartbeat = Date.now();
  }
  async maintained() {
    await this.db.query('UPDATE worker_heartbeats SET maintenance_at=clock_timestamp() WHERE id=$1', [
      this.id,
    ]);
    this.lastMaintenance = Date.now();
  }
  async failed() {
    await this.db.query('UPDATE worker_heartbeats SET last_error_at=clock_timestamp() WHERE id=$1', [
      this.id,
    ]);
  }
  async close() {
    this.stop();
    if (this.timer) clearInterval(this.timer);
    await this.flight;
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await this.db.query('DELETE FROM worker_heartbeats WHERE id=$1', [this.id]).catch(() => {});
  }
  stop() {
    this.stopping = true;
  }
}
