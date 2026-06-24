/**
 * HTTP client for the SkyTwin desktop API.
 *
 * All methods include the Bearer token in the Authorization header.
 * Network errors are caught and returned as typed error results rather than
 * thrown exceptions, following the project convention.
 */

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiError {
  success: false;
  error: string;
  statusCode?: number;
}

type ApiResult<T> = ApiSuccess<T> | ApiError;

// -- Response types matching the API routes --

export interface ApprovalRequest {
  id: string;
  decisionId: string;
  candidateAction: Record<string, unknown>;
  reason: string;
  urgency: string;
  status: string;
  requestedAt: string;
}

export interface Decision {
  id: string;
  situationType: string;
  domain: string;
  urgency: string;
  outcome: string;
  createdAt: string;
}

export interface ServiceHealth {
  status: string;
  service: string;
  timestamp: string;
  uptime: number;
}

export interface TwinProfile {
  id: string;
  userId: string;
  version: number;
  preferences: Record<string, unknown>;
  trustTier: string;
  confidenceScores: Record<string, unknown>;
}

// -- Capabilities types --

export interface CapabilitySkill {
  name: string;
  description: string;
  riskLevel: string;
}

export interface InstalledCapability {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'dormant';
  lastActiveAt: string | null;
  zeroTrustMode: boolean;
  spendCapMonthlyUsd: number | null;
  skills: CapabilitySkill[];
}

export interface CapabilitySuggestion {
  id: string;
  registryId: string;
  name: string;
  reason: string;
  category: string;
}

export interface CapabilitiesPayload {
  installed: InstalledCapability[];
  suggestions: CapabilitySuggestion[];
  dormant: InstalledCapability[];
}

export interface CapabilityDetail {
  id: string;
  name: string;
  status: string;
  lastActiveAt: string | null;
  zeroTrustMode: boolean;
  spendCapMonthlyUsd: number | null;
  spendUsedMonthUsd: number | null;
  skills: CapabilitySkill[];
  provenanceUrl: string | null;
}

// -- Briefing types --

export interface TwinBriefing {
  id: string;
  cadence: 'daily' | 'weekly';
  headline: string;
  keySignals: string[];
  pendingApprovalsCount: number;
  generatedAt: string;
  readAt: string | null;
  proseMarkdown: string;
}

export interface TwinBriefingPayload {
  briefing: TwinBriefing | null;
  unreadCount: number;
}

// -- Voice types --

export interface TranscribeResponse {
  transcript: string;
  durationBytes: number;
}

export interface ApprovalResponse {
  requestId: string;
  action: string;
  reason: string | null;
  approval: {
    id: string;
    status: string;
    respondedAt: string;
  };
  execution: {
    status: string;
    planId?: string;
    error?: string;
  } | null;
  twinProfileVersion: number;
  processedAt: string;
}

// -- Assistant chat --

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface AssistantSendResponse {
  thread: { id: string; isNew: boolean };
  userMessage: AssistantMessage;
  assistantMessage: AssistantMessage;
}

// -- Client --

