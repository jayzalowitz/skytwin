import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Alert,
  Animated,
  Easing,
  Linking,
} from 'react-native';
import {
  AudioModule,
  useAudioRecorder,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';
import { SkyTwinApiClient } from '../services/api-client';
import { getSession } from '../services/session-store';
import {
  transcribeRecording,
  type VoiceTranscribeOutcome,
} from '../services/voice-service';

/**
 * VoiceScreen — #179 mobile voice flow.
 *
 * Single-screen voice capture surface. Tap-to-record → tap-to-stop →
 * upload base64 audio to the paired desktop's `/api/voice/transcribe`
 * → display the transcript. No "send to twin" hand-off yet — that
 * lands in a follow-up once the assistant-from-mobile route is ready.
 *
 * State machine:
 *
 *   idle      — initial; mic button is the only affordance
 *   denied    — OS permission denied; we render the recovery copy
 *   recording — `useAudioRecorder` is capturing; timer + stop button
 *   processing— recording stopped, base64 + upload in flight
 *   result    — transcript rendered; user can dismiss + start over
 *   error     — recording or upload failed; user can retry
 *
 * Recording lifecycle lives inside this component because
 * `useAudioRecorder` is a hook — pulling it into a plain service module
 * would lose the hook's internal teardown. Pure helpers
 * (`transcribeRecording`, `audioFileToBase64`) live in
 * `services/voice-service.ts` and own everything that's easy to
 * unit-test outside React.
 */
type VoiceState =
  | { kind: 'idle' }
  | { kind: 'denied' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'processing' }
  | { kind: 'result'; transcript: string; durationBytes: number }
  | { kind: 'error'; message: string };

interface VoiceScreenProps {
  /** Hand a finished transcript to the Chat screen ("send to twin"). */
  onSendToTwin?: (text: string) => void;
}

export function VoiceScreen({ onSendToTwin }: VoiceScreenProps = {}): React.JSX.Element {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [state, setState] = useState<VoiceState>({ kind: 'idle' });
  const [elapsedSec, setElapsedSec] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  // Pulse animation while recording — the only motion on this screen.
  // Honors the assumed reduced-motion default (we don't have a hook
  // for that on mobile yet; the static dot reads fine even without
  // animation).
  useEffect(() => {
    if (state.kind !== 'recording') {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.25, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state.kind, pulse]);

  // Recording-elapsed timer. Decoupled from the animation loop so the
  // displayed seconds are exact (animation easing would jitter them).
  useEffect(() => {
    if (state.kind !== 'recording') {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setElapsedSec(0);
      return;
    }
    const start = state.startedAt;
    tickRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [state]);

  const startRecording = useCallback(async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setState({ kind: 'denied' });
        return;
      }
      // setAudioMode wires the iOS playback session to "playAndRecord"
      // so the device's silent-mode switch doesn't mute the recording
      // attempt. Android is unaffected.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setState({ kind: 'recording', startedAt: Date.now() });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not start the recording.',
      });
    }
  }, [audioRecorder]);

  const stopAndTranscribe = useCallback(async () => {
    setState({ kind: 'processing' });
    try {
      await audioRecorder.stop();
      const session = await getSession();
      if (!session) {
        setState({
          kind: 'error',
          message: 'No paired desktop session — pair the app from Settings first.',
        });
        return;
      }
      const client = new SkyTwinApiClient(session.baseUrl, session.token);
      const outcome: VoiceTranscribeOutcome = await transcribeRecording(
        client,
        session.userId,
        audioRecorder.uri,
      );
      if (outcome.ok) {
        setState({ kind: 'result', transcript: outcome.transcript, durationBytes: outcome.durationBytes });
      } else {
        setState({ kind: 'error', message: outcome.message });
      }
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Recording failed unexpectedly.',
      });
    }
  }, [audioRecorder]);

  const reset = useCallback(() => setState({ kind: 'idle' }), []);

  const openSystemSettings = useCallback(async () => {
    // Prefer one-tap deep link to the system settings page. Falls back
    // to an explanatory alert when Linking.openSettings is unavailable
    // (some Expo Go runtimes don't expose it).
    try {
      await Linking.openSettings();
    } catch {
      Alert.alert(
        'Microphone access needed',
        'Open Settings → SkyTwin and enable Microphone to use voice. Recorded audio is stored briefly on this device, then sent to your paired SkyTwin desktop for transcription — it never goes to a cloud.',
      );
    }
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Voice</Text>
      <Text style={styles.subtitle}>
        Talk to your twin. Audio is sent to your paired desktop for on-device transcription — never to a cloud.
      </Text>

      <View style={styles.captureArea}>
        {state.kind === 'idle' && (
          <Pressable onPress={startRecording} style={styles.micButton} accessibilityRole="button" accessibilityLabel="Start recording">
            <Text style={styles.micGlyph}>{'\u{1F3A4}'}</Text>
            <Text style={styles.micLabel}>Tap to speak</Text>
          </Pressable>
        )}

        {state.kind === 'denied' && (
          <View style={styles.deniedBox}>
            <Text style={styles.deniedTitle}>Microphone access denied</Text>
            <Text style={styles.deniedBody}>
              Voice needs microphone access. Open your device settings and enable it for SkyTwin.
            </Text>
            <Pressable onPress={openSystemSettings} style={styles.secondaryButton} accessibilityRole="button">
              <Text style={styles.secondaryButtonText}>How to fix</Text>
            </Pressable>
            <Pressable onPress={reset} style={styles.tertiaryButton} accessibilityRole="button">
              <Text style={styles.tertiaryButtonText}>Back</Text>
            </Pressable>
          </View>
        )}

        {state.kind === 'recording' && (
          <View style={styles.recordingBox}>
            <Animated.View style={[styles.pulseDot, { transform: [{ scale: pulse }] }]} />
            <Text style={styles.recordingTimer}>{formatElapsed(elapsedSec)}</Text>
            <Pressable onPress={stopAndTranscribe} style={styles.stopButton} accessibilityRole="button" accessibilityLabel="Stop recording">
              <Text style={styles.stopButtonText}>Stop</Text>
            </Pressable>
          </View>
        )}

        {state.kind === 'processing' && (
          <View style={styles.processingBox}>
            <ActivityIndicator size="large" color="#4a90d9" />
            <Text style={styles.processingText}>Transcribing on your desktop…</Text>
          </View>
        )}

        {state.kind === 'result' && (
          <View style={styles.resultBox}>
            <Text style={styles.resultLabel}>Transcript</Text>
            <View style={styles.resultCard}>
              <Text style={styles.resultText}>{state.transcript.trim() || '(silence)'}</Text>
            </View>
            <Text style={styles.resultMeta}>Audio size: {formatBytes(state.durationBytes)}</Text>
            {onSendToTwin && state.transcript.trim().length > 0 && (
              <Pressable
                onPress={() => onSendToTwin(state.transcript.trim())}
                style={styles.primaryButton}
                accessibilityRole="button"
                accessibilityLabel="Send transcript to your twin"
              >
                <Text style={styles.primaryButtonText}>Send to twin</Text>
              </Pressable>
            )}
            <Pressable onPress={reset} style={styles.secondaryButton} accessibilityRole="button">
              <Text style={styles.secondaryButtonText}>Record again</Text>
            </Pressable>
          </View>
        )}

        {state.kind === 'error' && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Couldn't transcribe</Text>
            <Text style={styles.errorBody}>{state.message}</Text>
            <Pressable onPress={reset} style={styles.primaryButton} accessibilityRole="button">
              <Text style={styles.primaryButtonText}>Try again</Text>
            </Pressable>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 20,
    paddingTop: 40,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#e0e0f0',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#a0a0b8',
    lineHeight: 20,
    marginBottom: 32,
  },
  captureArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 360,
  },
  micButton: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: '#16162a',
    borderWidth: 2,
    borderColor: '#4a90d9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micGlyph: {
    fontSize: 64,
    color: '#4a90d9',
    marginBottom: 8,
  },
  micLabel: {
    fontSize: 15,
    color: '#e0e0f0',
    fontWeight: '500',
  },
  recordingBox: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  pulseDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#e74c3c',
    marginBottom: 24,
  },
  recordingTimer: {
    fontSize: 36,
    fontWeight: '300',
    color: '#e0e0f0',
    marginBottom: 32,
    fontVariant: ['tabular-nums'],
  },
  stopButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    backgroundColor: '#e74c3c',
    borderRadius: 999,
  },
  stopButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  processingBox: {
    alignItems: 'center',
  },
  processingText: {
    marginTop: 16,
    fontSize: 15,
    color: '#a0a0b8',
  },
  resultBox: {
    width: '100%',
    alignItems: 'stretch',
  },
  resultLabel: {
    fontSize: 13,
    color: '#a0a0b8',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  resultCard: {
    padding: 16,
    backgroundColor: '#16162a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#3a3a54',
    marginBottom: 8,
  },
  resultText: {
    fontSize: 17,
    color: '#e0e0f0',
    lineHeight: 24,
  },
  resultMeta: {
    fontSize: 12,
    color: '#a0a0b8',
    marginBottom: 24,
  },
  errorBox: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e74c3c',
    marginBottom: 8,
  },
  errorBody: {
    fontSize: 15,
    color: '#e0e0f0',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  deniedBox: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  deniedTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e0e0f0',
    marginBottom: 8,
  },
  deniedBody: {
    fontSize: 15,
    color: '#a0a0b8',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  primaryButton: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    backgroundColor: '#4a90d9',
    borderRadius: 999,
    alignSelf: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#16162a',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#3a3a54',
    marginBottom: 12,
  },
  secondaryButtonText: {
    color: '#e0e0f0',
    fontSize: 14,
    fontWeight: '500',
  },
  tertiaryButton: {
    paddingVertical: 8,
  },
  tertiaryButtonText: {
    color: '#a0a0b8',
    fontSize: 14,
  },
});
