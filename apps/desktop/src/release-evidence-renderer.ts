import { realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

interface RendererProofWindow {
  webContents: {
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  };
}

interface RendererProofEnvironment {
  SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE?: string;
  SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF?: string;
}

interface RendererResult {
  route: string;
  state: string;
  proposalCount: number;
}

const RENDERER_PROOF_SCRIPT = `
(async () => {
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    const start = document.querySelector('[data-action="onb-start-tour"]');
    if (start instanceof HTMLButtonElement && !start.disabled) {
      start.click();
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  while (Date.now() < deadline) {
    const surface = document.querySelector('[data-sample-state="populated"]');
    const proposals = surface?.querySelectorAll('article.sample-proposal[data-proposal-id]') ?? [];
    if (window.location.hash === '#/sample' && surface && proposals.length >= 4) {
      return { route: window.location.hash, state: 'populated', proposalCount: proposals.length };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('packaged sample renderer did not reach its populated surface');
})()
`;

function isRendererResult(value: unknown): value is RendererResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<RendererResult>;
  return result.route === '#/sample' && result.state === 'populated' &&
    Number.isSafeInteger(result.proposalCount) && (result.proposalCount ?? 0) >= 4;
}

/** Collect a test-only renderer proof when the canonical release verifier opts in. */
export async function collectPackagedSampleRendererProof(
  win: RendererProofWindow,
  userDataPath: string,
  environment: RendererProofEnvironment = process.env,
): Promise<boolean> {
  const nonce = environment.SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE;
  const output = environment.SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF;
  if (nonce === undefined && output === undefined) return false;
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce) || !output) {
    throw new Error('release renderer proof environment is incomplete');
  }
  const canonicalUserData = await realpath(resolve(userDataPath));
  const requestedOutput = resolve(output);
  const canonicalOutput = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  if (!canonicalOutput.startsWith(`${canonicalUserData}${sep}`)) {
    throw new Error('release renderer proof must stay inside the isolated Electron profile');
  }
  const result = await win.webContents.executeJavaScript(RENDERER_PROOF_SCRIPT, true);
  if (!isRendererResult(result)) throw new Error('release renderer proof result is invalid');
  const temporaryOutput = `${canonicalOutput}.tmp`;
  await writeFile(temporaryOutput, `${JSON.stringify({
    schemaVersion: 1,
    generatedBy: 'packaged-sample-renderer',
    nonce,
    route: result.route,
    state: result.state,
    proposalCount: result.proposalCount,
  })}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporaryOutput, canonicalOutput);
  return true;
}
