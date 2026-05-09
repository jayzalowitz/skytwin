/**
 * Onboarding routes — issue #181.
 *
 * All endpoints require sessionAuth + requireOwnership (wired in index.ts).
 *
 *   GET  /state                — first-run flags for the current user
 *   POST /dialogue             — one conversational exchange (LLM or deterministic)
 *   POST /deterministic-pick   — map 3 answers to a recipe slug (no-LLM path)
 *   POST /complete             — mark the wizard done and record the user's choice
 */

import { Router } from 'express';
import { onboardingRepository, mcpServerRepository, query } from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import { createLogger } from '@skytwin/core';
import { getLlmClientFromConfig } from '../lib/llm-client-factory.js';

const log = createLogger('api:onboarding');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single turn in the onboarding conversation. */
interface DialogueTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Body for POST /dialogue */
interface DialogueBody {
  history?: DialogueTurn[];
  context?: { current_capabilities?: string[] };
}

/** Body for POST /deterministic-pick */
interface DeterministicPickBody {
  answers?: {
    work?: string;
    notes_app?: string;
    primary_tool?: string;
  };
}

/** Body for POST /complete */
interface CompleteBody {
  choice?: 'email' | 'computer' | 'about-me';
  recipeSlug?: string;
}

/**
 * The normalised output shape from both the LLM and the deterministic paths.
 * Callers should be able to use them interchangeably.
 *
 * kind === 'question': send the question (and optional options) to the user.
 * kind === 'final':    show a recipe preview and let the user install.
 */
type DialogueResponse =
  | { kind: 'question'; question: string; options?: string[] }
  | { kind: 'final'; recipeSlug: string; recommendedRegistryIds: string[]; rationale: string };

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic 3-question form (no-LLM fallback)
// ─────────────────────────────────────────────────────────────────────────────

const DETERMINISTIC_QUESTIONS = [
  {
    key: 'work',
    question: 'What do you do for work?',
    options: ['software_engineer', 'designer', 'journalist', 'parent', 'student', 'other'],
  },
  {
    key: 'notes_app',
    question: 'Which notes/docs app do you use most?',
    options: ['notion', 'obsidian', 'apple_notes', 'paper', 'none'],
  },
  {
    key: 'primary_tool',
    question: 'What tool do you spend the most time in?',
    options: ['github', 'linear', 'slack', 'notion', 'gmail', 'calendar', 'none'],
  },
];

/**
 * Returns which recipe slug to recommend given the three deterministic answers.
 * Fall-through default is 'productivity-pack'.
 */
function deterministicRecipeSlug(answers: { work?: string; notes_app?: string; primary_tool?: string }): string {
  const { work, notes_app, primary_tool } = answers;

  if (work === 'software_engineer') {
    if (notes_app === 'notion' || primary_tool === 'github' || primary_tool === 'linear') {
      return 'developer-pack';
    }
    return 'developer-pack';
  }

  if (work === 'designer' || work === 'journalist' || work === 'parent' || work === 'student') {
    return 'productivity-pack';
  }

  return 'productivity-pack';
}

