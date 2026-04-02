import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { app } from 'electron';

export interface ServiceStatus {
  api: 'running' | 'stopped' | 'starting' | 'error';
  worker: 'running' | 'stopped' | 'starting' | 'error';
}

interface ManagedProcess {
  process: ChildProcess | null;
  status: 'running' | 'stopped' | 'starting' | 'error';
  restartCount: number;
}

const MAX_RESTARTS = 5;

/**
 * Manages the API server and worker as child processes.
 * Automatically restarts crashed processes up to MAX_RESTARTS times.
 */
export class ServiceManager {
  private api: ManagedProcess = { process: null, status: 'stopped', restartCount: 0 };
  private worker: ManagedProcess = { process: null, status: 'stopped', restartCount: 0 };
  private onStatusChange: ((status: ServiceStatus) => void) | null = null;

  setStatusHandler(handler: (status: ServiceStatus) => void): void {
    this.onStatusChange = handler;
  }

  private getResourcePath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath);
    }
    // Development: use built files from monorepo
    return join(__dirname, '..', '..', '..');
  }

  private getEnv(): Record<string, string> {
    const base = this.getResourcePath();
    return {
      ...process.env as Record<string, string>,
      DESKTOP_MODE: 'true',
      USE_MOCK_IRONCLAW: 'false',
      NODE_ENV: 'production',
      API_PORT: '3100',
      WORKER_PORT: '3101',
      API_BASE_URL: 'http://localhost:3100',
      DATABASE_URL: process.env['DATABASE_URL'] || 'postgresql://root@localhost:26257/skytwin?sslmode=disable',
    };
  }

  async startAll(): Promise<void> {
    await this.startApi();
    // Wait for API to be ready before starting worker
    await this.waitForApi(10000);
    await this.startWorker();
  }

  private async startApi(): Promise<void> {
    this.api.status = 'starting';
    this.emitStatus();

    const base = this.getResourcePath();
    const apiEntry = app.isPackaged
      ? join(base, 'api', 'index.js')
      : join(base, 'apps', 'api', 'dist', 'index.js');

    try {
      this.api.process = fork(apiEntry, [], {
        env: this.getEnv(),
        stdio: 'pipe',
      });

      this.api.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[api] ${data.toString().trim()}`);
      });
      this.api.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[api] ${data.toString().trim()}`);
      });

      this.api.process.on('exit', (code) => {
        console.log(`[api] Process exited with code ${code}`);
        this.api.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && this.api.restartCount < MAX_RESTARTS) {
          this.api.restartCount++;
          console.log(`[api] Restarting (attempt ${this.api.restartCount}/${MAX_RESTARTS})...`);
          setTimeout(() => this.startApi(), 2000);
        } else if (this.api.restartCount >= MAX_RESTARTS) {
          this.api.status = 'error';
          this.emitStatus();
        }
      });

      this.api.status = 'running';
      this.api.restartCount = 0;
      this.emitStatus();
    } catch (err) {
      console.error('[api] Failed to start:', err);
      this.api.status = 'error';
      this.emitStatus();
    }
  }

  private async startWorker(): Promise<void> {
    this.worker.status = 'starting';
    this.emitStatus();

    const base = this.getResourcePath();
    const workerEntry = app.isPackaged
      ? join(base, 'worker', 'index.js')
      : join(base, 'apps', 'worker', 'dist', 'index.js');

    try {
      this.worker.process = fork(workerEntry, [], {
        env: this.getEnv(),
        stdio: 'pipe',
      });

      this.worker.process.stdout?.on('data', (data: Buffer) => {
        console.log(`[worker] ${data.toString().trim()}`);
      });
      this.worker.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[worker] ${data.toString().trim()}`);
      });

      this.worker.process.on('exit', (code) => {
        console.log(`[worker] Process exited with code ${code}`);
        this.worker.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && this.worker.restartCount < MAX_RESTARTS) {
          this.worker.restartCount++;
          console.log(`[worker] Restarting (attempt ${this.worker.restartCount}/${MAX_RESTARTS})...`);
          setTimeout(() => this.startWorker(), 2000);
        } else if (this.worker.restartCount >= MAX_RESTARTS) {
          this.worker.status = 'error';
          this.emitStatus();
        }
      });

      this.worker.status = 'running';
      this.worker.restartCount = 0;
      this.emitStatus();
    } catch (err) {
      console.error('[worker] Failed to start:', err);
      this.worker.status = 'error';
      this.emitStatus();
    }
  }

  async stopAll(): Promise<void> {
    if (this.api.process) {
      this.api.process.kill('SIGTERM');
      this.api.process = null;
      this.api.status = 'stopped';
    }
    if (this.worker.process) {
      this.worker.process.kill('SIGTERM');
      this.worker.process = null;
      this.worker.status = 'stopped';
    }
    this.emitStatus();
  }

  getStatus(): ServiceStatus {
    return {
      api: this.api.status,
      worker: this.worker.status,
    };
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }

  private async waitForApi(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch('http://localhost:3100/api/health');
        if (response.ok) return;
      } catch {
        // API not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn('[api] Health check timed out, starting worker anyway');
  }
}
