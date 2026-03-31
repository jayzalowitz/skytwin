import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';
import type { EvalScenario } from '../scenario.js';

/**
 * Email triage evaluation scenarios.
 *
 * These test SkyTwin's ability to correctly handle different types of emails:
 * newsletters, client communications, renewals, suspicious emails, and routine replies.
 */
export const EMAIL_TRIAGE_SCENARIOS: EvalScenario[] = [
  {
    id: 'email-triage-001',
    name: 'Low-priority newsletter should be auto-archived',
    description:
      'A weekly tech newsletter should be automatically archived without bothering the user.',
    setupTwin: {
      preferences: [
        {
          id: 'pref_archive_newsletters',
          domain: 'email',
          key: 'auto_archive',
          value: true,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: ['ev_001', 'ev_002'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'newsletter@techdigest.com',
      subject: 'Weekly Tech Digest - March Edition',
      body: 'Here are the top tech stories this week...',
      importance: 'low',
      category: 'newsletter',
    },
    expectedOutcome: {
      shouldAutoExecute: true,
      expectedActionType: 'archive_email',
      maxRiskTier: RiskTier.LOW,
      shouldEscalate: false,
    },
    tags: ['email', 'newsletter', 'auto-archive', 'low-risk'],
  },
  {
    id: 'email-triage-002',
    name: 'Important client email should escalate',
    description:
      'An urgent email from an important client should be escalated to the user for review.',
    setupTwin: {
      preferences: [
        {
          id: 'pref_client_escalate',
          domain: 'email',
          key: 'escalate_client_emails',
          value: true,
          confidence: ConfidenceLevel.CONFIRMED,
          source: 'explicit',
          evidenceIds: ['ev_003'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'client@bigcorp.com',
      subject: 'Urgent: Contract Review Needed',
      body: 'We need your review on the updated contract terms by end of day.',
      importance: 'high',
      category: 'client_communication',
    },
    expectedOutcome: {
      shouldAutoExecute: false,
      expectedActionType: 'escalate_to_user',
      maxRiskTier: RiskTier.MODERATE,
      shouldEscalate: true,
    },
    tags: ['email', 'client', 'escalation', 'high-priority'],
  },
  {
    id: 'email-triage-003',
    name: 'Subscription renewal under spend limit should auto-approve',
    description:
      'A $49/month subscription renewal that is under the user spend limit should be auto-approved.',
    setupTwin: {
      preferences: [
        {
          id: 'pref_auto_renew',
          domain: 'subscriptions',
          key: 'auto_renew',
          value: true,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: ['ev_004', 'ev_005'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'billing@saasprovider.com',
      subject: 'Subscription Renewal - $49/month',
      body: 'Your subscription will renew automatically in 3 days.',
      importance: 'normal',
      category: 'billing',
      amount: 49,
      costCents: 4900,
      subscriptionId: 'sub_001',
    },
    expectedOutcome: {
      shouldAutoExecute: false,
      maxRiskTier: RiskTier.MODERATE,
      shouldEscalate: true,
    },
    tags: ['email', 'subscription', 'renewal', 'spending'],
  },
  {
    id: 'email-triage-004',
    name: 'Suspicious email should escalate',
    description:
      'A suspicious email from an unknown domain should be escalated and never auto-executed.',
    setupTwin: {
      preferences: [],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'unknown@suspicious-domain.xyz',
      subject: 'You have won a prize!',
      body: 'Click here to claim your prize immediately!',
      importance: 'normal',
      category: 'suspicious',
    },
    expectedOutcome: {
      shouldAutoExecute: false,
      expectedActionType: 'escalate_to_user',
      maxRiskTier: RiskTier.MODERATE,
      shouldEscalate: true,
    },
    tags: ['email', 'suspicious', 'safety', 'escalation'],
  },
  {
    id: 'email-triage-005',
    name: 'Routine colleague reply should draft response',
    description:
      'A routine follow-up from a colleague should offer to draft a reply.',
    setupTwin: {
      preferences: [
        {
          id: 'pref_draft_replies',
          domain: 'email',
          key: 'auto_draft_reply',
          value: true,
          confidence: ConfidenceLevel.MODERATE,
          source: 'inferred',
          evidenceIds: ['ev_006', 'ev_007', 'ev_008'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'colleague@company.com',
      subject: 'Re: Meeting Notes',
      body: 'Thanks for sharing. I had a few follow-up questions on item 3.',
      importance: 'normal',
      category: 'routine_reply',
      requiresResponse: true,
    },
    expectedOutcome: {
      shouldAutoExecute: false,
      maxRiskTier: RiskTier.LOW,
      shouldEscalate: true,
    },
    tags: ['email', 'routine', 'draft-reply'],
  },
  {
    id: 'email-triage-006',
    name: 'High-volume newsletter with established archive preference',
    description:
      'When the user has an established pattern of archiving newsletters, it should auto-archive.',
    setupTwin: {
      preferences: [
        {
          id: 'pref_archive_all',
          domain: 'email',
          key: 'auto_archive',
          value: true,
          confidence: ConfidenceLevel.CONFIRMED,
          source: 'corrected',
          evidenceIds: ['ev_009', 'ev_010', 'ev_011', 'ev_012', 'ev_013'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    },
    event: {
      source: 'email',
      type: 'email_received',
      from: 'updates@social-network.com',
      subject: 'You have 5 new notifications',
      body: 'Check out what happened on your feed today.',
      importance: 'low',
      category: 'newsletter',
    },
    expectedOutcome: {
      shouldAutoExecute: true,
      expectedActionType: 'archive_email',
      maxRiskTier: RiskTier.NEGLIGIBLE,
      shouldEscalate: false,
    },
    tags: ['email', 'newsletter', 'high-confidence', 'auto-archive'],
  },
];
