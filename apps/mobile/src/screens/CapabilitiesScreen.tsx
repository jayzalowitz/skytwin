import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import {
  SkyTwinApiClient,
  type InstalledCapability,
  type CapabilitySuggestion,
} from '../services/api-client';
import { getSession } from '../services/session-store';

// -- Props --

interface CapabilitiesScreenProps {
  onSelectCapability: (serverId: string) => void;
}

// -- Local state --

interface CapabilitiesState {
  loading: boolean;
  installed: InstalledCapability[];
  suggestions: CapabilitySuggestion[];
  dormant: InstalledCapability[];
  error: string | null;
}

// -- Status badge colors --

const STATUS_COLORS: Record<string, string> = {
  running: '#2ecc71',
  stopped: '#f39c12',
  error: '#e74c3c',
  dormant: '#888',
};

/**
 * Capabilities list screen.
 *
 * Shows installed MCP capabilities with status badges and last-active timestamps.
 * Pending suggestions appear at the top with Install / Snooze / Dismiss actions.
 * Pull-to-refresh. Tap a row to open CapabilityDetailScreen.
 */
export function CapabilitiesScreen({
  onSelectCapability,
}: CapabilitiesScreenProps): React.JSX.Element {
  const [state, setState] = useState<CapabilitiesState>({
    loading: true,
    installed: [],
    suggestions: [],
    dormant: [],
    error: null,
  });
  const [refreshing, setRefreshing] = useState(false);
  // Track which suggestion actions are in-flight to prevent double-taps
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    const session = await getSession();
    if (!session) {
      setState((prev) => ({ ...prev, loading: false, error: 'No session found' }));
      return;
    }

    const client = new SkyTwinApiClient(session.baseUrl, session.token);
    const result = await client.fetchCapabilities(session.userId);

    if (result.success) {
      setState({
        loading: false,
        installed: result.data.installed,
        suggestions: result.data.suggestions,
        dormant: result.data.dormant,
        error: null,
      });
    } else {
      setState((prev) => ({ ...prev, loading: false, error: result.error }));
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Suggestion actions are read-only stubs on mobile — full management lives on web.
  // We dismiss/snooze locally (remove from list) and log the id only.
  const handleDismissSuggestion = useCallback((id: string) => {
    if (pendingIds.has(id)) return;
    setPendingIds((prev) => new Set(prev).add(id));
    console.log('[capabilities] dismiss suggestion:', id);
    setState((prev) => ({
      ...prev,
      suggestions: prev.suggestions.filter((s) => s.id !== id),
    }));
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [pendingIds]);

  const handleSnoozeSuggestion = useCallback((id: string) => {
    if (pendingIds.has(id)) return;
    console.log('[capabilities] snooze suggestion:', id);
    setState((prev) => ({
      ...prev,
      suggestions: prev.suggestions.filter((s) => s.id !== id),
    }));
  }, [pendingIds]);

  if (state.loading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>Loading capabilities...</Text>
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

      {state.suggestions.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Suggested for you</Text>
          {state.suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onDismiss={handleDismissSuggestion}
              onSnooze={handleSnoozeSuggestion}
            />
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Installed{state.installed.length > 0 ? ` (${state.installed.length})` : ''}
        </Text>
        {state.installed.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No capabilities installed yet</Text>
          </View>
        ) : (
          state.installed.map((cap) => (
            <CapabilityRow
              key={cap.id}
              capability={cap}
              onPress={onSelectCapability}
            />
          ))
        )}
      </View>

      {state.dormant.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Dormant ({state.dormant.length})</Text>
          {state.dormant.map((cap) => (
            <CapabilityRow
              key={cap.id}
              capability={cap}
              onPress={onSelectCapability}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// -- Sub-components --

function CapabilityRow({
  capability,
  onPress,
}: {
  capability: InstalledCapability;
  onPress: (id: string) => void;
}): React.JSX.Element {
  const statusColor = STATUS_COLORS[capability.status] ?? '#888';
  const lastActive = capability.lastActiveAt
    ? formatRelativeTime(capability.lastActiveAt)
    : 'Never active';

  return (
    <TouchableOpacity
      style={styles.capabilityCard}
      onPress={() => onPress(capability.id)}
      accessibilityRole="button"
      accessibilityLabel={`${capability.name}, status ${capability.status}`}
    >
      <View style={styles.capabilityHeader}>
        <View style={styles.capabilityMeta}>
          <Text style={styles.capabilityName}>{capability.name}</Text>
          <Text style={styles.capabilityLastActive}>{lastActive}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusBadgeText}>{capability.status}</Text>
        </View>
      </View>
      {capability.zeroTrustMode && (
        <View style={styles.zeroTrustBadge}>
          <Text style={styles.zeroTrustText}>Zero-trust</Text>
        </View>
      )}
      <Text style={styles.skillCount}>
        {capability.skills.length} skill{capability.skills.length !== 1 ? 's' : ''}
      </Text>
    </TouchableOpacity>
  );
}

function SuggestionCard({
  suggestion,
  onDismiss,
  onSnooze,
}: {
  suggestion: CapabilitySuggestion;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
}): React.JSX.Element {
  return (
    <View style={styles.suggestionCard}>
      <Text style={styles.suggestionName}>{suggestion.name}</Text>
      <Text style={styles.suggestionReason}>{suggestion.reason}</Text>
      <View style={styles.suggestionActions}>
        <TouchableOpacity
          style={[styles.suggestionButton, styles.suggestionButtonSnooze]}
          onPress={() => onSnooze(suggestion.id)}
          accessibilityRole="button"
          accessibilityLabel={`Snooze ${suggestion.name} suggestion`}
        >
          <Text style={styles.suggestionButtonText}>Snooze</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.suggestionButton, styles.suggestionButtonDismiss]}
          onPress={() => onDismiss(suggestion.id)}
          accessibilityRole="button"
          accessibilityLabel={`Dismiss ${suggestion.name} suggestion`}
        >
          <Text style={styles.suggestionButtonText}>Dismiss</Text>
        </TouchableOpacity>
        <View style={[styles.suggestionButton, styles.suggestionButtonInstall]}>
          <Text style={styles.suggestionButtonInstallText}>Install via web</Text>
        </View>
      </View>
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
  capabilityCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  capabilityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  capabilityMeta: {
    flex: 1,
    marginRight: 10,
  },
  capabilityName: {
    color: '#e0e0f0',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  capabilityLastActive: {
    color: '#888',
    fontSize: 12,
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
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginBottom: 4,
  },
  zeroTrustText: {
    color: '#9a6ac0',
    fontSize: 11,
    fontWeight: '500',
  },
  skillCount: {
    color: '#a0a0b8',
    fontSize: 12,
  },
  suggestionCard: {
    backgroundColor: '#1e2a3a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a4a6a',
    padding: 14,
    marginBottom: 8,
  },
  suggestionName: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  suggestionReason: {
    color: '#a0c0e0',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  suggestionActions: {
    flexDirection: 'row',
    gap: 8,
  },
  suggestionButton: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestionButtonSnooze: {
    backgroundColor: '#2a2a40',
  },
  suggestionButtonDismiss: {
    backgroundColor: '#3a2a2a',
  },
  suggestionButtonInstall: {
    backgroundColor: '#1a3a5a',
    borderWidth: 1,
    borderColor: '#2a5a8a',
  },
  suggestionButtonText: {
    color: '#c0c0d0',
    fontSize: 12,
    fontWeight: '500',
  },
  suggestionButtonInstallText: {
    color: '#4a90d9',
    fontSize: 12,
    fontWeight: '500',
  },
});
