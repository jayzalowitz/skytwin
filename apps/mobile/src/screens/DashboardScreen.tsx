import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SkyTwinApiClient, type ServiceHealth, type Decision } from '../services/api-client';
import { getSession } from '../services/session-store';

interface DashboardState {
  loading: boolean;
  health: ServiceHealth | null;
  recentDecisions: Decision[];
  twinTrustTier: string | null;
  twinVersion: number | null;
  error: string | null;
  baseUrl: string | null;
}

const TRUST_TIER_ORDER = ['observer', 'scribe', 'assistant', 'steward', 'autonomous'];
const TRUST_TIER_LABELS: Record<string, string> = {
  observer: 'Observer',
  scribe: 'Scribe',
  assistant: 'Assistant',
  steward: 'Steward',
  autonomous: 'Autonomous',
};

/**
 * Dashboard overview screen showing connection status, recent decisions,
 * trust tier progress, and API health.
 */
export function DashboardScreen(): React.JSX.Element {
  const [state, setState] = useState<DashboardState>({
    loading: true,
    health: null,
    recentDecisions: [],
    twinTrustTier: null,
    twinVersion: null,
    error: null,
    baseUrl: null,
  });
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    const session = await getSession();
    if (!session) {
      setState((prev) => ({ ...prev, loading: false, error: 'No session found' }));
      return;
    }

    const client = new SkyTwinApiClient(session.baseUrl, session.token);

    // Fetch all data in parallel
    const [healthResult, decisionsResult, twinResult] = await Promise.all([
      client.getServiceStatus(),
      client.getDecisionHistory(session.userId, { limit: 5 }),
      client.getTwinProfile(session.userId),
    ]);

    setState({
      loading: false,
      health: healthResult.success ? healthResult.data : null,
      recentDecisions: decisionsResult.success ? decisionsResult.data.decisions : [],
      twinTrustTier: twinResult.success ? twinResult.data.trustTier : null,
      twinVersion: twinResult.success ? twinResult.data.version : null,
      error:
        !healthResult.success
          ? healthResult.error
          : !decisionsResult.success
            ? decisionsResult.error
            : null,
      baseUrl: session.baseUrl,
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const renderTrustTierProgress = (): React.JSX.Element | null => {
    if (!state.twinTrustTier) return null;

    const currentIndex = TRUST_TIER_ORDER.indexOf(state.twinTrustTier.toLowerCase());
    const progress = currentIndex >= 0 ? (currentIndex + 1) / TRUST_TIER_ORDER.length : 0;

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trust Tier</Text>
        <View style={styles.tierCard}>
          <Text style={styles.tierLabel}>
            {TRUST_TIER_LABELS[state.twinTrustTier.toLowerCase()] ?? state.twinTrustTier}
          </Text>
          <View style={styles.tierBar}>
            <View style={[styles.tierBarFill, { width: `${progress * 100}%` }]} />
          </View>
          <View style={styles.tierSteps}>
            {TRUST_TIER_ORDER.map((tier, index) => (
              <Text
                key={tier}
                style={[
                  styles.tierStep,
                  index <= currentIndex ? styles.tierStepActive : null,
                ]}
              >
                {TRUST_TIER_LABELS[tier] ?? tier}
              </Text>
            ))}
          </View>
          {state.twinVersion !== null && (
            <Text style={styles.twinVersion}>Twin model v{state.twinVersion}</Text>
          )}
        </View>
      </View>
    );
  };

  const renderRecentDecisions = (): React.JSX.Element => {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Recent Decisions</Text>
        {state.recentDecisions.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No decisions yet</Text>
          </View>
        ) : (
          state.recentDecisions.map((decision) => (
            <View key={decision.id} style={styles.decisionCard}>
              <View style={styles.decisionHeader}>
                <Text style={styles.decisionType}>
                  {formatSituationType(decision.situationType)}
                </Text>
                <Text style={styles.decisionDomain}>{decision.domain}</Text>
              </View>
              <Text style={styles.decisionOutcome}>{decision.outcome}</Text>
              <Text style={styles.decisionTime}>{formatTime(decision.createdAt)}</Text>
            </View>
          ))
        )}
      </View>
    );
  };

  const renderHealthStatus = (): React.JSX.Element => {
    const isHealthy = state.health?.status === 'ok';

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Service Health</Text>
        <View style={styles.healthCard}>
          <View style={styles.healthRow}>
            <Text style={styles.healthLabel}>Status</Text>
            <View style={styles.healthValue}>
              <View
                style={[
                  styles.healthDot,
                  { backgroundColor: isHealthy ? '#2ecc71' : state.health ? '#f39c12' : '#e74c3c' },
                ]}
              />
              <Text style={styles.healthValueText}>
                {state.health ? state.health.status : 'Unreachable'}
              </Text>
            </View>
          </View>
          {state.baseUrl ? (
            <View style={styles.healthRow}>
              <Text style={styles.healthLabel}>Endpoint</Text>
              <Text style={styles.healthValueText}>{state.baseUrl}</Text>
            </View>
          ) : null}
          {state.health?.uptime !== undefined ? (
            <View style={styles.healthRow}>
              <Text style={styles.healthLabel}>Uptime</Text>
              <Text style={styles.healthValueText}>{formatUptime(state.health.uptime)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  if (state.loading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>Loading dashboard...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor="#4a90d9"
          colors={['#4a90d9']}
        />
      }
    >
      {state.error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{state.error}</Text>
          <TouchableOpacity onPress={handleRefresh}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {renderHealthStatus()}
      {renderTrustTierProgress()}
      {renderRecentDecisions()}
    </ScrollView>
  );
}

// -- Helpers --

function formatSituationType(type: string): string {
  return type
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#a0a0b8',
    fontSize: 16,
  },
  errorBanner: {
    backgroundColor: '#3a1a1a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorText: {
    color: '#e74c3c',
    fontSize: 13,
    flex: 1,
    marginRight: 12,
  },
  retryText: {
    color: '#4a90d9',
    fontSize: 13,
    fontWeight: '600',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#a0a0b8',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  healthCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
  },
  healthRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  healthLabel: {
    color: '#a0a0b8',
    fontSize: 14,
  },
  healthValue: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  healthDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  healthValueText: {
    color: '#e0e0f0',
    fontSize: 14,
  },
  tierCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
  },
  tierLabel: {
    color: '#4a90d9',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  tierBar: {
    height: 6,
    backgroundColor: '#3a3a54',
    borderRadius: 3,
    marginBottom: 12,
    overflow: 'hidden',
  },
  tierBarFill: {
    height: '100%',
    backgroundColor: '#4a90d9',
    borderRadius: 3,
  },
  tierSteps: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tierStep: {
    fontSize: 10,
    color: '#555',
  },
  tierStepActive: {
    color: '#4a90d9',
    fontWeight: '600',
  },
  twinVersion: {
    color: '#888',
    fontSize: 11,
    marginTop: 10,
    textAlign: 'right',
  },
  decisionCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  decisionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  decisionType: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '600',
  },
  decisionDomain: {
    color: '#a0a0b8',
    fontSize: 12,
  },
  decisionOutcome: {
    color: '#c0c0d0',
    fontSize: 13,
    lineHeight: 19,
  },
  decisionTime: {
    color: '#888',
    fontSize: 11,
    marginTop: 6,
  },
  emptyCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 10,
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    color: '#a0a0b8',
    fontSize: 14,
  },
});
