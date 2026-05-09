/**
 * docker-stdio-transport.ts — MCP Transport implementation backed by a
 * pre-spawned Docker container's stdin/stdout.
 *
 * The MCP SDK's StdioClientTransport spawns a process internally and owns the
 * child process lifecycle. DockerStdioTransport instead receives pre-existing
 * Readable/Writable streams (from spawnInDockerNoNetworkAsync) so that the
 * Docker process lifecycle can be managed externally.
 *
 * This transport is structurally identical to StdioClientTransport but reads
 * from the provided streams rather than spawning anything itself.
 */

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';
import type { DockerSpawnResult } from './docker-spawn.js';

export class DockerStdioTransport implements Transport {
  private readonly _spawn: DockerSpawnResult;
  private readonly _readBuffer = new ReadBuffer();
  private _started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(spawnResult: DockerSpawnResult) {
    this._spawn = spawnResult;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error(
        'DockerStdioTransport already started. If using Client, note that connect() calls start() automatically.',
      );
    }
    this._started = true;

    const stdout: Readable = this._spawn.stdout;
    const stderr: Readable = this._spawn.stderr;

    stdout.on('data', (chunk: Buffer) => {
      this._readBuffer.append(chunk);
      this._processReadBuffer();
    });

    stdout.on('error', (err: Error) => {
      this.onerror?.(err);
    });

    stderr.on('data', (chunk: Buffer) => {
      // Forward stderr to host stderr for visibility — do not suppress.
      // Never forward to the MCP message stream.
      process.stderr.write(chunk);
    });

    // Wire exit → onclose so the McpHost circuit breaker gets notified.
    this._spawn.waitExit().then(({ code, signal }) => {
      process.stderr.write(
        `[docker-stdio-transport] container exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
      );
      this._readBuffer.clear();
      this.onclose?.();
    }).catch(() => {
      this._readBuffer.clear();
      this.onclose?.();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin: Writable = this._spawn.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error('[docker-stdio-transport] stdin is not available or already destroyed'));
        return;
      }
      const json = serializeMessage(message);
      if (stdin.write(json)) {
        resolve();
      } else {
        stdin.once('drain', resolve);
        stdin.once('error', reject);
      }
    });
  }

  async close(): Promise<void> {
    try {
      this._spawn.stdin.end();
    } catch {
      // ignore — stdin may already be closed
    }
    await this._spawn.kill();
    this._readBuffer.clear();
  }

  private _processReadBuffer(): void {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) break;
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
