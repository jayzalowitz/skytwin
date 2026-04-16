import { createHmac } from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ExecutionEvent,
  ExecutionResult,
  ExecutionStatus,
  IronClawRoutine,
  IronClawToolManifest,
  RollbackResult,
} from '@skytwin/shared-types';
import type { IronClawCredentialInfo } from './ironclaw-adapter.js';

/**
 * Configuration for the IronClaw HTTP client.
 */
export interface IronClawClientConfig {
  /** Base URL for the IronClaw server (e.g., http://localhost:4000) */
  apiUrl: string;

  /** HMAC-SHA256 secret for webhook authentication */
  webhookSecret: string;

  /** Bearer token for IronClaw's gateway/chat-compatible API */
  gatewayToken?: string;

  /** Owner ID for IronClaw's multi-tenant model */
  ownerId: string;

  /** Channel identifier sent to IronClaw. Default: 'skytwin' */
  channelId?: string;

  /** Default channel identifier. Alias for channelId for newer config. */
  defaultChannel?: string;

  /** Prefer /v1/chat/completions for execution when supported. Default: false */
  preferChatCompletions?: boolean;

  /** Request timeout in milliseconds. Default: 30000 */
  timeoutMs?: number;

  /** Max retries for transient failures. Default: 2 */
  maxRetries?: number;

  /** Circuit breaker: max failures before opening. Default: 5 */
  circuitBreakerThreshold?: number;

  /** Circuit breaker: window in ms to count failures. Default: 300000 (5 min) */
  circuitBreakerWindowMs?: number;
}

interface ResolvedIronClawClientConfig {
  apiUrl: string;
  webhookSecret: string;
  gatewayToken: string;
  ownerId: string;
  channelId: string;
  defaultChannel: string;
  preferChatCompletions: boolean;
  timeoutMs: number;
  maxRetries: number;
  circuitBreakerThreshold: number;
  circuitBreakerWindowMs: number;
}

/**
 * Message format for IronClaw's webhook endpoint.
 *
 * Maps to IronClaw's IncomingMessage (Rust):
 *   channel, user_id, owner_id, content, thread_id, attachments, metadata
 */
export interface IronClawMessage {
  channel: string;
  user_id: string;
  owner_id: string;
  content: string;
  thread_id?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

/**
 * Response from IronClaw's webhook endpoint.
 *
 * Maps to IronClaw's OutgoingResponse (Rust):
 *   content, thread_id, attachments, metadata
 */
export interface IronClawResponse {
  content: string;
  thread_id?: string;
  attachments: unknown[];
  metadata: Record<string, unknown>;
}

type CircuitEndpoint = 'webhook' | 'chat' | 'health' | 'credentials' | 'tools' | 'routines';

interface CircuitBreakerState {
  failures: { timestamp: number }[];
  open: boolean;
  openedAt: number | null;
  tripCount: number;
  cooldownMs: number;
}

const MAX_CIRCUIT_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * HTTP client for communicating with an IronClaw server.
 *
 * Handles HMAC-SHA256 authentication, retries with linear backoff,
 * SSE parsing, and per-endpoint circuit breaker protection.
 */
export class IronClawHttpClient {
  private readonly config: ResolvedIronClawClientConfig;
  private readonly circuitBreakers = new Map<CircuitEndpoint, CircuitBreakerState>();

  constructor(config: IronClawClientConfig) {
    const defaultChannel = config.defaultChannel ?? config.channelId ?? 'skytwin';
    this.config = {
      apiUrl: config.apiUrl,
      webhookSecret: config.webhookSecret,
      ownerId: config.ownerId,
      channelId: config.channelId ?? defaultChannel,
      defaultChannel,
      gatewayToken: config.gatewayToken ?? '',
      preferChatCompletions: config.preferChatCompletions ?? false,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 2,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitBreakerWindowMs: config.circuitBreakerWindowMs ?? 300_000,
    };
  }

  get preferChatCompletions(): boolean {
    return this.config.preferChatCompletions;
  }

  /**
   * Send a message to IronClaw's webhook endpoint.
   */
  async sendMessage(message: IronClawMessage): Promise<IronClawResponse> {
    const response = await this.sendWebhookRequest(message);
    return (await response.json()) as IronClawResponse;
  }

