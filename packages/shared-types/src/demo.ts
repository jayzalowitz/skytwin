/**
 * Public demo route response shapes (apps/api/src/routes/demo.ts).
 *
 * These describe the unauthenticated tour-mode surface so the dashboard
 * client and any future consumer can type-check against a single source.
 */

import type { WhatWouldIDoResponse } from './twin.js';

/**
 * Response from `GET /api/v1/demo/info`.
 *
 * `available: false` when the seeded demo user is missing OR the dev
 * auth-bypass isn't active (i.e. tour mode would land on a 401-riddled
 * dashboard in production). The server intentionally omits PII like email
 * and name even when the user exists.
 */
export type DemoInfoResponse =
  | { available: false }
  | { available: true; userId: string };

/**
 * Response from `POST /api/v1/demo/preview`.
 *
 * Same shape as `WhatWouldIDoResponse` plus a rate-limit hint so the
 * dashboard's Ask Your Twin widget can show "N previews left this window"
 * if it ever wants to.
 */
export interface DemoPreviewResponse extends WhatWouldIDoResponse {
  previewRateLimit: {
    remaining: number;
    windowMs: number;
  };
}
