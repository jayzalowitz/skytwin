import { ConfidenceLevel, RiskTier, TrustTier } from '@skytwin/shared-types';
import type { EvalScenario } from '../scenario.js';

export const SUBSCRIPTION_SCENARIOS: EvalScenario[] = [
  {
    id: 'sub-001', name: 'Auto-renew cheap subscription',
    description: 'Low-cost subscription with confirmed auto-renew preference.',
    setupTwin: { preferences: [{ id: 'p1', domain: 'subscriptions', key: 'auto_renew_under_20', value: true, confidence: ConfidenceLevel.CONFIRMED, source: 'explicit', evidenceIds: [], createdAt: new Date(), updatedAt: new Date() }] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Spotify - $9.99', costCents: 999, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.LOW, shouldEscalate: false },
    tags: ['subscription', 'low-cost'],
  },
  {
    id: 'sub-002', name: 'Expensive renewal needs approval',
    description: 'Annual subscription over $100 should escalate.',
    setupTwin: { preferences: [] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Adobe Creative Cloud - $599/yr', costCents: 59900, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.HIGH, shouldEscalate: true },
    tags: ['subscription', 'high-cost', 'escalation'],
  },
  {
    id: 'sub-003', name: 'Trial expiring — cancel',
    description: 'User prefers to cancel trials before they convert.',
    setupTwin: { preferences: [{ id: 'p3', domain: 'subscriptions', key: 'cancel_trials', value: true, confidence: ConfidenceLevel.HIGH, source: 'explicit', evidenceIds: [], createdAt: new Date(), updatedAt: new Date() }] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Free trial ending - $29.99/mo', costCents: 2999, isTrial: true, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.MODERATE, shouldEscalate: false },
    tags: ['subscription', 'trial', 'cancel'],
  },
  {
    id: 'sub-004', name: 'Price increase notification',
    description: 'Subscription price went up — needs user review.',
    setupTwin: { preferences: [] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Netflix price increase $15.99 → $22.99', costCents: 2299, previousCostCents: 1599, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.MODERATE, shouldEscalate: true },
    tags: ['subscription', 'price-change'],
  },
  {
    id: 'sub-005', name: 'Duplicate subscription detected',
    description: 'Two subscriptions for similar services.',
    setupTwin: { preferences: [] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Hulu renewal', costCents: 1599, similarActive: ['Netflix', 'Disney+'], trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.LOW, shouldEscalate: true },
    tags: ['subscription', 'duplicate'],
  },
  {
    id: 'sub-006', name: 'Business subscription on company card',
    description: 'Work subscription charged to company should auto-renew.',
    setupTwin: { preferences: [{ id: 'p6', domain: 'subscriptions', key: 'auto_renew_business', value: true, confidence: ConfidenceLevel.HIGH, source: 'explicit', evidenceIds: [], createdAt: new Date(), updatedAt: new Date() }] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Slack Business+ - $12.50/user', costCents: 12500, isBusinessExpense: true, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.MODERATE, shouldEscalate: false },
    tags: ['subscription', 'business'],
  },
  {
    id: 'sub-007', name: 'Unused subscription flagged',
    description: 'Subscription with no usage in 60 days.',
    setupTwin: { preferences: [] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'Headspace renewal', costCents: 1299, lastUsedDaysAgo: 65, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.LOW, shouldEscalate: true },
    tags: ['subscription', 'unused'],
  },
  {
    id: 'sub-008', name: 'Annual renewal with downgrade option',
    description: 'Annual plan renewal where a cheaper tier would suffice.',
    setupTwin: { preferences: [] },
    event: { source: 'billing', type: 'subscription_renewal', subject: 'GitHub Enterprise - $21/user/mo', costCents: 21000, downgradeAvailable: true, trustTier: TrustTier.MODERATE_AUTONOMY },
    expectedOutcome: { shouldAutoExecute: false, maxRiskTier: RiskTier.MODERATE, shouldEscalate: true },
    tags: ['subscription', 'downgrade'],
  },
];
