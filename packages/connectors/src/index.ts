// Interface-based connector types
export type {
  RawSignal,
  SignalHandler,
} from './connector-interface.js';
export type { SignalConnector } from './connector-interface.js';

// Class-based connector base (pre-existing)
export {
  SignalConnector as SignalConnectorBase,
} from './signal-connector.js';
export type { Signal } from './signal-connector.js';

// Mock connector implementations
export { MockEmailConnector } from './mock-email-connector.js';
export { MockCalendarConnector } from './mock-calendar-connector.js';

// Real connector implementations
export { GmailConnector, normalizeSenderAddress, parseListId } from './gmail-connector.js';
export type { CursorStore, LabelObserver } from './gmail-connector.js';
export {
  classifyEmailAuthoringTier,
  extractBareAddress,
  isAutomatedSender,
  splitAddressList,
} from './authoring-tier.js';
export type { AuthoringTier, EmailAuthoringInputs } from './authoring-tier.js';
export { classifyCalendarAuthoringTier } from './calendar-authoring-tier.js';
export type { CalendarAuthoringInputs } from './calendar-authoring-tier.js';
export { GoogleCalendarConnector } from './google-calendar-connector.js';

// OAuth
export {
  generateAuthUrl,
  generatePkcePair,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  OAuthRefreshError,
} from './oauth/google-oauth.js';
export type { GoogleOAuthConfig, PkcePair } from './oauth/google-oauth.js';
export type { OAuthTokenStore } from './oauth/token-store.js';
export { DbTokenStore } from './oauth/db-token-store.js';