/** Registry IDs associated with each recipe slug — mirrors CAPABILITY_RECIPES in capabilities.ts. */
const RECIPE_REGISTRY_IDS: Record<string, string[]> = {
  'developer-pack': [
    '@modelcontextprotocol/server-github',
    'linear-mcp',
    '@notionhq/notion-mcp-server',
    '@modelcontextprotocol/server-slack',
    '@modelcontextprotocol/server-filesystem',
    '@modelcontextprotocol/server-git',
    '@modelcontextprotocol/server-sqlite',
  ],
  'productivity-pack': [
    'gmail-mcp',
    'google-calendar-mcp',
    '@notionhq/notion-mcp-server',
    '@modelcontextprotocol/server-slack',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper to extract userId from request (mirrors pattern in capabilities.ts)
// ─────────────────────────────────────────────────────────────────────────────

function getUserId(req: { user?: { id?: string }; query: Record<string, unknown> }): string | undefined {
  return req.user?.id ?? (req.query['userId'] as string | undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Router factory
// ─────────────────────────────────────────────────────────────────────────────

export function createOnboardingRouter(): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /state
  // Returns the user's onboarding flags so the frontend can decide which flow
  // to show. hasMemory and hasInstalledServers are derived from real DB state.
  // hasLlmProvider reflects whether a provider API key is configured.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/state', async (req, res, next) => {
    try {
      const userId = getUserId(req as unknown as { user?: { id?: string }; query: Record<string, unknown> });
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Check whether the user has any episodic/knowledge memory (MemPalace)
      const memResult = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM episodic_memories WHERE user_id = $1 LIMIT 1`,
        [userId],
      ).catch(() => ({ rows: [{ count: '0' }] }));
      const hasMemory = parseInt(memResult.rows[0]?.count ?? '0', 10) > 0;

      // Check whether the user has any installed MCP servers
      const servers = await mcpServerRepository.listForUser(userId).catch(() => []);
      const hasInstalledServers = servers.some(
        (s) => s.status === 'active' || s.status === 'installed' || s.status === 'authorized',
      );

      // Check LLM provider availability
      const hasLlmProvider = getLlmClientFromConfig() !== null;

      const isFirstRun = !hasMemory && !hasInstalledServers;

      res.json({ isFirstRun, hasMemory, hasInstalledServers, hasLlmProvider });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /dialogue
  // One exchange in the conversational onboarding flow.
  //
  // With LLM: runs the onboarding-dialogue prompt from policy-prompts.
  // Without LLM (or when prompt falls back): returns the next unanswered
  // deterministic question or, if all three have been answered via the
  // history, returns the final recommendation.
  //
  // Both paths MUST return the same shape: DialogueResponse.
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/dialogue', async (req, res, next) => {
    try {
      const userId = getUserId(req as unknown as { user?: { id?: string }; query: Record<string, unknown> });
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as DialogueBody | undefined;
      const history: DialogueTurn[] = Array.isArray(body?.history) ? body.history : [];
      // body?.context is no longer threaded into the prompt — the
      // onboarding-dialogue template doesn't read it. Kept on the request
      // shape for future extension but intentionally unused.

      const llmClient = getLlmClientFromConfig();

      if (llmClient) {
        try {
          // Build a human-readable transcript for the prompt template
          const previousTurns = history
            .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
            .join('\n');

          // Template inputs: {{previous_turns}}, {{goal}}, {{language}},
          // {{risk_profile}}. Drop the redundant `history` alias and the
          // `current_capabilities` key the template doesn't use.
          const result = await runPrompt<{ type: string; text?: string; recipeSlug?: string; recommendedRegistryIds?: string[]; summary?: string }>({
            promptName: 'onboarding-dialogue',
            inputs: {
              previous_turns: previousTurns,
              goal: history.length < 3 ? 'gather_context' : 'finalize',
              language: 'en',
              risk_profile: '',
            },
            user: { userId },
            llmClient,
          });

          if (!result.fellBackToDeterministic && result.output) {
            const out = result.output;
            if (out.type === 'recommendation' && out.recipeSlug) {
              const response: DialogueResponse = {
                kind: 'final',
                recipeSlug: out.recipeSlug,
                recommendedRegistryIds: out.recommendedRegistryIds ?? RECIPE_REGISTRY_IDS[out.recipeSlug] ?? [],
                rationale: out.summary ?? '',
              };
              res.json(response);
              return;
            }
            if (out.type === 'question' && out.text) {
              const response: DialogueResponse = {
                kind: 'question',
                question: out.text,
              };
              res.json(response);
              return;
            }
          }
        } catch (err) {
          log.warn('onboarding-dialogue prompt failed, falling back to deterministic', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Deterministic fallback ───────────────────────────────────────────
      // Count how many of the 3 questions have already been answered in the
      // history. User answers are the messages with role='user' after an
      // assistant message that matches one of our questions.
      const answeredKeys = new Set<string>();
      for (let i = 0; i < history.length; i++) {
        const turn = history[i];
        if (turn && turn.role === 'assistant') {
          const matchedQ = DETERMINISTIC_QUESTIONS.find((q) => turn.content.includes(q.question));
          if (matchedQ) {
            const nextUserTurn = history[i + 1];
            if (nextUserTurn && nextUserTurn.role === 'user' && nextUserTurn.content.trim()) {
              answeredKeys.add(matchedQ.key);
            }
          }
        }
      }

      const nextQ = DETERMINISTIC_QUESTIONS.find((q) => !answeredKeys.has(q.key));

      if (nextQ) {
        const response: DialogueResponse = {
          kind: 'question',
          question: nextQ.question,
          options: nextQ.options,
        };
        res.json(response);
        return;
      }

      // All three answered — extract answers from history and finalize
      const answers: Record<string, string> = {};
      for (let i = 0; i < history.length; i++) {
        const turn = history[i];
        if (turn && turn.role === 'assistant') {
          const matchedQ = DETERMINISTIC_QUESTIONS.find((q) => turn.content.includes(q.question));
          if (matchedQ) {
            const nextUserTurn = history[i + 1];
            if (nextUserTurn && nextUserTurn.role === 'user') {
              answers[matchedQ.key] = nextUserTurn.content.trim();
            }
          }
        }
      }

      const slug = deterministicRecipeSlug(answers);
      const response: DialogueResponse = {
        kind: 'final',
        recipeSlug: slug,
        recommendedRegistryIds: RECIPE_REGISTRY_IDS[slug] ?? [],
        rationale: `Based on your answers, ${slug.replace('-', ' ')} is a good starting point.`,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /deterministic-pick
  // Body: { answers: { work?, notes_app?, primary_tool? } }
  // Returns: { recipeSlug, recommendedRegistryIds }
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/deterministic-pick', async (req, res, next) => {
    try {
      const userId = getUserId(req as unknown as { user?: { id?: string }; query: Record<string, unknown> });
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as DeterministicPickBody | undefined;
      const answers = body?.answers ?? {};

      const recipeSlug = deterministicRecipeSlug(answers);
      const recommendedRegistryIds = RECIPE_REGISTRY_IDS[recipeSlug] ?? [];

      res.json({ recipeSlug, recommendedRegistryIds });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /complete
  // Body: { choice: 'email'|'computer'|'about-me', recipeSlug?: string }
  // Marks the wizard done and records the user's first-run choice.
  // For 'computer' choice, stubs the idle-miner enable flow (TODO).
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/complete', async (req, res, next) => {
    try {
      const userId = getUserId(req as unknown as { user?: { id?: string }; query: Record<string, unknown> });
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as CompleteBody | undefined;
      const choice = body?.choice;
      const recipeSlug = body?.recipeSlug;

      if (!choice || !['email', 'computer', 'about-me'].includes(choice)) {
        res.status(400).json({ error: 'choice must be one of: email, computer, about-me' });
        return;
      }

      if (choice === 'computer') {
        // TODO (#181 follow-up): call the idle-miner enable endpoint once it exists.
        // For now, log the intent and proceed.
        log.info('Onboarding: user chose computer/idle-miner path — enable stub', { userId });
      }

      const state = await onboardingRepository.markComplete(userId, choice, recipeSlug);

      log.info('Onboarding complete', { userId, choice, recipeSlug });
      res.json({ ok: true, state });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