  /**
   * Send a webhook request and read IronClaw SSE execution progress.
   */
  async *sendMessageStreaming(message: IronClawMessage): AsyncIterable<ExecutionEvent> {
    const streamMessage: IronClawMessage = {
      ...message,
      metadata: {
        ...message.metadata,
        stream: true,
      },
    };
    const response = await this.sendWebhookRequest(streamMessage);
    const planId = this.readPlanId(streamMessage);
    let yielded = false;

    for await (const record of this.parseSseRecords(response.body, planId)) {
      yielded = true;
      yield this.normalizeExecutionEvent(planId, record);
    }

    if (!yielded) {
      yield {
        planId,
        eventType: 'plan_completed',
        timestamp: new Date(),
        payload: { source: 'ironclaw', emptyStream: true },
      };
    }
  }

  /**
   * Get execution status by sending a status query through the webhook API.
   */
  async getStatus(planId: string): Promise<ExecutionStatus> {
    const message: IronClawMessage = {
      channel: this.config.defaultChannel,
      user_id: 'skytwin-system',
      owner_id: this.config.ownerId,
      content: `Status for execution plan ${planId}.`,
      thread_id: planId,
      attachments: [],
      metadata: {
        skytwin: true,
        message_type: 'status',
        plan_id: planId,
      },
    };

    const response = await this.sendMessage(message);
    return this.parseExecutionStatus(response);
  }

