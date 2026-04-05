import { fork, type ChildProcess } from 'child_process';
import { join } from 'path';
import { app } from 'electron';

export type ProcessState = 'running' | 'stopped' | 'starting' | 'error' | 'paused';

export interface ServiceStatus {
  api: ProcessState;
  worker: ProcessState;
  overall: 'healthy' | 'degraded' | 'failed';
}

interface ManagedProcess {
  process: ChildProcess | null;
  status: ProcessState;
  restartCount: number;
  failureTimestamps: number[];
}

const MAX_RESTARTS = 5;
const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_INTERVAL_MS = 5000;
const RESTART_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Manages the API server and worker as child processes.
 * Health monitoring every 5s, restart with exponential backoff,
 * 5 failures in 5 minutes marks as failed.
 */
export class ServiceManager {
  private api: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [] };
  private worker: ManagedProcess = { process: null, status: 'stopped', restartCount: 0, failureTimestamps: [] };
  private onStatusChange: ((status: ServiceStatus) => void) | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  setStatusHandler(handler: (status: ServiceStatus) => void): void {
    this.onStatusChange = handler;
  }

  private getResourcePath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath);
    }
    return join(__dirname, '..', '..', '..');
  }

  private getEnv(): Record<string, string> {
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
    this.paused = false;
    await this.startApi();
    const apiReady = await this.waitForApi(10000);
    if (apiReady) {
      this.api.restartCount = 0;
      this.api.failureTimestamps = [];
    }
    await this.startWorker();
    setTimeout(() => {
      if (this.worker.status === 'running') {
        this.worker.restartCount = 0;
        this.worker.failureTimestamps = [];
      }
    }, 3000);

    this.startHealthMonitoring();
  }

  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = setInterval(() => this.runHealthCheck(), HEALTH_CHECK_INTERVAL_MS);
  }

  private async runHealthCheck(): Promise<void> {
    if (this.paused) return;

    // Check API health
    if (this.api.status === 'running') {
      try {
        const response = await fetch('http://localhost:3100/api/health');
        if (!response.ok) {
          this.recordFailure(this.api, 'api');
        }
      } catch {
        this.recordFailure(this.api, 'api');
      }
    }

    // Check worker is still alive (process-level check)
    if (this.worker.status === 'running' && this.worker.process && !this.worker.process.connected) {
      this.recordFailure(this.worker, 'worker');
    }
  }

  private recordFailure(managed: ManagedProcess, name: string): void {
    const now = Date.now();
    managed.failureTimestamps.push(now);
    // Trim old timestamps outside the window
    managed.failureTimestamps = managed.failureTimestamps.filter(
      (t) => now - t < FAILURE_WINDOW_MS,
    );

    if (managed.failureTimestamps.length >= MAX_RESTARTS) {
      console.error(`[${name}] ${MAX_RESTARTS} failures in ${FAILURE_WINDOW_MS / 60000} minutes — marking as failed`);
      managed.status = 'error';
      this.emitStatus();
    }
  }

  private getRestartDelay(restartCount: number): number {
    return RESTART_DELAYS[Math.min(restartCount, RESTART_DELAYS.length - 1)];
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
        this.api.process = null;
        this.api.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && !this.paused) {
          this.api.restartCount++;
          this.recordFailure(this.api, 'api');
          if (this.api.status as ProcessState !== 'error') {
            const delay = this.getRestartDelay(this.api.restartCount);
            console.log(`[api] Restarting in ${delay}ms (attempt ${this.api.restartCount})...`);
            setTimeout(() => this.startApi(), delay);
          }
        }
      });

      this.api.status = 'running';
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
        this.worker.process = null;
        this.worker.status = 'stopped';
        this.emitStatus();
        if (code !== 0 && !this.paused) {
          this.worker.restartCount++;
          this.recordFailure(this.worker, 'worker');
          if (this.worker.status as ProcessState !== 'error') {
            const delay = this.getRestartDelay(this.worker.restartCount);
            console.log(`[worker] Restarting in ${delay}ms (attempt ${this.worker.restartCount})...`);
            setTimeout(() => this.startWorker(), delay);
          }
        }
      });

      this.worker.status = 'running';
      this.emitStatus();
    } catch (err) {
      console.error('[worker] Failed to start:', err);
      this.worker.status = 'error';
      this.emitStatus();
    }
  }

  /**
   * Pause the twin — stops the worker (no new signals) but keeps API running.
   */
  async pause(): Promise<void> {
    this.paused = true;
    await this.stopProcess(this.worker, 'worker');
    this.worker.status = 'paused';
    this.emitStatus();
  }

  /**
   * Resume the twin — restarts the worker.
   */
  async resume(): Promise<void> {
    this.paused = false;
    this.worker.restartCount = 0;
    this.worker.failureTimestamps = [];
    await this.startWorker();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async stopProcess(managed: ManagedProcess, name: string): Promise<void> {
    if (!managed.process) return;

    const proc = managed.process;
    managed.process = null;

    proc.kill('SIGTERM');

    // Wait up to 5s, then SIGKILL
    await new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
          console.warn(`[${name}] Force-killed after 5s timeout`);
        } catch {
          // Already dead
        }
        resolve();
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
    });

    managed.status = 'stopped';
  }

  async stopAll(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    await Promise.all([
      this.stopProcess(this.api, 'api'),
      this.stopProcess(this.worker, 'worker'),
    ]);
    this.emitStatus();
  }

  getStatus(): ServiceStatus {
    const apiState = this.api.status;
    const workerState = this.worker.status;

    let overall: 'healthy' | 'degraded' | 'failed';
    if (apiState === 'error' && workerState === 'error') {
      overall = 'failed';
    } else if (apiState === 'error' || workerState === 'error') {
      overall = 'degraded';
    } else if (apiState === 'running' && (workerState === 'running' || workerState === 'paused')) {
      overall = 'healthy';
    } else {
      overall = 'degraded';
    }

    return { api: apiState, worker: workerState, overall };
  }

  getUptime(): number {
    return process.uptime();
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.getStatus());
  }

  private async waitForApi(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch('http://localhost:3100/api/health');
        if (response.ok) return true;
      } catch {
        // API not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn('[api] Health check timed out, starting worker anyway');
    return false;
  }
}
