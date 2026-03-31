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
