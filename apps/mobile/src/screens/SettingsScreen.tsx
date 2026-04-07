import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  Platform,
} from 'react-native';
import { getSession, clearSession } from '../services/session-store';
import { CHANNELS } from '../services/notifications';

interface SettingsScreenProps {
  onDisconnect: () => void;
}

interface ConnectionInfo {
  baseUrl: string;
  userId: string;
}

/**
 * Settings screen with connection info, notification preferences,
 * and disconnect option.
 */
export function SettingsScreen({ onDisconnect }: SettingsScreenProps): React.JSX.Element {
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Notification preference state (local only; not persisted to API)
  const [urgentApprovals, setUrgentApprovals] = useState(true);
  const [standardApprovals, setStandardApprovals] = useState(true);
  const [updates, setUpdates] = useState(false);

  useEffect(() => {
    const loadConnectionInfo = async (): Promise<void> => {
      const session = await getSession();
      if (session) {
        setConnectionInfo({
          baseUrl: session.baseUrl,
          userId: session.userId,
        });
      }
    };
    loadConnectionInfo();
  }, []);

  const handleDisconnect = useCallback(() => {
    Alert.alert(
      'Disconnect from SkyTwin?',
      'This will remove your session. You can reconnect by scanning the QR code again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setDisconnecting(true);
            try {
              await clearSession();
              onDisconnect();
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Failed to disconnect';
              Alert.alert('Error', message);
              setDisconnecting(false);
            }
          },
        },
      ],
    );
  }, [onDisconnect]);

  const parseHost = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return url;
    }
  };

  const parsePort = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.port || '80';
    } catch {
      return 'unknown';
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Connection info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connected Device</Text>
        <View style={styles.card}>
          {connectionInfo ? (
            <>
              <View style={styles.row}>
                <Text style={styles.label}>Host</Text>
                <Text style={styles.value}>{parseHost(connectionInfo.baseUrl)}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.label}>Port</Text>
                <Text style={styles.value}>{parsePort(connectionInfo.baseUrl)}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.label}>User ID</Text>
                <Text style={[styles.value, styles.monospace]} numberOfLines={1}>
                  {connectionInfo.userId}
                </Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.label}>Session Expiry</Text>
                <Text style={styles.value}>7 days from pairing</Text>
              </View>
            </>
          ) : (
            <Text style={styles.emptyText}>Not connected</Text>
          )}
        </View>
      </View>

      {/* Notification preferences */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.label}>Urgent Approvals</Text>
              <Text style={styles.sublabel}>
                Heads-up notifications for high-priority actions
              </Text>
            </View>
            <Switch
              value={urgentApprovals}
              onValueChange={setUrgentApprovals}
              trackColor={{ false: '#3a3a54', true: '#4a90d9' }}
              thumbColor={Platform.OS === 'android' ? '#ffffff' : undefined}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.label}>Standard Approvals</Text>
              <Text style={styles.sublabel}>
                Notifications for regular approval requests
              </Text>
            </View>
            <Switch
              value={standardApprovals}
              onValueChange={setStandardApprovals}
              trackColor={{ false: '#3a3a54', true: '#4a90d9' }}
              thumbColor={Platform.OS === 'android' ? '#ffffff' : undefined}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.label}>Updates</Text>
              <Text style={styles.sublabel}>
                Silent updates for decision summaries
              </Text>
            </View>
            <Switch
              value={updates}
              onValueChange={setUpdates}
              trackColor={{ false: '#3a3a54', true: '#4a90d9' }}
              thumbColor={Platform.OS === 'android' ? '#ffffff' : undefined}
            />
          </View>
        </View>
        {Platform.OS === 'android' ? (
          <Text style={styles.footnote}>
            Channel: {urgentApprovals ? CHANNELS.URGENT_APPROVALS : 'disabled'}
          </Text>
        ) : null}
      </View>

      {/* Disconnect */}
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.disconnectButton}
          onPress={handleDisconnect}
          disabled={disconnecting}
        >
          <Text style={styles.disconnectButtonText}>
            {disconnecting ? 'Disconnecting...' : 'Disconnect from SkyTwin'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* App info */}
      <View style={styles.section}>
        <Text style={styles.appVersion}>SkyTwin Mobile v0.4.0</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 16,
    paddingBottom: 48,
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
  card: {
    backgroundColor: '#2a2a40',
    borderRadius: 12,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  divider: {
    height: 1,
    backgroundColor: '#3a3a54',
    marginVertical: 4,
  },
  label: {
    color: '#a0a0b8',
    fontSize: 14,
  },
  sublabel: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  value: {
    color: '#e0e0f0',
    fontSize: 14,
    maxWidth: '60%',
    textAlign: 'right',
  },
  monospace: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
  },
  emptyText: {
    color: '#a0a0b8',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 8,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  switchLabel: {
    flex: 1,
    marginRight: 12,
  },
  footnote: {
    color: '#888',
    fontSize: 11,
    marginTop: 8,
    marginLeft: 4,
  },
  disconnectButton: {
    backgroundColor: '#3a1a1a',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e74c3c40',
  },
  disconnectButtonText: {
    color: '#e74c3c',
    fontSize: 16,
    fontWeight: '600',
  },
  appVersion: {
    color: '#555',
    fontSize: 12,
    textAlign: 'center',
  },
});
