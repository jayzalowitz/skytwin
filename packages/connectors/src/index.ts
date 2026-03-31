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
export { GmailConnector } from './gmail-connector.js';
export { GoogleCalendarConnector } from './google-calendar-connector.js';

// OAuth
export { generateAuthUrl, exchangeCode, refreshAccessToken, revokeToken } from './oauth/google-oauth.js';
export type { GoogleOAuthConfig } from './oauth/google-oauth.js';
export type { OAuthTokenStore } from './oauth/token-store.js';
export { DbTokenStore } from './oauth/db-token-store.js';
