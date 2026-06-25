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
  type BriefingActionOpportunity,
  type TwinBriefing,
} from '../services/api-client';
import { getSession } from '../services/session-store';

// -- State --

interface BriefingState {
  loading: boolean;
  briefing: TwinBriefing | null;
  unreadCount: number;
  error: string | null;
}

/**
 * Twin Briefing screen.
 *
 * Shows the most recent daily briefing: headline, key signals list,
 * and pending-approvals count. Pull-to-refresh. Tapping the approvals
 * count is a prompt to switch to the Approvals tab — actual navigation
 * is handled via the onOpenApprovals callback so this screen stays
 * decoupled from the tab bar.
 */
export function BriefingScreen({
  onOpenApprovals,
}: {
  onOpenApprovals?: () => void;
}): React.JSX.Element {
  const [state, setState] = useState<BriefingState>({
    loading: true,
    briefing: null,
    unreadCount: 0,
    error: null,
  });
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    const session = await getSession();
    if (!session) {
      setState((prev) => ({ ...prev, loading: false, error: 'No session found' }));
      return;
    }

    const client = new SkyTwinApiClient(session.baseUrl, session.token);
    const result = await client.fetchTwinBriefing(session.userId);

    if (result.success) {
      setState({
        loading: false,
        briefing: result.data.briefing,
        unreadCount: result.data.unreadCount,
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

  if (state.loading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>Loading briefing...</Text>
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

      {state.unreadCount > 0 && (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {state.unreadCount} unread briefing{state.unreadCount !== 1 ? 's' : ''}
          </Text>
        </View>
      )}

      {state.briefing ? (
        <BriefingContent
          briefing={state.briefing}
          onOpenApprovals={onOpenApprovals}
        />
      ) : (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No briefing yet</Text>
          <Text style={styles.emptySubtitle}>
            Your twin will generate a daily briefing once it has enough signal data.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

// -- Sub-components --

function BriefingContent({
  briefing,
  onOpenApprovals,
}: {
  briefing: TwinBriefing;
  onOpenApprovals?: () => void;
}): React.JSX.Element {
  const isUnread = briefing.readAt === null;
  const generatedLabel = formatRelativeTime(briefing.generatedAt);

  return (
    <>
      {/* Headline card */}
      <View style={styles.headlineCard}>
        <View style={styles.headlineHeader}>
          <Text style={styles.headlineCadence}>
            {briefing.cadence === 'daily' ? 'Daily' : 'Weekly'} briefing
          </Text>
          {isUnread && (
            <View style={styles.newBadge}>
              <Text style={styles.newBadgeText}>New</Text>
            </View>
          )}
        </View>
        <Text style={styles.headlineText}>{briefing.headline}</Text>
        <Text style={styles.generatedAt}>Generated {generatedLabel}</Text>
      </View>

      {/* Pending approvals count */}
      {briefing.pendingApprovalsCount > 0 && (
        <TouchableOpacity
          style={styles.approvalsPrompt}
          onPress={onOpenApprovals}
          accessibilityRole="button"
          accessibilityLabel={`${briefing.pendingApprovalsCount} pending approvals, tap to review`}
        >
          <View style={styles.approvalsPromptLeft}>
            <View style={styles.approvalsCountBubble}>
              <Text style={styles.approvalsCountText}>
                {briefing.pendingApprovalsCount}
              </Text>
            </View>
            <View>
              <Text style={styles.approvalsPromptTitle}>Pending approvals</Text>
              <Text style={styles.approvalsPromptSubtitle}>Tap to review</Text>
            </View>
          </View>
          <Text style={styles.approvalsChevron}>›</Text>
        </TouchableOpacity>
      )}

      {/* Key signals */}
      {briefing.keySignals.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Key signals</Text>
          {briefing.keySignals.map((signal, index) => (
            <SignalRow key={index} signal={signal} index={index} />
          ))}
        </View>
      )}

      {(briefing.actionOpportunities?.length ?? 0) > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions from memory</Text>
          {briefing.actionOpportunities!.map((action, index) => (
            <ActionOpportunityRow key={`${action.actionType}-${index}`} action={action} />
          ))}
        </View>
      )}
    </>
  );
}

function SignalRow({
  signal,
  index,
}: {
  signal: string;
  index: number;
}): React.JSX.Element {
  return (
    <View style={styles.signalRow}>
      <Text style={styles.signalBullet}>{index + 1}</Text>
      <Text style={styles.signalText}>{signal}</Text>
    </View>
  );
}

function ActionOpportunityRow({
  action,
}: {
  action: BriefingActionOpportunity;
}): React.JSX.Element {
  const runtime = action.runtimeVersion?.stableVersion
    ? `${action.runtimeVersion.displayName ?? action.primaryAdapter} ${action.runtimeVersion.stableVersion}`
    : '';
  const route = [action.primaryAdapter, action.actionType, runtime].filter(Boolean).join(' · ');
  const readiness = action.readiness === 'learn_or_connect' ? 'learn' : 'try';
  return (
    <View style={styles.actionRow}>
      <View style={styles.actionMetaRow}>
        <Text style={styles.actionRoute}>{route || readiness}</Text>
        <Text style={styles.actionReadiness}>{readiness}</Text>
      </View>
      <Text style={styles.actionLabel}>{action.label}</Text>
      {action.reason ? <Text style={styles.actionReason}>{action.reason}</Text> : null}
      {action.suggestedAction ? (
        <Text style={styles.actionSuggested}>{action.suggestedAction}</Text>
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
  unreadBadge: {
    backgroundColor: '#1a3a5a',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  unreadBadgeText: {
    color: '#4a90d9',
    fontSize: 12,
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 32,
    alignItems: 'center',
  },
  emptyTitle: {
    color: '#e0e0f0',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtitle: {
    color: '#a0a0b8',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  headlineCard: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
  },
  headlineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  headlineCadence: {
    color: '#a0a0b8',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  newBadge: {
    backgroundColor: '#1a3a5a',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  newBadgeText: {
    color: '#4a90d9',
    fontSize: 11,
    fontWeight: '600',
  },
  headlineText: {
    color: '#e0e0f0',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 26,
    marginBottom: 10,
  },
  generatedAt: {
    color: '#888',
    fontSize: 12,
  },
  approvalsPrompt: {
    backgroundColor: '#2a2a40',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e74c3c',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  approvalsPromptLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  approvalsCountBubble: {
    backgroundColor: '#e74c3c',
    borderRadius: 14,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  approvalsCountText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  approvalsPromptTitle: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '600',
  },
  approvalsPromptSubtitle: {
    color: '#a0a0b8',
    fontSize: 12,
  },
  approvalsChevron: {
    color: '#a0a0b8',
    fontSize: 24,
    fontWeight: '300',
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
  signalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#2a2a40',
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
  },
  signalBullet: {
    color: '#4a90d9',
    fontSize: 13,
    fontWeight: '700',
    width: 20,
    lineHeight: 19,
  },
  signalText: {
    color: '#c0c0d0',
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
  },
  actionRow: {
    backgroundColor: '#242438',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#353552',
  },
  actionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  actionRoute: {
    color: '#a0a0b8',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  actionReadiness: {
    color: '#4a90d9',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  actionLabel: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  actionReason: {
    color: '#b8b8cc',
    fontSize: 13,
    lineHeight: 18,
  },
  actionSuggested: {
    color: '#d0d0e0',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
  },
});
