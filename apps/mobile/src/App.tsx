import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getSession } from './services/session-store';
import { registerForPushNotifications } from './services/notifications';
import { hasSeenWelcome } from './services/welcome-store';
import { PairingScreen } from './screens/PairingScreen';
import { WelcomeScreen } from './screens/WelcomeScreen';
import { ApprovalsScreen } from './screens/ApprovalsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { CapabilitiesScreen } from './screens/CapabilitiesScreen';
import { CapabilityDetailScreen } from './screens/CapabilityDetailScreen';
import { BriefingScreen } from './screens/BriefingScreen';

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

// Tab type now includes Capabilities and Briefing.
type MainTab = 'approvals' | 'briefing' | 'capabilities' | 'dashboard' | 'settings';

function MainWithTabs({ onDisconnect }: { onDisconnect: () => void }): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<MainTab>('approvals');
  // When a capability row is tapped we push a detail "sub-page" within the
  // Capabilities tab without leaving the tab bar or introducing a nested
  // navigator. This keeps the nav stack simple for v1.
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);

  const handleSelectCapability = useCallback((serverId: string) => {
    setSelectedCapabilityId(serverId);
  }, []);

  const handleBackFromDetail = useCallback(() => {
    setSelectedCapabilityId(null);
  }, []);

  const handleOpenApprovals = useCallback(() => {
    setActiveTab('approvals');
  }, []);

  const renderContent = (): React.JSX.Element => {
    switch (activeTab) {
      case 'approvals':
        return <ApprovalsScreen />;
      case 'briefing':
        return <BriefingScreen onOpenApprovals={handleOpenApprovals} />;
      case 'capabilities':
        if (selectedCapabilityId !== null) {
          return (
            <CapabilityDetailScreen
              serverId={selectedCapabilityId}
              onBack={handleBackFromDetail}
            />
          );
        }
        return <CapabilitiesScreen onSelectCapability={handleSelectCapability} />;
      case 'dashboard':
        return <DashboardScreen />;
      case 'settings':
        return <SettingsScreen onDisconnect={onDisconnect} />;
    }
  };

  // Reset detail view when switching away from Capabilities tab so that
  // returning later shows the list, not a stale detail page.
  const handleTabPress = useCallback(
    (tab: MainTab) => {
      if (tab !== 'capabilities') {
        setSelectedCapabilityId(null);
      }
      setActiveTab(tab);
    },
    [],
  );

  return (
    <View style={styles.tabContainer}>
      <View style={styles.tabContent}>{renderContent()}</View>
      <View style={styles.tabBar}>
        <TabButton
          label="Approvals"
          active={activeTab === 'approvals'}
          onPress={() => handleTabPress('approvals')}
        />
        <TabButton
          label="Briefing"
          active={activeTab === 'briefing'}
          onPress={() => handleTabPress('briefing')}
        />
        <TabButton
          label="Capabilities"
          active={activeTab === 'capabilities'}
          onPress={() => handleTabPress('capabilities')}
        />
        <TabButton
          label="Dashboard"
          active={activeTab === 'dashboard'}
          onPress={() => handleTabPress('dashboard')}
        />
        <TabButton
          label="Settings"
          active={activeTab === 'settings'}
          onPress={() => handleTabPress('settings')}
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
  const [welcomeSeen, setWelcomeSeen] = useState(true);

  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        const session = await getSession();
        setHasSession(session !== null);

        // Welcome state is read here so it's already known by the time the
        // user finishes pairing — no flash of MainWithTabs first.
        const seen = await hasSeenWelcome();
        setWelcomeSeen(seen);

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

  const handleWelcomeDone = useCallback(() => {
    setWelcomeSeen(true);
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

  let content: React.JSX.Element;
  if (!hasSession) {
    content = (
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="Pairing">
          {() => <PairingScreen onPaired={handlePaired} />}
        </RootStack.Screen>
      </RootStack.Navigator>
    );
  } else if (!welcomeSeen) {
    content = <WelcomeScreen onDone={handleWelcomeDone} />;
  } else {
    content = <MainWithTabs onDisconnect={handleDisconnect} />;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={SkyTwinTheme}>
        {content}
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
