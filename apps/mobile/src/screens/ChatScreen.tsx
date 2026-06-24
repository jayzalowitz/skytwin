import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import {
  SkyTwinApiClient,
  type AssistantMessage,
} from '../services/api-client';
import { getSession } from '../services/session-store';

/**
 * ChatScreen — talk to your twin from your phone.
 *
 * The assistant capability has always existed server-side (`POST
 * /api/assistant/messages`); mobile just had no surface for it. This wires
 * the JSON (non-streaming) path: send a message, get the reply, keep the
 * thread going. `initialText` lets the Voice screen hand a transcript over
 * here ("send to twin") — it pre-fills the composer so the user can review
 * before sending, rather than firing blind.
 */
interface ChatScreenProps {
  initialText?: string | null;
  onInitialTextConsumed?: () => void;
}

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export function ChatScreen({ initialText, onInitialTextConsumed }: ChatScreenProps): React.JSX.Element {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadIdRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<ScrollView | null>(null);

  // Pre-fill the composer when a transcript is handed over from the Voice
  // screen. Consume it once so re-renders don't keep re-filling.
  useEffect(() => {
    if (initialText && initialText.trim()) {
      setInput(initialText.trim());
      onInitialTextConsumed?.();
    }
  }, [initialText, onInitialTextConsumed]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || sending) return;

    setError(null);
    setInput('');
    const optimisticId = `local-${Date.now()}`;
    setMessages((prev) => [...prev, { id: optimisticId, role: 'user', content }]);
    setSending(true);

    try {
      const session = await getSession();
      if (!session) {
        setError('Your session expired — pair with your SkyTwin again.');
        return;
      }
      const client = new SkyTwinApiClient(session.baseUrl, session.token);
      const result = await client.sendAssistantMessage(session.userId, content, threadIdRef.current);
      if (!result.success) {
        setError(result.error);
        return;
      }
      threadIdRef.current = result.data.thread.id;
      const reply: AssistantMessage = result.data.assistantMessage;
      setMessages((prev) => [
        ...prev,
        { id: reply.id ?? `reply-${Date.now()}`, role: 'assistant', content: reply.content },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Ask your twin anything</Text>
            <Text style={styles.emptyBody}>
              It answers from what it has learned about you — your preferences, recent decisions, and
              the things you've told it.
            </Text>
          </View>
        ) : (
          messages.map((m) => (
            <View
              key={m.id}
              style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}
            >
              <Text style={styles.bubbleText}>{m.content}</Text>
            </View>
          ))
        )}
        {sending && (
          <View style={[styles.bubble, styles.bubbleAssistant, styles.typing]}>
            <ActivityIndicator color="#a0a0b8" size="small" />
          </View>
        )}
      </ScrollView>

      {error && (
        <View style={styles.errorBar} accessibilityLiveRegion="polite">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message your twin…"
          placeholderTextColor="#6c6c84"
          multiline
          editable={!sending}
          accessibilityLabel="Message your twin"
        />
        <Pressable
          onPress={send}
          disabled={sending || input.trim().length === 0}
          style={[styles.sendButton, (sending || input.trim().length === 0) && styles.sendButtonDisabled]}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 8 },
  empty: { paddingVertical: 48, paddingHorizontal: 8 },
  emptyTitle: { color: '#e0e0f0', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: '#a0a0b8', fontSize: 14, lineHeight: 20 },
  bubble: { maxWidth: '85%', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#4a90d9', borderBottomRightRadius: 4 },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: '#2a2a40', borderBottomLeftRadius: 4 },
  bubbleText: { color: '#ffffff', fontSize: 15, lineHeight: 21 },
  typing: { paddingVertical: 12, paddingHorizontal: 16 },
  errorBar: { backgroundColor: 'rgba(231,76,60,0.15)', paddingVertical: 8, paddingHorizontal: 16 },
  errorText: { color: '#e74c3c', fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a2a40',
    backgroundColor: '#16162a',
  },
  input: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: '#2a2a40',
    color: '#e0e0f0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  sendButton: { backgroundColor: '#4a90d9', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
});
