const IO_BUDGET_HARD_CEILING_BYTES = 5_368_709_120; // 5 GB — compile-time constant, never overridable

export interface ResourceGovernorOptions {
  cpuPercentCap: number;
  cpuWindowMs: number;
  yieldOnInputMs: number;
  batteryPctCap: number;
  thermalPauseStates: readonly string[];
  ioBudgetBytesPerDay: number;
  ioBudgetBytesHardCeiling: number;
  memoryRssCapBytes: number;
}

const GOVERNOR_DEFAULTS: ResourceGovernorOptions = {
  cpuPercentCap: 2,
  cpuWindowMs: 60_000,
  yieldOnInputMs: 200,
  batteryPctCap: 20,
  thermalPauseStates: ['serious', 'critical'],
  ioBudgetBytesPerDay: 1_073_741_824,
  ioBudgetBytesHardCeiling: IO_BUDGET_HARD_CEILING_BYTES,
  memoryRssCapBytes: 67_108_864,
};

export type PauseReason = 'cpu' | 'thermal' | 'battery' | 'io_budget' | 'memory' | 'user_input';

export interface ResourceGovernorState {
  paused: boolean;
  pauseReason?: PauseReason;
  cpuPctRolling: number;
  bytesScannedToday: number;
  rolledOverDate: string;
}

export interface ResourceGovernorPort {
  reportInputEvent(): void;
  reportThermalState(state: string): void;
  reportBatteryState(percent: number, isCharging: boolean): void;
  reportBytesRead(n: number): void;
  reportRssBytes(n: number): void;
  shouldYield(): boolean;
  state(): ResourceGovernorState;
}

interface CpuSample {
  timestampMs: number;
  elapsedMs: number;
  usageMs: number;
}

export interface ResourceGovernorDeps {
  nowMs?: () => number;
  cpuSampleMs?: () => number;
}

export class ResourceGovernor implements ResourceGovernorPort {
  private readonly opts: ResourceGovernorOptions;
  private readonly nowMs: () => number;
  private readonly cpuSampleMs: () => number;

  private lastInputMs = -Infinity;
  private thermalState = 'nominal';
  private batteryPct = 100;
  private batteryCharging = true;
  private bytesScannedToday = 0;
  private rssBytes = 0;
  private rolledOverDate: string;
  private cpuSamples: CpuSample[] = [];
  private lastCpuSampleMs = 0;

  constructor(opts: Partial<ResourceGovernorOptions> = {}, deps: ResourceGovernorDeps = {}) {
    const merged: ResourceGovernorOptions = { ...GOVERNOR_DEFAULTS, ...opts };
    // Hard ceiling enforcement — compile-time constant ceiling cannot be exceeded
    if (merged.ioBudgetBytesPerDay > IO_BUDGET_HARD_CEILING_BYTES) {
      throw new Error(
        `ioBudgetBytesPerDay (${merged.ioBudgetBytesPerDay}) exceeds the compile-time hard ceiling (${IO_BUDGET_HARD_CEILING_BYTES}). This limit is non-negotiable.`,
      );
    }
    // Ensure the option value also doesn't exceed the hard ceiling
    if (merged.ioBudgetBytesHardCeiling > IO_BUDGET_HARD_CEILING_BYTES) {
      throw new Error(
        `ioBudgetBytesHardCeiling cannot exceed the compile-time constant ${IO_BUDGET_HARD_CEILING_BYTES}.`,
      );
    }
    this.opts = merged;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.cpuSampleMs = deps.cpuSampleMs ?? (() => {
      const usage = process.cpuUsage();
      return (usage.user + usage.system) / 1000;
    });
    this.rolledOverDate = this.todayUtc();
  }

  private todayUtc(): string {
    return new Date(this.nowMs()).toISOString().slice(0, 10);
  }

  private rolloverIfNeeded(): void {
    const today = this.todayUtc();
    if (today !== this.rolledOverDate) {
      this.bytesScannedToday = 0;
      this.rolledOverDate = today;
    }
  }

  reportInputEvent(): void {
    this.lastInputMs = this.nowMs();
  }

  reportThermalState(state: string): void {
    this.thermalState = state;
  }

  reportBatteryState(percent: number, isCharging: boolean): void {
    this.batteryPct = percent;
    this.batteryCharging = isCharging;
  }

  reportBytesRead(n: number): void {
    this.rolloverIfNeeded();
    this.bytesScannedToday += n;
  }

  reportRssBytes(n: number): void {
    this.rssBytes = n;
  }

  private recordCpuSample(): void {
    const now = this.nowMs();
    const elapsed = now - this.lastCpuSampleMs;
    if (this.lastCpuSampleMs === 0 || elapsed < 100) {
      this.lastCpuSampleMs = now;
      return;
    }
    const usageMs = this.cpuSampleMs();
    this.cpuSamples.push({ timestampMs: now, elapsedMs: elapsed, usageMs });
    this.lastCpuSampleMs = now;
    // Prune samples older than window
    const cutoff = now - this.opts.cpuWindowMs;
    this.cpuSamples = this.cpuSamples.filter((s) => s.timestampMs >= cutoff);
  }

  private rollingCpuPct(): number {
    if (this.cpuSamples.length === 0) return 0;
    const totalElapsed = this.cpuSamples.reduce((sum, s) => sum + s.elapsedMs, 0);
    const totalUsage = this.cpuSamples.reduce((sum, s) => sum + s.usageMs, 0);
    if (totalElapsed === 0) return 0;
    return (totalUsage / totalElapsed) * 100;
  }

  shouldYield(): boolean {
    this.rolloverIfNeeded();
    this.recordCpuSample();

    const now = this.nowMs();

    if (now - this.lastInputMs <= this.opts.yieldOnInputMs) {
      return true;
    }
    if (this.rollingCpuPct() > this.opts.cpuPercentCap) {
      return true;
    }
    if (this.opts.thermalPauseStates.includes(this.thermalState)) {
      return true;
    }
    if (!this.batteryCharging && this.batteryPct < this.opts.batteryPctCap) {
      return true;
    }
    if (this.bytesScannedToday >= this.opts.ioBudgetBytesPerDay) {
      return true;
    }
    if (this.rssBytes > this.opts.memoryRssCapBytes) {
      return true;
    }
    return false;
  }

  state(): ResourceGovernorState {
    this.rolloverIfNeeded();
    const now = this.nowMs();
    let paused = false;
    let pauseReason: PauseReason | undefined;

    if (now - this.lastInputMs <= this.opts.yieldOnInputMs) {
      paused = true;
      pauseReason = 'user_input';
    } else if (this.rollingCpuPct() > this.opts.cpuPercentCap) {
      paused = true;
      pauseReason = 'cpu';
    } else if (this.opts.thermalPauseStates.includes(this.thermalState)) {
      paused = true;
      pauseReason = 'thermal';
    } else if (!this.batteryCharging && this.batteryPct < this.opts.batteryPctCap) {
      paused = true;
      pauseReason = 'battery';
    } else if (this.bytesScannedToday >= this.opts.ioBudgetBytesPerDay) {
      paused = true;
      pauseReason = 'io_budget';
    } else if (this.rssBytes > this.opts.memoryRssCapBytes) {
      paused = true;
      pauseReason = 'memory';
    }

    return {
      paused,
      pauseReason,
      cpuPctRolling: this.rollingCpuPct(),
      bytesScannedToday: this.bytesScannedToday,
      rolledOverDate: this.rolledOverDate,
    };
  }
}
