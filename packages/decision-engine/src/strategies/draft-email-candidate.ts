/**
 * Draft-email candidate generator (#251 Phase 4).
 *
 * The marquee feature Layer 1 + Layer 2 were building toward. When an
 * inbound email needs a reply, this generator proposes a `draft_email`
 * candidate whose body is composed using the user's authored corpus as
 * voice / style grounding.
 *
 * Architecture in one paragraph: the generator queries the user's
 * `authoringTier: user_sent_*` corpus (via an injected memory-search
 * port) for the top-K most similar emails the user has written. Those
 * examples are passed as few-shot context to the LLM along with the
 * inbound email. The LLM produces a draft body in the user's voice.
 * The result lands as a `CandidateAction` with `actionType: 'draft_email'`
 * which flows through the normal policy / approval pipeline — at v1 it
 * always requires explicit approval (no auto-send regardless of trust
 * tier).
 *
 * Composition with the rest of the engine: this is OPT-IN. The
 * generator is exported as a class callers can instantiate; it's NOT
 * wired into `DecisionMaker.evaluate` by default. The deploy decision
 * (which LLM client to use, when to wire it in) lives outside the
 * decision engine. Once wired, the generator runs alongside the rule-
 * based candidates and the LLM-based candidates, producing one
 * additional `draft_email` candidate when the inbound email looks
 * reply-worthy.
 *
 * Eval and tuning are separate work — this PR ships the building block.
 */

import { ConfidenceLevel } from '@skytwin/shared-types';
import type {
  DecisionObject,
  DecisionContext,
  CandidateAction,
  TwinProfile,
} from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import type { CandidateGenerator } from './candidate-strategy.js';
import { randomUUID } from 'node:crypto';

/**
 * Minimal port the draft generator needs from the memory layer. We
 * deliberately don't depend on `@skytwin/memory-port` here — the
 * decision-engine layer should be able to consume any source of
 * authored-style examples.
 */
export interface AuthoredExamplesPort {
  /**
   * Return up to `k` examples from the user's `user_sent_*` corpus
   * most similar to `query`. The generator concatenates these as
   * few-shot context.
   */
  searchAuthoredExamples(
    query: string,
    k: number,
  ): Promise<Array<{ content: string; subject?: string }>>;
}

/**
 * Cap on prompt context size. Anthropic + OpenAI both happily eat ~10k
 * tokens of context, but each authored example is ~250 tokens average,
 * so 6 examples × 250 ≈ 1500 tokens — well within budget without
 * making the prompt unreadable to a future maintainer.
 */
export const DEFAULT_AUTHORED_EXAMPLE_COUNT = 6;

/**
 * Maximum body length (chars) of any one authored example included in
 * the prompt. Longer-than-this gets head-truncated. Stops a 5KB email
 * the user once sent from dominating context.
 */
export const MAX_EXAMPLE_CHARS = 800;

export class DraftEmailCandidateGenerator implements CandidateGenerator {
  constructor(
    private readonly llmClient: LlmClient,
    private readonly examples: AuthoredExamplesPort,
    private readonly exampleCount: number = DEFAULT_AUTHORED_EXAMPLE_COUNT,
  ) {}

  async generate(
    decision: DecisionObject,
    _profile: TwinProfile,
    _context: DecisionContext,
  ): Promise<CandidateAction[]> {
    // Only fires for email signals that need a response. Calendar,
    // notifications, etc. are someone else's job.
    if (decision.domain !== 'email') return [];
    if (!decision.rawData['requiresResponse']) return [];

    const inboundSubject =
      typeof decision.rawData['subject'] === 'string'
        ? (decision.rawData['subject'] as string)
        : '';
    const inboundBody =
      typeof decision.rawData['body'] === 'string'
        ? (decision.rawData['body'] as string)
        : typeof decision.rawData['snippet'] === 'string'
          ? (decision.rawData['snippet'] as string)
          : '';
    const inboundFrom =
      typeof decision.rawData['from'] === 'string'
        ? (decision.rawData['from'] as string)
        : '';
    const inboundId =
      typeof decision.rawData['emailId'] === 'string'
        ? (decision.rawData['emailId'] as string)
        : typeof decision.rawData['messageId'] === 'string'
          ? (decision.rawData['messageId'] as string)
          : '';

    // Build the query the memory layer will use to pull similar
    // authored examples. Subject + first line of body usually carries
    // the topical signal; the From address gives weight to "what does
    // the user usually say to this person."
    const query = [inboundSubject, inboundBody.split('\n')[0] ?? '', inboundFrom]
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);

