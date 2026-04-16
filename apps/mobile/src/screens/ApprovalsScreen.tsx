import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
  Animated,
  PanResponder,
  TextInput,
  Modal,
} from 'react-native';
import { SkyTwinApiClient, type ApprovalRequest } from '../services/api-client';
import { connectSSE, type SSEEvent } from '../services/sse-client';
import { scheduleApprovalNotification } from '../services/notifications';
import { getSession } from '../services/session-store';

// -- Risk badge colors --
const RISK_COLORS: Record<string, string> = {
  low: '#2ecc71',
  medium: '#f39c12',
  high: '#e74c3c',
  critical: '#8e44ad',
};

/**
 * Main approvals list screen.
 *
 * Shows pending approval requests with pull-to-refresh and real-time
 * updates via SSE. Supports swipe-to-approve and swipe-to-reject.
 */
export function ApprovalsScreen(): React.JSX.Element {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [executionProgress, setExecutionProgress] = useState<string | null>(null);

  const clientRef = useRef<SkyTwinApiClient | null>(null);
  const userIdRef = useRef<string>('');
  const sseRef = useRef<{ disconnect: () => void } | null>(null);

  const fetchApprovals = useCallback(async () => {
    const client = clientRef.current;
    const userId = userIdRef.current;
    if (!client || !userId) return;

    const result = await client.getApprovals(userId);
    if (result.success) {
      setApprovals(result.data.approvals);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchApprovals();
    setRefreshing(false);
  }, [fetchApprovals]);

  const handleApprove = useCallback(
    async (requestId: string) => {
      const client = clientRef.current;
      const userId = userIdRef.current;
      if (!client || !userId) return;

      const result = await client.approveAction(requestId, userId);
      if (result.success) {
        setApprovals((prev) => prev.filter((a) => a.id !== requestId));
      } else {
        Alert.alert('Approval Failed', result.error);
      }
    },
    [],
  );

  const handleRejectPrompt = useCallback((requestId: string) => {
    setRejectTargetId(requestId);
    setRejectReason('');
    setRejectModalVisible(true);
  }, []);

  const handleRejectConfirm = useCallback(async () => {
    const client = clientRef.current;
    const userId = userIdRef.current;
    if (!client || !userId || !rejectTargetId) return;

    const reason = rejectReason.trim() || 'Rejected from mobile';
    const result = await client.rejectAction(rejectTargetId, userId, reason);
    if (result.success) {
      setApprovals((prev) => prev.filter((a) => a.id !== rejectTargetId));
    } else {
      Alert.alert('Rejection Failed', result.error);
    }

    setRejectModalVisible(false);
    setRejectTargetId(null);
    setRejectReason('');
  }, [rejectReason, rejectTargetId]);

  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      if (event.type === 'new-approval' || event.type === 'approval:new') {
        // Refresh the list and show a notification
        fetchApprovals();
        const data = event.data as Record<string, unknown>;
        const reason = (data['reason'] as string) ?? 'New approval request';
        const urgency = (data['urgency'] as string) ?? 'normal';
        scheduleApprovalNotification(
          'SkyTwin Approval Needed',
          reason,
          urgency === 'urgent' || urgency === 'critical',
        );
      } else if (event.type === 'approval-expired' || event.type === 'approval:resolved') {
        fetchApprovals();
      } else if (event.type === 'decision:step') {
        const data = event.data as Record<string, unknown>;
        const eventType = data['eventType'] as string | undefined;
        const description = (data['description'] as string | undefined) ?? (data['actionType'] as string | undefined) ?? 'Action';
        if (eventType === 'step_started') {
          setExecutionProgress(`${description} in progress`);
        } else if (eventType === 'plan_completed') {
          setExecutionProgress(`${description} completed`);
          setTimeout(() => setExecutionProgress(null), 3000);
        } else if (eventType === 'step_failed' || eventType === 'plan_failed') {
          setExecutionProgress(`${description} needs attention`);
          setTimeout(() => setExecutionProgress(null), 5000);
        }
      }
    },
    [fetchApprovals],
  );

  // Initialize client and SSE connection
  useEffect(() => {
    let mounted = true;

    const init = async (): Promise<void> => {
      const session = await getSession();
      if (!session || !mounted) return;

      clientRef.current = new SkyTwinApiClient(session.baseUrl, session.token);
      userIdRef.current = session.userId;

      await fetchApprovals();
      if (!mounted) return;
      setLoading(false);

      sseRef.current = connectSSE(
        session.baseUrl,
        session.token,
        session.userId,
        handleSSEEvent,
        (isConnected) => {
          if (mounted) setConnected(isConnected);
        },
      );
    };

    init();

    return () => {
      mounted = false;
      sseRef.current?.disconnect();
    };
  }, [fetchApprovals, handleSSEEvent]);

  const timeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  const renderApprovalCard = ({ item }: { item: ApprovalRequest }): React.JSX.Element => {
    const isExpanded = expandedId === item.id;
    const action = item.candidateAction;
    const riskLevel = ((action['riskLevel'] ?? action['risk'] ?? 'low') as string).toLowerCase();
    const domain = (action['domain'] as string) ?? 'general';
    const description = (action['description'] as string) ?? item.reason;
    const reasoning = (action['reasoning'] as string) ?? '';

    return (
      <SwipeableCard
        onSwipeRight={() => handleApprove(item.id)}
        onSwipeLeft={() => handleRejectPrompt(item.id)}
      >
        <TouchableOpacity
          style={styles.card}
          onPress={() => setExpandedId(isExpanded ? null : item.id)}
          activeOpacity={0.8}
        >
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderLeft}>
              <View style={[styles.riskBadge, { backgroundColor: RISK_COLORS[riskLevel] ?? '#888' }]}>
                <Text style={styles.riskBadgeText}>{riskLevel.toUpperCase()}</Text>
              </View>
              <Text style={styles.domainLabel}>{domain}</Text>
            </View>
            <Text style={styles.timeAgo}>{timeAgo(item.requestedAt)}</Text>
          </View>

          <Text style={styles.cardDescription} numberOfLines={isExpanded ? undefined : 2}>
            {description}
          </Text>

          {item.urgency && (
            <Text style={styles.urgencyLabel}>Urgency: {item.urgency}</Text>
          )}

          {isExpanded && reasoning ? (
            <View style={styles.expandedSection}>
              <Text style={styles.expandedLabel}>Reasoning</Text>
              <Text style={styles.expandedText}>{reasoning}</Text>
            </View>
          ) : null}

          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.rejectButton}
              onPress={() => handleRejectPrompt(item.id)}
            >
              <Text style={styles.rejectButtonText}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.approveButton}
              onPress={() => handleApprove(item.id)}
            >
              <Text style={styles.approveButtonText}>Approve</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </SwipeableCard>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadingText}>Loading approvals...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.statusBar}>
        <View style={[styles.statusDot, connected ? styles.statusConnected : styles.statusDisconnected]} />
        <Text style={styles.statusText}>
          {connected ? 'Connected' : 'Disconnected'}
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={handleRefresh}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {executionProgress ? (
        <View style={styles.progressBanner}>
          <Text style={styles.progressText}>{executionProgress}</Text>
        </View>
      ) : null}

      <FlatList
        data={approvals}
        keyExtractor={(item) => item.id}
        renderItem={renderApprovalCard}
        contentContainerStyle={approvals.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#4a90d9"
            colors={['#4a90d9']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No pending approvals</Text>
            <Text style={styles.emptySubtitle}>
              When SkyTwin needs your approval for an action, it will appear here.
            </Text>
          </View>
        }
      />

      <Modal
        visible={rejectModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setRejectModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Reject Action</Text>
            <Text style={styles.modalSubtitle}>
              Provide a reason so SkyTwin can learn from this decision.
            </Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Reason for rejection (optional)"
              placeholderTextColor="#888"
              value={rejectReason}
              onChangeText={setRejectReason}
              multiline
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setRejectModalVisible(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={handleRejectConfirm}>
                <Text style={styles.modalConfirmText}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// -- Swipeable card wrapper --

interface SwipeableCardProps {
  children: React.ReactNode;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
}

function SwipeableCard({ children, onSwipeRight, onSwipeLeft }: SwipeableCardProps): React.JSX.Element {
  const translateX = useRef(new Animated.Value(0)).current;
  const SWIPE_THRESHOLD = 100;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dx) > 15 && Math.abs(gestureState.dy) < 30,
      onPanResponderMove: (_, gestureState) => {
        translateX.setValue(gestureState.dx);
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > SWIPE_THRESHOLD) {
          Animated.timing(translateX, {
            toValue: 400,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            onSwipeRight();
            translateX.setValue(0);
          });
        } else if (gestureState.dx < -SWIPE_THRESHOLD) {
          Animated.timing(translateX, {
            toValue: -400,
            duration: 200,
            useNativeDriver: true,
          }).start(() => {
            onSwipeLeft();
            translateX.setValue(0);
          });
        } else {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  return (
    <View style={styles.swipeContainer}>
      <View style={styles.swipeBackground}>
        <View style={styles.swipeLeft}>
          <Text style={styles.swipeActionText}>APPROVE</Text>
        </View>
        <View style={styles.swipeRight}>
          <Text style={styles.swipeActionText}>REJECT</Text>
        </View>
      </View>
      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
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
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#16162a',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusConnected: {
    backgroundColor: '#2ecc71',
  },
  statusDisconnected: {
    backgroundColor: '#e74c3c',
  },
  statusText: {
    color: '#a0a0b8',
    fontSize: 13,
  },
  errorBanner: {
    backgroundColor: '#3a1a1a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: {
    color: '#e74c3c',
    fontSize: 13,
    flex: 1,
    marginRight: 12,
  },
  progressBanner: {
    backgroundColor: '#22384a',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  progressText: {
    color: '#d7ecff',
    fontSize: 13,
  },
  retryText: {
    color: '#4a90d9',
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  emptyContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 120,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#a0a0b8',
    textAlign: 'center',
    lineHeight: 20,
  },
  swipeContainer: {
    marginBottom: 12,
  },
  swipeBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    overflow: 'hidden',
  },
  swipeLeft: {
    backgroundColor: '#2ecc71',
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingLeft: 20,
    borderRadius: 12,
  },
  swipeRight: {
    backgroundColor: '#e74c3c',
    flex: 1,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 20,
    borderRadius: 12,
  },
  swipeActionText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  card: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  riskBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginRight: 8,
  },
  riskBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  domainLabel: {
    color: '#a0a0b8',
    fontSize: 13,
  },
  timeAgo: {
    color: '#888',
    fontSize: 12,
  },
  cardDescription: {
    color: '#e0e0f0',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  urgencyLabel: {
    color: '#f39c12',
    fontSize: 12,
    marginBottom: 8,
  },
  expandedSection: {
    backgroundColor: '#222238',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  expandedLabel: {
    color: '#a0a0b8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  expandedText: {
    color: '#c0c0d0',
    fontSize: 13,
    lineHeight: 20,
  },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  rejectButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e74c3c',
  },
  rejectButtonText: {
    color: '#e74c3c',
    fontSize: 14,
    fontWeight: '600',
  },
  approveButton: {
    backgroundColor: '#2ecc71',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  approveButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#2a2a40',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#a0a0b8',
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#1a1a2e',
    color: '#ffffff',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#3a3a54',
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalCancel: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  modalCancelText: {
    color: '#a0a0b8',
    fontSize: 15,
  },
  modalConfirm: {
    backgroundColor: '#e74c3c',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modalConfirmText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
