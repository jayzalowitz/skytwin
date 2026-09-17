import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPackagedSampleRendererProof } from '../release-evidence-renderer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('packaged sample renderer evidence', () => {
  it('records a nonce-bound populated sample route reached through the real UI selectors', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'skytwin-renderer-proof-'));
    roots.push(profile);
    const output = join(profile, 'renderer-proof.json');
    const executeJavaScript = vi.fn().mockResolvedValue({ route: '#/sample', state: 'populated', proposalCount: 4 });
    await expect(collectPackagedSampleRendererProof(
      { webContents: { executeJavaScript } },
      profile,
      {
        SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE: 'a'.repeat(64),
        SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF: output,
      },
    )).resolves.toBe(true);
    const script = executeJavaScript.mock.calls[0]?.[0] as string;
    expect(script).toContain('[data-action="onb-start-tour"]');
    expect(script).toContain('[data-sample-state="populated"]');
    const onboardingSource = await readFile(
      new URL('../../../web/public/js/pages/onboarding.js', import.meta.url),
      'utf8',
    );
    const sampleSource = await readFile(
      new URL('../../../web/public/js/pages/sample.js', import.meta.url),
      'utf8',
    );
    expect(onboardingSource).toContain('data-action="onb-start-tour"');
    expect(onboardingSource).toContain("case 'onb-start-tour'");
    expect(onboardingSource).toContain("window.location.hash = '#/sample'");
    expect(sampleSource).toContain('data-sample-state="populated"');
    expect(sampleSource).toContain('class="${classes.join(\' \')}" data-proposal-id=');
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
      schemaVersion: 1,
      generatedBy: 'packaged-sample-renderer',
      nonce: 'a'.repeat(64),
      route: '#/sample',
      state: 'populated',
      proposalCount: 4,
    });
  });

  it('is inert without opt-in and rejects incomplete or escaping proof destinations', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'skytwin-renderer-proof-'));
    roots.push(profile);
    const executeJavaScript = vi.fn();
    const win = { webContents: { executeJavaScript } };
    await expect(collectPackagedSampleRendererProof(win, profile, {})).resolves.toBe(false);
    await expect(collectPackagedSampleRendererProof(win, profile, {
      SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE: 'a'.repeat(64),
    })).rejects.toThrow(/incomplete/);
    await expect(collectPackagedSampleRendererProof(win, profile, {
      SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE: 'a'.repeat(64),
      SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF: join(profile, '..', 'escape.json'),
    })).rejects.toThrow(/inside/);
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('accepts an output reached through a canonical temporary-directory alias', async () => {
    const holder = await mkdtemp(join(tmpdir(), 'skytwin-renderer-alias-'));
    roots.push(holder);
    const profile = join(holder, 'profile');
    const alias = join(holder, 'alias');
    await mkdir(profile);
    await symlink(profile, alias);
    const executeJavaScript = vi.fn().mockResolvedValue({ route: '#/sample', state: 'populated', proposalCount: 4 });
    await expect(collectPackagedSampleRendererProof(
      { webContents: { executeJavaScript } },
      profile,
      {
        SKYTWIN_RELEASE_EVIDENCE_RENDERER_NONCE: 'b'.repeat(64),
        SKYTWIN_RELEASE_EVIDENCE_RENDERER_PROOF: join(alias, 'proof.json'),
      },
    )).resolves.toBe(true);
    await expect(readFile(join(profile, 'proof.json'), 'utf8')).resolves.toContain('packaged-sample-renderer');
  });
});