    let examples: Array<{ content: string; subject?: string }> = [];
    try {
      examples = await this.examples.searchAuthoredExamples(query, this.exampleCount);
    } catch (err) {
      // Fail open: a memory-layer hiccup shouldn't lose the candidate.
      // We'll generate the draft without the voice-grounding context.
      examples = [];
      // (No log call here — the decision-engine package doesn't pull in
      // a logger; callers wrap us in their own error handling.)
      void err;
    }

    const prompt = buildDraftPrompt({
      inboundFrom,
      inboundSubject,
      inboundBody,
      examples,
    });

    let draftBody: string;
    try {
      const response = await this.llmClient.generate(prompt, {
        temperature: 0.5,
        maxTokens: 1024,
        systemPrompt:
          "You are drafting a reply on the user's behalf in their voice. " +
          "Use the user's prior writing samples as the source of tone, " +
          "length, opening / closing patterns, and vocabulary. " +
          'Output ONLY the body of the reply — no subject, no signature, ' +
          'no preamble. Keep the response to one to four short paragraphs.',
      });
      draftBody = response.content.trim();
    } catch (err) {
      // If the LLM call fails the whole feature degrades to "no draft
      // proposed this time" — that's strictly better than a bad
      // template-based draft that doesn't match the user's voice.
      void err;
      return [];
    }

    if (!draftBody) return [];

    const candidate: CandidateAction = {
      id: randomUUID(),
      decisionId: decision.id,
      actionType: 'draft_email',
      description: `Draft a reply to "${inboundSubject || inboundFrom || 'this email'}" in your voice.`,
      domain: 'email',
      parameters: {
        emailId: inboundId,
        replyToFrom: inboundFrom,
        replyToSubject: inboundSubject,
        draftBody,
        // Surface how much grounding context the draft had so the
        // approval UI can show "drafted from N of your prior emails."
        examplesUsed: examples.length,
      },
      estimatedCostCents: 0,
      // Drafting is reversible right up to the user clicking Send.
      // The candidate ITSELF is reversible; it's the user's subsequent
      // approval-to-send that crosses an irreversible threshold (which
      // the policy engine treats accordingly).
      reversible: true,
      confidence:
        examples.length >= 3 ? ConfidenceLevel.MODERATE : ConfidenceLevel.LOW,
      reasoning:
        examples.length > 0
          ? `Drafted using ${examples.length} similar emails you've written. ` +
            'Review for voice + accuracy before sending.'
          : 'Drafted without authored-context grounding (memory layer ' +
            'returned no examples). Voice match may be weak — review carefully.',
    };

    return [candidate];
  }
}

interface BuildDraftPromptInput {
  inboundFrom: string;
  inboundSubject: string;
  inboundBody: string;
  examples: Array<{ content: string; subject?: string }>;
}

/**
 * Render the prompt sent to the LLM. Exported for testability — the
 * structure of this prompt is a load-bearing piece of the feature.
 */
export function buildDraftPrompt(input: BuildDraftPromptInput): string {
  const lines: string[] = [];
  if (input.examples.length > 0) {
    lines.push("Here are some emails the user has written. Match their voice — opening, length, vocabulary, closing — when drafting the reply.");
    lines.push('');
    for (let i = 0; i < input.examples.length; i++) {
      const ex = input.examples[i]!;
      const body = ex.content.slice(0, MAX_EXAMPLE_CHARS);
      lines.push(`Example ${i + 1}${ex.subject ? ` (subject: "${ex.subject}")` : ''}:`);
      lines.push(body);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  } else {
    lines.push("(No prior authored examples available — draft in a professional but warm tone.)");
    lines.push('');
  }
  lines.push("Now draft a reply to the following inbound email:");
  lines.push('');
  lines.push(`From: ${input.inboundFrom || '(unknown sender)'}`);
  lines.push(`Subject: ${input.inboundSubject || '(no subject)'}`);
  lines.push('');
  lines.push('Body:');
  lines.push(input.inboundBody || '(empty body)');
  lines.push('');
  lines.push('Draft the reply body (no subject line, no signature, no preamble):');
  return lines.join('\n');
}
