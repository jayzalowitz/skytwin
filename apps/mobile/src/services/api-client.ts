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

  // -- Internal helpers --

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
  ): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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
