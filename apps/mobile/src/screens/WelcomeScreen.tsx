import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { markWelcomeSeen } from '../services/welcome-store';

interface WelcomeScreenProps {
  onDone: () => void;
}

interface TourStep {
  emoji: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    emoji: '✓',
    title: 'You approve. Your twin learns.',
    body:
      'When SkyTwin sees a new email or calendar invite, it suggests an action. ' +
      'Tap Approve or Reject and your twin gets smarter about what you actually want.',
  },
  {
    emoji: '⏰',
    title: 'Heads-up notifications.',
    body:
      'You\'ll get a push when something needs your call. Tap it to jump straight ' +
      'to the approval. No badge polling, no missed signals.',
  },
  {
    emoji: '⚙︎',
    title: 'You stay in charge.',
    body:
      'Settings → Trust tier controls what your twin can do without asking. ' +
      'Start at Observer (asks for everything) and earn higher autonomy as you ' +
      'approve consistently.',
  },
];

export function WelcomeScreen({ onDone }: WelcomeScreenProps): React.JSX.Element {
  const [step, setStep] = useState(0);

  const handleNext = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      return;
    }
    void (async () => {
      try {
        await markWelcomeSeen();
      } finally {
        onDone();
      }
    })();
  }, [step, onDone]);

  const handleSkip = useCallback(() => {
    void (async () => {
      try {
        await markWelcomeSeen();
      } finally {
        onDone();
      }
    })();
  }, [onDone]);

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  return (
    <View style={styles.root}>
      <View style={styles.skipRow}>
        <TouchableOpacity onPress={handleSkip} accessibilityRole="button">
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.cardWrap}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <Text style={styles.emoji}>{current.emoji}</Text>
          <Text style={styles.title}>{current.title}</Text>
          <Text style={styles.body}>{current.body}</Text>
        </View>
      </ScrollView>

      <View style={styles.dotsRow}>
        {STEPS.map((_, i) => (
          <View
            key={i}
            style={[styles.dot, i === step ? styles.dotActive : null]}
          />
        ))}
      </View>

      <TouchableOpacity
        style={styles.nextButton}
        onPress={handleNext}
        accessibilityRole="button"
      >
        <Text style={styles.nextText}>{isLast ? "Let's go" : 'Next'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 32,
  },
  skipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 24,
  },
  skipText: {
    color: '#a0a0b8',
    fontSize: 14,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  cardWrap: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: '#16162a',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
  },
  emoji: {
    fontSize: 48,
    marginBottom: 16,
    color: '#4a90d9',
    fontWeight: '700',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e0e0f0',
    textAlign: 'center',
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    color: '#a0a0b8',
    textAlign: 'center',
    lineHeight: 22,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginVertical: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3a3a54',
    marginHorizontal: 4,
  },
  dotActive: {
    backgroundColor: '#4a90d9',
    width: 20,
  },
  nextButton: {
    backgroundColor: '#4a90d9',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  nextText: {
    color: '#1a1a2e',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
