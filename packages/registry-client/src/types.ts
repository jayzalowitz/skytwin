export type RegistryTransport = 'stdio' | 'http' | 'sse';

export interface RegistryEntry {
  id: string;
  displayName: string;
  transport: RegistryTransport;
  installCommand?: string;
  installArgs?: string[];
  url?: string;
  oauthProvider: string | null;
  category: string;
  description: string;
  keywords: string[];
  homepage?: string;
  verified: 'anthropic' | 'community' | 'unverified';
}

export interface OAuthQuirk {
  authMode: 'oauth2' | 'api_key' | 'env_only';
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  envVarMapping?: Record<string, string>;
  notes?: string;
}

export interface RegistryClientOptions {
  smitheryUrl?: string;
  smitheryEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export interface SmitheryPackage {
  qualifiedName?: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  [key: string]: unknown;
}

export interface SmitheryResponse {
  packages?: SmitheryPackage[];
  [key: string]: unknown;
}
