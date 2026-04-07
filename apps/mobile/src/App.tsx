import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getSession } from './services/session-store';
import { registerForPushNotifications } from './services/notifications';
import { PairingScreen } from './screens/PairingScreen';
import { ApprovalsScreen } from './screens/ApprovalsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { SettingsScreen } from './screens/SettingsScreen';

// -- Navigation types --

type RootStackParamList = {
  Pairing: undefined;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();

// -- Theme --

const SkyTwinTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: '#4a90d9',
    background: '#1a1a2e',
    card: '#16162a',
    text: '#e0e0f0',
    border: '#3a3a54',
    notification: '#e74c3c',
  },
};

// -- Bottom tab bar --

function MainWithTabs({ onDisconnect }: { onDisconnect: () => void }): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'approvals' | 'dashboard' | 'settings'>('approvals');

  return (
    <View style={styles.tabContainer}>
      <View style={styles.tabContent}>
        {activeTab === 'approvals' && <ApprovalsScreen />}
        {activeTab === 'dashboard' && <DashboardScreen />}
        {activeTab === 'settings' && <SettingsScreen onDisconnect={onDisconnect} />}
      </View>
      <View style={styles.tabBar}>
        <TabButton
          label="Approvals"
          active={activeTab === 'approvals'}
          onPress={() => setActiveTab('approvals')}
        />
        <TabButton
          label="Dashboard"
          active={activeTab === 'dashboard'}
          onPress={() => setActiveTab('dashboard')}
        />
        <TabButton
          label="Settings"
          active={activeTab === 'settings'}
          onPress={() => setActiveTab('settings')}
        />
      </View>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.tabButton}>
      <Text
        style={[styles.tabButtonText, active ? styles.tabButtonTextActive : null]}
        onPress={onPress}
      >
        {label}
      </Text>
      {active && <View style={styles.tabIndicator} />}
    </View>
  );
}

// -- Root app --

export default function App(): React.JSX.Element {
  const [initializing, setInitializing] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        // Check for existing session
        const session = await getSession();
        setHasSession(session !== null);

        // Register for notifications (non-blocking)
        registerForPushNotifications().catch((err: unknown) => {
          console.warn('[app] Failed to register notifications:', err);
        });
      } catch (err: unknown) {
        console.warn('[app] Initialization error:', err);
        setHasSession(false);
      } finally {
        setInitializing(false);
      }
    };

    init();
  }, []);

  const handlePaired = useCallback(() => {
    setHasSession(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setHasSession(false);
  }, []);

  if (initializing) {
    return (
      <SafeAreaProvider>
        <View style={styles.splash}>
          <Text style={styles.splashTitle}>SkyTwin</Text>
          <ActivityIndicator size="small" color="#4a90d9" style={styles.splashLoader} />
        </View>
        <StatusBar style="light" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={SkyTwinTheme}>
        {hasSession ? (
          <MainWithTabs onDisconnect={handleDisconnect} />
        ) : (
          <RootStack.Navigator screenOptions={{ headerShown: false }}>
            <RootStack.Screen name="Pairing">
              {() => <PairingScreen onPaired={handlePaired} />}
            </RootStack.Screen>
          </RootStack.Navigator>
        )}
      </NavigationContainer>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: '#4a90d9',
    letterSpacing: 2,
  },
  splashLoader: {
    marginTop: 20,
  },
  tabContainer: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  tabContent: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#16162a',
    borderTopWidth: 1,
    borderTopColor: '#3a3a54',
    paddingBottom: 20, // Safe area for home indicator
    paddingTop: 8,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
  },
  tabButtonText: {
    fontSize: 13,
    color: '#a0a0b8',
    fontWeight: '500',
  },
  tabButtonTextActive: {
    color: '#4a90d9',
    fontWeight: '600',
  },
  tabIndicator: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#4a90d9',
    marginTop: 4,
  },
});
