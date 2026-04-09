/**
 * Trust tier represents how much autonomy SkyTwin has earned for a user.
 * Higher tiers allow more autonomous action.
 */
export enum TrustTier {
  /** No autonomy - all actions require explicit approval */
  OBSERVER = 'observer',
  /** Can suggest actions but must get approval */
  SUGGEST = 'suggest',
  /** Can auto-execute low-risk actions in approved domains */
  LOW_AUTONOMY = 'low_autonomy',
  /** Can auto-execute moderate-risk actions in approved domains */
  MODERATE_AUTONOMY = 'moderate_autonomy',
  /** Can auto-execute most actions except high-risk ones */
  HIGH_AUTONOMY = 'high_autonomy',
}

/**
 * Risk tier classification for candidate actions.
 */
export enum RiskTier {
  NEGLIGIBLE = 'negligible',
  LOW = 'low',
  MODERATE = 'moderate',
  HIGH = 'high',
  CRITICAL = 'critical',
}

/**
 * Confidence level for inferences about user preferences.
 */
export enum ConfidenceLevel {
  /** Barely any evidence */
  SPECULATIVE = 'speculative',
  /** Some evidence, but not yet reliable */
  LOW = 'low',
  /** Reasonable evidence from multiple signals */
  MODERATE = 'moderate',
  /** Strong evidence from consistent behavior */
  HIGH = 'high',
  /** Very strong evidence, directly confirmed by user */
  CONFIRMED = 'confirmed',
}

/**
 * Type of situation that triggered a decision.
 */
export enum SituationType {
  EMAIL_TRIAGE = 'email_triage',
  CALENDAR_INVITE = 'calendar_invite',
  CALENDAR_CONFLICT = 'calendar_conflict',
  CALENDAR_UPDATE = 'calendar_update',
  SUBSCRIPTION_RENEWAL = 'subscription_renewal',
  GROCERY_REORDER = 'grocery_reorder',
  TRAVEL_DECISION = 'travel_decision',
  FINANCE_OPERATION = 'finance_operation',
  SMART_HOME = 'smart_home',
  TASK_MANAGEMENT = 'task_management',
  SOCIAL_MEDIA = 'social_media',
  DOCUMENT_MANAGEMENT = 'document_management',
  HEALTH_WELLNESS = 'health_wellness',
  GENERIC = 'generic',
}

/**
 * Dimensions along which risk is assessed.
 */
export enum RiskDimension {
  REVERSIBILITY = 'reversibility',
  FINANCIAL_IMPACT = 'financial_impact',
  LEGAL_SENSITIVITY = 'legal_sensitivity',
  PRIVACY_SENSITIVITY = 'privacy_sensitivity',
  RELATIONSHIP_SENSITIVITY = 'relationship_sensitivity',
  OPERATIONAL_RISK = 'operational_risk',
}
