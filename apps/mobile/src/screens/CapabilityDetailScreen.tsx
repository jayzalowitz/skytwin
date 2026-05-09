import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  Linking,
} from 'react-native';
import {
  SkyTwinApiClient,
  type CapabilityDetail,
  type CapabilitySkill,
} from '../services/api-client';
import { getSession } from '../services/session-store';

// -- Props --

interface CapabilityDetailScreenProps {
  serverId: string;
  onBack: () => void;
}

// -- State --

interface DetailState {
  loading: boolean;
  detail: CapabilityDetail | null;
  error: string | null;
  baseUrl: string | null;
}

// -- Status badge colors --

const STATUS_COLORS: Record<string, string> = {
  running: '#2ecc71',
  stopped: '#f39c12',
  error: '#e74c3c',
  dormant: '#888',
};

/**
 * Capability detail screen.
 *
 * Shows skill list, monthly spend meter (if cap configured),
 * zero-trust status badge, and a "View provenance" button that
 * opens the web graph in the system browser.
 *
 * Read-only for v1 — no inline edit forms. Full management is on the web.
 */
export function CapabilityDetailScreen({
  serverId,
  onBack,
}: CapabilityDetailScreenProps): React.JSX.Element {
  const [state, setState] = useState<DetailState>({
    loading: true,
    detail: null,
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
    const result = await client.fetchCapabilityDetail(session.userId, serverId);

    if (result.success) {
      setState({
        loading: false,
        detail: result.data,
        error: null,
        baseUrl: session.baseUrl,
      });
    } else {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: result.error,
        baseUrl: session.baseUrl,
      }));
    }
  }, [serverId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleViewProvenance = useCallback(async () => {
    const baseUrl = state.baseUrl ?? '';
    const url = `${baseUrl}/web/#/capabilities/${encodeURIComponent(serverId)}`;
    console.log('[capability-detail] opening provenance url for server:', serverId);
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) {
      await Linking.openURL(url);
    }
  }, [state.baseUrl, serverId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (state.loading) {
    return (
      <View style={styles.centered}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  if (!state.detail) {
    return (
      <View style={styles.centered}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.errorText}>{state.error ?? 'Capability not found'}</Text>
      </View>
    );
  }

  const { detail } = state;
  const statusColor = STATUS_COLORS[detail.status] ?? '#888';

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
      <View style={styles.navBar}>
        <TouchableOpacity onPress={onBack} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
      </View>

      {state.error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{state.error}</Text>
        </View>
      ) : null}

      {/* Header card */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <Text style={styles.capabilityName}>{detail.name}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
            <Text style={styles.statusBadgeText}>{detail.status}</Text>
          </View>
        </View>

        {detail.zeroTrustMode && (
          <View style={styles.zeroTrustBadge}>
            <Text style={styles.zeroTrustText}>Zero-trust mode enabled</Text>
          </View>
        )}

        {detail.lastActiveAt && (
          <Text style={styles.lastActiveText}>
            Last active: {formatRelativeTime(detail.lastActiveAt)}
          </Text>
        )}
      </View>

      {/* Spend meter */}
      {detail.spendCapMonthlyUsd !== null && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Monthly Spend</Text>
          <View style={styles.spendCard}>
            <View style={styles.spendRow}>
              <Text style={styles.spendLabel}>Used this month</Text>
              <Text style={styles.spendValue}>
                ${(detail.spendUsedMonthUsd ?? 0).toFixed(2)}
              </Text>
            </View>
            <View style={styles.spendRow}>
              <Text style={styles.spendLabel}>Monthly cap</Text>
              <Text style={styles.spendValue}>
                ${detail.spendCapMonthlyUsd.toFixed(2)}
              </Text>
            </View>
            <SpendMeter
              used={detail.spendUsedMonthUsd ?? 0}
              cap={detail.spendCapMonthlyUsd}
            />
          </View>
        </View>
      )}

      {/* Skills list */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Skills ({detail.skills.length})
        </Text>
        {detail.skills.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No skills registered</Text>
          </View>
        ) : (
          detail.skills.map((skill, index) => (
            <SkillRow key={index} skill={skill} />
          ))
        )}
      </View>

      {/* Provenance link */}
      <TouchableOpacity
        style={styles.provenanceButton}
        onPress={handleViewProvenance}
        accessibilityRole="button"
        accessibilityLabel="View provenance in browser"
      >
        <Text style={styles.provenanceButtonText}>View provenance</Text>
        <Text style={styles.provenanceButtonSubtext}>Opens web dashboard</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// -- Sub-components --

function SpendMeter({ used, cap }: { used: number; cap: number }): React.JSX.Element {
  const pct = cap > 0 ? Math.min(used / cap, 1) : 0;
  const barColor = pct > 0.8 ? '#e74c3c' : pct > 0.5 ? '#f39c12' : '#2ecc71';

  return (
    <View style={styles.spendMeter}>
      <View style={styles.spendMeterTrack}>
        <View
          style={[
            styles.spendMeterFill,
            { width: `${pct * 100}%` as `${number}%`, backgroundColor: barColor },
          ]}
        />
      </View>
      <Text style={styles.spendMeterLabel}>{Math.round(pct * 100)}% used</Text>
    </View>
  );
}

const RISK_COLORS: Record<string, string> = {
  low: '#2ecc71',
  medium: '#f39c12',
  high: '#e74c3c',
  critical: '#8e44ad',
};

function SkillRow({ skill }: { skill: CapabilitySkill }): React.JSX.Element {
  const riskColor = RISK_COLORS[skill.riskLevel] ?? '#888';
  return (
    <View style={styles.skillCard}>
      <View style={styles.skillHeader}>
        <Text style={styles.skillName}>{skill.name}</Text>
        <View style={[styles.riskBadge, { backgroundColor: riskColor }]}>
          <Text style={styles.riskBadgeText}>{skill.riskLevel}</Text>
        </View>
      </View>
      {skill.description ? (
        <Text style={styles.skillDescription}>{skill.description}</Text>
      ) : null}
    </View>
  );
}

// -- Helpers --

function formatRelativeTime(isoString: string): string {
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

// -- Styles --

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
  navBar: {
    marginBottom: 16,
  },
  backButton: {
    marginBottom: 16,
  },
  backButtonText: {
    color: '#4a90d9',
    fontSize: 15,
    fontWeight: '500',
  },
  loadingText: {
    color: '#a0a0b8',
    fontSize: 16,
    marginTop: 12,
  },
  errorText: {
    color: '#e74c3c',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 24,
  },
  errorBanner: {
    backgroundColor: '#3a1a1a',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#e74c3c',
    fontSize: 13,
  },
  headerCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  capabilityName: {
    color: '#e0e0f0',
    fontSize: 20,
    fontWeight: '700',
    flex: 1,
    marginRight: 10,
  },
  statusBadge: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  zeroTrustBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#2a1a3a',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#6a3a9a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 8,
  },
  zeroTrustText: {
    color: '#9a6ac0',
    fontSize: 12,
    fontWeight: '500',
  },
  lastActiveText: {
    color: '#888',
    fontSize: 12,
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
  spendCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
  },
  spendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  spendLabel: {
    color: '#a0a0b8',
    fontSize: 14,
  },
  spendValue: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '600',
  },
  spendMeter: {
    marginTop: 12,
  },
  spendMeterTrack: {
    height: 6,
    backgroundColor: '#3a3a54',
    borderRadius: 3,
    overflow: 'hidden',
  },
  spendMeterFill: {
    height: '100%',
    borderRadius: 3,
  },
  spendMeterLabel: {
    color: '#888',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'right',
  },
  skillCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
  },
  skillHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  skillName: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    marginRight: 8,
  },
  riskBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  riskBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  skillDescription: {
    color: '#a0a0b8',
    fontSize: 12,
    lineHeight: 17,
  },
  provenanceButton: {
    backgroundColor: '#2a2a40',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a3a54',
    padding: 16,
    alignItems: 'center',
  },
  provenanceButtonText: {
    color: '#4a90d9',
    fontSize: 15,
    fontWeight: '600',
  },
  provenanceButtonSubtext: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
});
