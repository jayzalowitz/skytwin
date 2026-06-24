declare module 'react-native-zeroconf' {
  export interface ZeroconfResolvedService {
    host: string;
    port: number;
  }

  export type ZeroconfEvent = 'resolved' | 'error';

  export default class Zeroconf {
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
    removeAllListeners(): void;
    on(event: 'resolved', listener: (service: ZeroconfResolvedService) => void): void;
    on(event: 'error', listener: (error: unknown) => void): void;
  }
}