  /**
   * Send a non-streaming OpenAI-compatible chat completion request.
   */
  async sendChatCompletion(
    messages: ChatMessage[],
    opts: { model?: string; stream?: boolean } = {},
  ): Promise<ChatCompletionResponse> {
    const response = await this.fetchWithRetries('chat', `${this.config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.bearerJsonHeaders(),
      body: JSON.stringify({
        model: opts.model ?? 'openclaw/default',
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw chat completion');

    const payload = await response.json() as Record<string, unknown>;
    return this.parseChatCompletionResponse(payload, opts.model);
  }

  /**
   * Send a streaming OpenAI-compatible chat completion request.
   */
  async *sendChatCompletionStreaming(
    messages: ChatMessage[],
    opts: { model?: string } = {},
  ): AsyncIterable<ChatCompletionChunk> {
    const response = await this.fetchWithRetries('chat', `${this.config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.bearerJsonHeaders(),
      body: JSON.stringify({
        model: opts.model ?? 'openclaw/default',
        messages,
        stream: true,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw chat completion stream');

    let finished = false;
    for await (const record of this.parseSseRecords(response.body, 'chat')) {
      if (record === '[DONE]') {
        finished = true;
        yield { delta: '', finished: true };
        continue;
      }

      const payload = typeof record === 'string' ? this.safeParseObject(record) : record;
      const choices = this.asRecordArray(payload['choices']);
      const first = choices[0];
      const delta = this.asRecord(first?.['delta']);
      const content = typeof delta['content'] === 'string' ? delta['content'] : '';
      const finishReason = first?.['finish_reason'];
      if (content || finishReason) {
        finished = Boolean(finishReason);
        yield { delta: content, finished };
      }
    }

    if (!finished) {
      yield { delta: '', finished: true };
    }
  }

  async registerCredential(
    name: string,
    value: string,
    opts: { ttlSeconds?: number } = {},
  ): Promise<{ success: boolean }> {
    await this.fetchWithRetries('credentials', `${this.config.apiUrl}/credentials`, {
      method: 'POST',
      headers: this.bearerJsonHeaders(),
      body: JSON.stringify({
        name,
        value,
        ttl_seconds: opts.ttlSeconds,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw credential registration');
    return { success: true };
  }

  async revokeCredential(name: string): Promise<{ success: boolean }> {
    await this.fetchWithRetries(
      'credentials',
      `${this.config.apiUrl}/credentials/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: this.bearerJsonHeaders(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
      'IronClaw credential revoke',
    );
    return { success: true };
  }

  async listCredentials(): Promise<IronClawCredentialInfo[]> {
    const response = await this.fetchWithRetries('credentials', `${this.config.apiUrl}/credentials`, {
      method: 'GET',
      headers: this.bearerJsonHeaders(),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw credential list');

    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload)
      ? payload
      : this.asRecordArray(this.asRecord(payload)['credentials']);

    return rows
      .map((row) => this.asRecord(row))
      .filter((row) => typeof row['name'] === 'string')
      .map((row) => ({
        name: row['name'] as string,
        configuredAt: this.readString(row, ['configuredAt', 'configured_at', 'createdAt', 'created_at']) ?? new Date().toISOString(),
        expiresAt: this.readString(row, ['expiresAt', 'expires_at']),
      }));
  }

  async discoverTools(): Promise<IronClawToolManifest[]> {
    const response = await this.fetchWithRetries('tools', `${this.config.apiUrl}/tools`, {
      method: 'GET',
      headers: this.bearerJsonHeaders(),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw tool discovery');

    const payload = await response.json() as unknown;
    const tools = Array.isArray(payload)
      ? payload
      : this.asRecordArray(this.asRecord(payload)['tools']);

    return tools
      .map((tool) => this.asRecord(tool))
      .filter((tool) => typeof tool['name'] === 'string')
      .map((tool) => ({
        name: tool['name'] as string,
        description: typeof tool['description'] === 'string' ? tool['description'] : '',
        actionTypes: this.readStringArray(tool, ['actionTypes', 'action_types', 'actions']),
        requiresCredentials: this.readStringArray(tool, ['requiresCredentials', 'requires_credentials', 'credentials']),
      }));
  }

  async createRoutine(userId: string, schedule: string, plan: Record<string, unknown>): Promise<{ routineId: string }> {
    const response = await this.fetchWithRetries('routines', `${this.config.apiUrl}/routines`, {
      method: 'POST',
      headers: this.bearerJsonHeaders(),
      body: JSON.stringify({ user_id: userId, schedule, plan }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw routine creation');

    const payload = this.asRecord(await response.json());
    const routineId = this.readString(payload, ['routineId', 'routine_id', 'id']);
    if (!routineId) {
      throw new Error('IronClaw routine creation response did not include a routine ID');
    }
    return { routineId };
  }

  async listRoutines(userId?: string): Promise<IronClawRoutine[]> {
    const url = new URL(`${this.config.apiUrl}/routines`);
    if (userId) url.searchParams.set('user_id', userId);

    const response = await this.fetchWithRetries('routines', url.toString(), {
      method: 'GET',
      headers: this.bearerJsonHeaders(),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw routine list');

    const payload = await response.json() as unknown;
    const routines = Array.isArray(payload)
      ? payload
      : this.asRecordArray(this.asRecord(payload)['routines']);

    return routines
      .map((routine) => this.asRecord(routine))
      .filter((routine) => typeof routine['id'] === 'string')
      .map((routine) => ({
        id: routine['id'] as string,
        schedule: this.readString(routine, ['schedule', 'cron']) ?? '',
        planSummary: this.readString(routine, ['planSummary', 'plan_summary', 'summary']) ?? '',
        lastRunAt: this.parseOptionalDate(this.readString(routine, ['lastRunAt', 'last_run_at'])),
        nextRunAt: this.parseOptionalDate(this.readString(routine, ['nextRunAt', 'next_run_at'])),
        enabled: routine['enabled'] !== false,
      }));
  }

  async deleteRoutine(routineId: string): Promise<{ success: boolean }> {
    await this.fetchWithRetries(
      'routines',
      `${this.config.apiUrl}/routines/${encodeURIComponent(routineId)}`,
      {
        method: 'DELETE',
        headers: this.bearerJsonHeaders(),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
      'IronClaw routine deletion',
    );
    return { success: true };
  }

  /**
   * Check IronClaw's health status.
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();

    try {
      const response = await fetch(`${this.config.apiUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      const latencyMs = Date.now() - start;

      if (response.ok) {
        // Only reset the health endpoint breaker — other endpoints may still be down
        // even if /health is responding. Individual endpoint breakers reset on their
        // own successful requests via fetchWithRetries.
        this.resetCircuitBreaker('health');
        return { healthy: true, latencyMs };
      }

      this.recordFailure('health');
      return { healthy: false, latencyMs };
    } catch {
      this.recordFailure('health');
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Parse an IronClaw response into a SkyTwin ExecutionResult.
   *
   * IronClaw returns structured metadata when responding to SkyTwin-formatted
   * messages. We look for status/outputs/error in metadata first, then fall
   * back to inferring from the response content.
   */
  parseExecutionResult(planId: string, response: IronClawResponse, startedAt: Date): ExecutionResult {
    const metadata = response.metadata ?? {};
    const metadataError = this.readString(metadata, ['error']);
    const metadataOutputs = this.asRecord(metadata['outputs']);
    const status = this.parseExecutionStatus(response);

    const result: ExecutionResult = {
      planId,
      status,
      startedAt,
      completedAt: status === 'completed' || status === 'failed' ? new Date() : undefined,
    };

    if (status === 'failed') {
      result.error = metadataError ?? response.content;
    }

    const hasOutputs = Object.keys(metadataOutputs).length > 0;
    result.output = {
      ...(hasOutputs ? metadataOutputs : undefined),
      ironclawResponse: response.content,
      ironclawThreadId: response.thread_id,
    };

    return result;
  }

  parseChatExecutionResult(planId: string, response: ChatCompletionResponse, startedAt: Date): ExecutionResult {
    const content = response.content.toLowerCase();
    const status: ExecutionStatus = content.includes('error') || content.includes('failed') || content.includes('unable')
      ? 'failed'
      : 'completed';

    return {
      planId,
      status,
      startedAt,
      completedAt: new Date(),
      error: status === 'failed' ? response.content : undefined,
      output: {
        ironclawResponse: response.content,
        ironclawModel: response.model,
        ironclawUsage: response.usage,
        ...response.metadata,
      },
    };
  }

  /**
   * Parse an IronClaw response into a RollbackResult.
   */
  parseRollbackResult(response: IronClawResponse): RollbackResult {
    const metadata = response.metadata ?? {};
    const metadataStatus = this.readString(metadata, ['status']);

    if (metadataStatus === 'completed' || metadataStatus === 'success') {
      return { success: true, message: response.content ?? 'Rollback completed.' };
    }

    if (metadataStatus === 'failed' || metadataStatus === 'error') {
      return {
        success: false,
        message: this.readString(metadata, ['error']) ?? response.content ?? 'Rollback failed.',
      };
    }

    const content = (response.content ?? '').toLowerCase();
    if (content.includes('error') || content.includes('failed') || content.includes('unable')) {
      return { success: false, message: response.content };
    }

    return { success: true, message: response.content ?? 'Rollback completed.' };
  }

  parseExecutionStatus(response: IronClawResponse): ExecutionStatus {
    const metadata = response.metadata ?? {};
    const metadataStatus = this.readString(metadata, ['status']);

    if (metadataStatus === 'completed' || metadataStatus === 'success') {
      return 'completed';
    }
    if (metadataStatus === 'failed' || metadataStatus === 'error') {
      return 'failed';
    }
    if (metadataStatus === 'pending') {
      return 'pending';
    }
    if (metadataStatus === 'running') {
      return 'running';
    }

    const content = (response.content ?? '').toLowerCase();
    if (content.includes('pending')) return 'pending';
    if (content.includes('running') || content.includes('in progress')) return 'running';
    if (content.includes('error') || content.includes('failed') || content.includes('unable')) {
      return 'failed';
    }
    return 'completed';
  }

  /**
   * Whether any circuit breaker is currently open.
   */
  get isCircuitOpen(): boolean {
    return Array.from(this.circuitBreakers.values()).some((state) => state.open);
  }

  isCircuitOpenFor(endpoint: CircuitEndpoint): boolean {
    return this.getCircuitBreaker(endpoint).open;
  }

  // -- Webhook helpers -------------------------------------------------------

  private async sendWebhookRequest(message: IronClawMessage): Promise<Response> {
    const body = JSON.stringify(message);
    const signature = this.sign(body);

    return this.fetchWithRetries('webhook', `${this.config.apiUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-256': `sha256=${signature}`,
        'X-IronClaw-Channel': message.channel || this.config.channelId,
      },
      body,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    }, 'IronClaw webhook');
  }

  private readPlanId(message: IronClawMessage): string {
    const planId = message.metadata['plan_id'];
    return typeof planId === 'string' ? planId : message.thread_id ?? 'unknown-plan';
  }

  // -- Request helpers -------------------------------------------------------

  private async fetchWithRetries(
    endpoint: CircuitEndpoint,
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<Response> {
    await this.ensureEndpointReady(endpoint);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(attempt * 1000);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (error) {
        lastError = this.normalizeFetchError(error, label);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const error = new Error(`${label} returned HTTP ${response.status}: ${errorBody}`);

        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.recordFailure(endpoint);
          throw error;
        }

        lastError = error;
        continue;
      }

      this.resetCircuitBreaker(endpoint);
      return response;
    }

    this.recordFailure(endpoint);
    throw lastError ?? new Error(`${label} request failed after all retries`);
  }

  private normalizeFetchError(error: unknown, label: string): Error {
    if (error instanceof Error && error.name === 'AbortError') {
      return new Error(`${label} timed out after ${this.config.timeoutMs}ms`);
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }

  private bearerJsonHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.gatewayToken ? { Authorization: `Bearer ${this.config.gatewayToken}` } : {}),
    };
  }

  // -- SSE parsing -----------------------------------------------------------

  private async *parseSseRecords(
    body: ReadableStream<Uint8Array> | null,
    contextId: string,
  ): AsyncIterable<Record<string, unknown> | string> {
    if (!body) {
      throw new Error(`IronClaw stream for ${contextId} did not include a response body`);
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Per-chunk read timeout: if no data arrives within 2x the request timeout, abort.
    const chunkTimeoutMs = this.config.timeoutMs * 2;

    try {
      while (true) {
        const readPromise = reader.read();
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timerId = setTimeout(
            () => reject(new Error(`IronClaw SSE stream for ${contextId} stalled — no data received in ${chunkTimeoutMs}ms`)),
            chunkTimeoutMs,
          );
          // Allow Node to exit even if this timer is pending
          if (typeof timerId === 'object' && 'unref' in timerId) timerId.unref();
        });
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (timerId !== undefined) clearTimeout(timerId);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          const parsed = this.parseSseMessage(message);
          if (parsed !== null) yield parsed;
        }
      }

      if (buffer.trim()) {
        const parsed = this.parseSseMessage(buffer);
        if (parsed !== null) yield parsed;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseMessage(message: string): Record<string, unknown> | string | null {
    const dataLines: string[] = [];
    for (const rawLine of message.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) return null;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return data;

    return this.safeParseObject(data);
  }

  private normalizeExecutionEvent(planId: string, record: Record<string, unknown> | string): ExecutionEvent {
    if (typeof record === 'string') {
      return {
        planId,
        eventType: 'plan_completed',
        timestamp: new Date(),
        payload: { data: record },
      };
    }

    const rawEventType = this.readString(record, ['eventType', 'event_type', 'type']);
    const eventType = this.normalizeExecutionEventType(rawEventType);
    const timestamp = this.parseOptionalDate(this.readString(record, ['timestamp', 'created_at', 'createdAt'])) ?? new Date();
    const payload = this.asRecord(record['payload']);

    return {
      planId: this.readString(record, ['planId', 'plan_id']) ?? planId,
      stepId: this.readString(record, ['stepId', 'step_id']),
      eventType,
      timestamp,
      payload: Object.keys(payload).length > 0 ? payload : record,
    };
  }

  private normalizeExecutionEventType(raw: string | undefined): ExecutionEvent['eventType'] {
    switch (raw) {
      case 'plan_started':
      case 'step_started':
      case 'step_completed':
      case 'step_failed':
      case 'plan_completed':
      case 'plan_failed':
        return raw;
      case 'started':
        return 'plan_started';
      case 'completed':
        return 'plan_completed';
      case 'failed':
      case 'error':
        return 'plan_failed';
      default:
        return 'step_completed';
    }
  }

  // -- Response parsing helpers --------------------------------------------

  private parseChatCompletionResponse(
    payload: Record<string, unknown>,
    fallbackModel: string | undefined,
  ): ChatCompletionResponse {
    const choices = this.asRecordArray(payload['choices']);
    const first = choices[0];
    const message = this.asRecord(first?.['message']);
    const usage = this.asRecord(payload['usage']);
    const content = typeof message['content'] === 'string'
      ? message['content']
      : typeof payload['content'] === 'string'
        ? payload['content']
        : '';

    return {
      content,
      model: typeof payload['model'] === 'string' ? payload['model'] : fallbackModel ?? 'unknown',
      usage: {
        promptTokens: this.readNumber(usage, ['prompt_tokens', 'promptTokens']) ?? 0,
        completionTokens: this.readNumber(usage, ['completion_tokens', 'completionTokens']) ?? 0,
      },
      metadata: this.asRecord(payload['metadata']),
    };
  }

  private safeParseObject(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as unknown;
      return this.asRecord(parsed);
    } catch {
      return { content: value };
    }
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private asRecordArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
      ? value.filter((item) => typeof item === 'object' && item !== null).map((item) => item as Record<string, unknown>)
      : [];
  }

  private readString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string') return value;
    }
    return undefined;
  }

  private readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number') return value;
    }
    return undefined;
  }

  private readStringArray(record: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string');
      }
    }
    return [];
  }

  private parseOptionalDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  // -- HMAC-SHA256 signing ---------------------------------------------------

  private sign(body: string): string {
    return createHmac('sha256', this.config.webhookSecret)
      .update(body)
      .digest('hex');
  }

  // -- Circuit breaker -------------------------------------------------------

  private async ensureEndpointReady(endpoint: CircuitEndpoint): Promise<void> {
    const breaker = this.getCircuitBreaker(endpoint);
    if (!breaker.open) return;

    const elapsed = Date.now() - (breaker.openedAt ?? 0);
    if (elapsed >= breaker.cooldownMs) {
      const recovered = await this.probeHealthForRecovery(endpoint);
      if (recovered) return;
    }

    throw new Error(
      `IronClaw circuit breaker is open for ${endpoint} — too many recent failures. ` +
      'Automated actions are temporarily paused.',
    );
  }

  private async probeHealthForRecovery(endpoint: CircuitEndpoint): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this.resetCircuitBreaker(endpoint);
        this.resetCircuitBreaker('health');
        return true;
      }
    } catch {
      // Fall through to record failures below.
    }

    this.reopenCircuitBreaker(endpoint);
    this.recordFailure('health');
    return false;
  }

  private getCircuitBreaker(endpoint: CircuitEndpoint): CircuitBreakerState {
    let breaker = this.circuitBreakers.get(endpoint);
    if (!breaker) {
      breaker = {
        failures: [],
        open: false,
        openedAt: null,
        tripCount: 0,
        cooldownMs: this.config.circuitBreakerWindowMs / 2,
      };
      this.circuitBreakers.set(endpoint, breaker);
    }
    return breaker;
  }

  private recordFailure(endpoint: CircuitEndpoint): void {
    const breaker = this.getCircuitBreaker(endpoint);
    const now = Date.now();

    if (breaker.open) {
      return;
    }

    breaker.failures = breaker.failures.filter(
      (f) => now - f.timestamp < this.config.circuitBreakerWindowMs,
    );
    breaker.failures.push({ timestamp: now });

    if (breaker.failures.length >= this.config.circuitBreakerThreshold) {
      this.reopenCircuitBreaker(endpoint);
    }
  }

  private reopenCircuitBreaker(endpoint: CircuitEndpoint): void {
    const breaker = this.getCircuitBreaker(endpoint);
    const baseCooldownMs = this.config.circuitBreakerWindowMs / 2;
    breaker.open = true;
    breaker.openedAt = Date.now();
    breaker.tripCount += 1;
    breaker.cooldownMs = Math.min(
      baseCooldownMs * 2 ** Math.max(0, breaker.tripCount - 1),
      MAX_CIRCUIT_COOLDOWN_MS,
    );
  }

  private resetCircuitBreaker(endpoint: CircuitEndpoint): void {
    const breaker = this.getCircuitBreaker(endpoint);
    breaker.failures = [];
    breaker.open = false;
    breaker.openedAt = null;
    breaker.tripCount = 0;
    breaker.cooldownMs = this.config.circuitBreakerWindowMs / 2;
  }


  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
