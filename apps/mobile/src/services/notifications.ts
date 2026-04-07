import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Notification channel identifiers.
 * Android requires explicit channel creation; iOS uses these as category IDs.
 */
export const CHANNELS = {
  URGENT_APPROVALS: 'urgent-approvals',
  APPROVALS: 'approvals',
  UPDATES: 'updates',
} as const;

/**
 * Request notification permissions and configure channels.
 *
 * Returns true if permissions were granted, false otherwise.
 * Safe to call multiple times; the OS will only prompt once.
 */
export async function registerForPushNotifications(): Promise<boolean> {
  // Configure how notifications appear when the app is in the foreground
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowInForeground: true,
    }),
  });

  // Create Android notification channels
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNELS.URGENT_APPROVALS, {
      name: 'Urgent Approvals',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#ff4444',
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
      description: 'High-priority approval requests that need immediate attention.',
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.APPROVALS, {
      name: 'Approvals',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
      showBadge: true,
      description: 'Standard approval requests from SkyTwin.',
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.UPDATES, {
      name: 'Updates',
      importance: Notifications.AndroidImportance.LOW,
      sound: undefined,
      enableVibrate: false,
      showBadge: false,
      description: 'Non-urgent status updates and decision summaries.',
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  if (existingStatus === 'granted') {
    return true;
  }

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Show a local notification for an approval request.
 *
 * Uses the "Urgent Approvals" channel for high-urgency items, and
 * the standard "Approvals" channel otherwise.
 */
export async function scheduleApprovalNotification(
  title: string,
  body: string,
  urgent: boolean = false,
): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      priority: urgent
        ? Notifications.AndroidNotificationPriority.MAX
        : Notifications.AndroidNotificationPriority.HIGH,
      ...(Platform.OS === 'android'
        ? { channelId: urgent ? CHANNELS.URGENT_APPROVALS : CHANNELS.APPROVALS }
        : {}),
    },
    trigger: null, // Show immediately
  });
}

/**
 * Show a silent update notification.
 */
export async function scheduleUpdateNotification(
  title: string,
  body: string,
): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: undefined,
      priority: Notifications.AndroidNotificationPriority.LOW,
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.UPDATES } : {}),
    },
    trigger: null,
  });
}

/**
 * Clear the app badge count.
 */
export async function clearBadge(): Promise<void> {
  await Notifications.setBadgeCountAsync(0);
}
