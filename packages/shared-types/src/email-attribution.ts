export const SKYTWIN_REPO_URL = 'https://github.com/jayzalowitz/skytwin';

export const SKYTWIN_EMAIL_ATTRIBUTION_TEXT =
  `Sent by SkyTwin - the open-source digital twin: ${SKYTWIN_REPO_URL}`;

export const SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE =
  `-- \n${SKYTWIN_EMAIL_ATTRIBUTION_TEXT}`;

export const EMAIL_ATTRIBUTION_SETTINGS_KEY = 'emailAttributionSignatureEnabled';

export function resolveEmailAttributionEnabled(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  return settings?.[EMAIL_ATTRIBUTION_SETTINGS_KEY] !== false;
}

export function hasSkyTwinEmailAttribution(body: string): boolean {
  return /(^|\n)\s*Sent by SkyTwin\b/i.test(body) || body.includes(SKYTWIN_REPO_URL);
}

export function appendSkyTwinEmailAttribution(
  body: string,
  options: { enabled?: boolean } = {},
): string {
  if (options.enabled === false) return body;
  if (hasSkyTwinEmailAttribution(body)) return body;

  const trimmed = body.trimEnd();
  if (trimmed.length === 0) return SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE;
  return `${trimmed}\n\n${SKYTWIN_EMAIL_ATTRIBUTION_SIGNATURE}`;
}