export class SkyTwinApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, timeoutMs: number = 10_000) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /**
   * List pending approval requests for the authenticated user.
   */
  async getApprovals(userId: string): Promise<ApiResult<{ approvals: ApprovalRequest[] }>> {
    return this.get<{ approvals: ApprovalRequest[] }>(
      `/api/approvals/${encodeURIComponent(userId)}/pending`,
    );
  }

  /**
   * Approve a pending approval request.
   */
  async approveAction(
    requestId: string,
    userId: string,
  ): Promise<ApiResult<ApprovalResponse>> {
    return this.post<ApprovalResponse>(
      `/api/approvals/${encodeURIComponent(requestId)}/respond`,
      { action: 'approve', userId },
    );
  }

  /**
   * Reject a pending approval request with a reason.
   */
  async rejectAction(
    requestId: string,
    userId: string,
    reason: string,
  ): Promise<ApiResult<ApprovalResponse>> {
    return this.post<ApprovalResponse>(
      `/api/approvals/${encodeURIComponent(requestId)}/respond`,
      { action: 'reject', userId, reason },
    );
  }

  /**
   * Fetch decision history for a user.
   */
  async getDecisionHistory(
    userId: string,
    params?: { limit?: number; offset?: number; domain?: string },
  ): Promise<ApiResult<{ decisions: Decision[] }>> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    if (params?.domain) query.set('domain', params.domain);

    const qs = query.toString();
    const path = `/api/decisions/${encodeURIComponent(userId)}${qs ? `?${qs}` : ''}`;
    return this.get<{ decisions: Decision[] }>(path);
  }

  /**
   * Check if the SkyTwin API is reachable and healthy.
   */
  async getServiceStatus(): Promise<ApiResult<ServiceHealth>> {
    return this.get<ServiceHealth>('/api/health');
  }

  /**
   * Fetch the twin profile for a user.
   */
  async getTwinProfile(userId: string): Promise<ApiResult<TwinProfile>> {
    return this.get<TwinProfile>(`/api/twin/${encodeURIComponent(userId)}`);
  }

  /**
   * Fetch installed capabilities plus pending suggestions for a user.
   */
  async fetchCapabilities(userId: string): Promise<ApiResult<CapabilitiesPayload>> {
    return this.get<CapabilitiesPayload>(
      `/api/capabilities/${encodeURIComponent(userId)}`,
    );
  }

  /**
   * Fetch detailed information for a single capability (server + skills + policy).
   */
  async fetchCapabilityDetail(
    userId: string,
    serverId: string,
  ): Promise<ApiResult<CapabilityDetail>> {
    return this.get<CapabilityDetail>(
      `/api/capabilities/${encodeURIComponent(userId)}/${encodeURIComponent(serverId)}`,
    );
  }

  /**
   * Fetch the most recent twin briefing and count of unread briefings.
   */
  async fetchTwinBriefing(userId: string): Promise<ApiResult<TwinBriefingPayload>> {
    return this.get<TwinBriefingPayload>(
      `/api/briefing/${encodeURIComponent(userId)}/latest`,
    );
  }

  /**
   * Upload base64-encoded audio to the desktop's whisper-cli for
   * transcription. #179: mobile voice flow.
   *
   * The API enforces a 25MB *decoded* audio cap (≈33MB base64). The
   * mobile recorder has no explicit cap; the screen surfaces the 413
   * if the user records past the limit. A future improvement is to
   * cap recording duration client-side to avoid the round-trip when
   * the upload is going to be rejected anyway.
   *
   * Increased timeout to 60s because whisper transcription can take
   * several seconds on first run while the model loads into memory.
   */
  async transcribeVoice(
    userId: string,
    audioBase64: string,
    language?: string,
  ): Promise<ApiResult<TranscribeResponse>> {
    const body: Record<string, string> = { userId, audioBase64 };
    if (language !== undefined && language.length > 0) body['language'] = language;
    return this.request<TranscribeResponse>('POST', '/api/voice/transcribe', body, 60_000);
  }

  // -- Resumable chunked voice upload (#386) --

  /** Open an upload session; returns the server-minted sessionId. */
  async voiceUploadSession(
    userId: string,
    totalChunks: number,
    language?: string,
  ): Promise<ApiResult<{ sessionId: string }>> {
    const body: Record<string, unknown> = { userId, totalChunks };
    if (language !== undefined && language.length > 0) body['language'] = language;
    return this.request<{ sessionId: string }>('POST', '/api/voice/upload/session', body, 30_000);
  }

  /** Upload a single chunk; returns the server's ack (received/total/missing). */
  async voiceUploadChunk(
    userId: string,
    sessionId: string,
    index: number,
    chunkBase64: string,
  ): Promise<ApiResult<{ received: number; total: number; missing: number[] }>> {
    return this.request<{ received: number; total: number; missing: number[] }>(
      'POST',
      '/api/voice/upload/chunk',
      { userId, sessionId, index, chunkBase64 },
      30_000,
    );
  }

  /** Finalize: server reassembles + transcribes. */
  async voiceUploadFinalize(
    userId: string,
    sessionId: string,
  ): Promise<ApiResult<TranscribeResponse>> {
    return this.request<TranscribeResponse>(
      'POST',
      '/api/voice/upload/finalize',
      { userId, sessionId },
      60_000,
    );
  }

  /** Cancel an in-flight session (best-effort; server drops the chunks). */
  async voiceUploadCancel(
    userId: string,
    sessionId: string,
  ): Promise<ApiResult<{ cancelled: boolean }>> {
    return this.request<{ cancelled: boolean }>(
      'POST',
      '/api/voice/upload/cancel',
      { userId, sessionId },
      15_000,
    );
  }

  // -- Internal helpers --

  /**
   * Send a chat message to the assistant and get its reply. Uses the JSON
   * (non-streaming) path — the client's `Accept: application/json` header
   * makes the route return `{ thread, userMessage, assistantMessage }` in one
   * shot rather than an SSE stream, which is the right fit for React Native.
   *
   * Omit `threadId` to start a new conversation; pass it to continue one.
   * LLM replies routinely exceed the default 10s budget, so this overrides
   * the timeout to 60s.
   */
  async sendAssistantMessage(
    userId: string,
    content: string,
    threadId?: string,
  ): Promise<ApiResult<AssistantSendResponse>> {
    const body: Record<string, unknown> = { userId, content };
    if (threadId) body['threadId'] = threadId;
    return this.request<AssistantSendResponse>('POST', '/api/assistant/messages', body, 60_000);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private async get<T>(path: string): Promise<ApiResult<T>> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutOverrideMs?: number,
  ): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutOverrideMs ?? this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        const errorMsg =
          typeof data === 'object' && data !== null && 'error' in data
            ? String((data as Record<string, unknown>)['error'])
            : `HTTP ${response.status}`;
        return { success: false, error: errorMsg, statusCode: response.status };
      }

      return { success: true, data: data as T };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: 'Request timed out' };
      }
      if (err instanceof TypeError && String(err.message).includes('Network')) {
        return { success: false, error: 'Network error: SkyTwin not reachable' };
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
