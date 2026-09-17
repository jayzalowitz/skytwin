import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@skytwin/embedded-llm', () => ({
  createEmbeddedTextPort: vi.fn(),
}));

import { createEmbeddedTextPort } from '@skytwin/embedded-llm';
import {
  clearEmbeddedPortCache,
  generate as embeddedGenerate,
  probeEmbeddedProviderReadiness,
} from '../providers/embedded.js';

const createPortMock = vi.mocked(createEmbeddedTextPort);
const generateMock = vi.fn();

beforeEach(() => {
  generateMock.mockReset();
  createPortMock.mockReset();
  createPortMock.mockResolvedValue({
    capabilities: {
      available: true,
      modelName: 'fake.gguf',
      contextWindow: 4096,
      artifactSha256: 'a'.repeat(64),
      runtimeVersion: 'llama.cpp-b5000',
      workflowAuthoringQualified: true,
    },
    generate: generateMock,
  });
  clearEmbeddedPortCache();
});

afterEach(() => {
  clearEmbeddedPortCache();
});

describe('embedded provider', () => {
  it('returns the trimmed output of EmbeddedTextPort.generate', async () => {
    generateMock.mockResolvedValue('  Hello there.\n');
    const result = await embeddedGenerate('', 'auto', 'Say hi');
    expect(result).toBe('Hello there.');
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('passes maxTokens and temperature through', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate('', 'auto', 'hi', { maxTokens: 64, temperature: 0.1 });
    expect(generateMock).toHaveBeenCalledWith(expect.any(String), {
      maxTokens: 64,
      temperature: 0.1,
      jsonSchema: undefined,
      disableReasoning: undefined,
    });
  });

  it('adds the no-think directive and passes structured-output controls', async () => {
    generateMock.mockResolvedValue('{"ok":true}');
    const schema = '{"type":"object"}';
    await embeddedGenerate('', 'managed', 'strict', {
      jsonSchema: schema,
      disableReasoning: true,
    });
    const promptArg = generateMock.mock.calls[0]![0] as string;
    expect(promptArg).toContain('/no_think\n\nassistant:');
    expect(generateMock).toHaveBeenCalledWith(promptArg, expect.objectContaining({
      jsonSchema: schema,
      disableReasoning: true,
    }));
  });

  it('renders ChatMessage[] as `role: content` blocks ending in `assistant:`', async () => {
    generateMock.mockResolvedValue('done');
    await embeddedGenerate('', 'auto', [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'count to 3' },
    ]);
    const promptArg = generateMock.mock.calls[0]![0] as string;
    expect(promptArg).toContain('system: be brief');
    expect(promptArg).toContain('user: count to 3');
    expect(promptArg.trimEnd().endsWith('assistant:')).toBe(true);
  });

  it('respects inline system messages over options.systemPrompt', async () => {
    generateMock.mockResolvedValue('done');
    await embeddedGenerate(
      '',
      'auto',
      [
        { role: 'system', content: 'inline-sys' },
        { role: 'user', content: 'hi' },
      ],
      { systemPrompt: 'options-sys' },
    );
    const promptArg = generateMock.mock.calls[0]![0] as string;
    expect(promptArg).toContain('inline-sys');
    expect(promptArg).not.toContain('options-sys');
  });

  it('uses options.systemPrompt when no inline system message exists', async () => {
    generateMock.mockResolvedValue('done');
    await embeddedGenerate('', 'auto', 'hi', { systemPrompt: 'be terse' });
    const promptArg = generateMock.mock.calls[0]![0] as string;
    expect(promptArg).toContain('system: be terse');
  });

  it('passes explicit modelPath when model is an absolute-looking string', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate('', '/custom/phi.gguf', 'hi');
    expect(createPortMock).toHaveBeenCalledWith({ modelPath: '/custom/phi.gguf' });
  });

  it('omits modelPath override when model is "auto"', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate('', 'auto', 'hi');
    expect(createPortMock).toHaveBeenCalledWith({});
  });

  it('treats the persisted managed sentinel as automatic discovery', async () => {
    await expect(probeEmbeddedProviderReadiness('managed')).resolves.toEqual({
      state: 'ready',
      modelName: 'fake.gguf',
      artifactSha256: 'a'.repeat(64),
      runtimeVersion: 'llama.cpp-b5000',
      workflowAuthoringQualified: true,
    });
    expect(createPortMock).toHaveBeenCalledWith({});
  });

  it.each([
    ['artifact_missing', 'artifact_unavailable'],
    ['artifact_invalid', 'artifact_unavailable'],
    ['runtime_binary_missing', 'runtime_unavailable'],
    ['runtime_incompatible', 'runtime_unavailable'],
  ] as const)('preserves %s as %s readiness', async (reason, state) => {
    createPortMock.mockResolvedValue({
      capabilities: {
        available: false,
        modelName: null,
        contextWindow: null,
        unavailableReason: reason,
      },
      generate: generateMock,
    });

    await expect(probeEmbeddedProviderReadiness('auto')).resolves.toEqual({ state, reason });
  });

  it('re-probes after an unavailable result so runtime installation is visible', async () => {
    createPortMock
      .mockResolvedValueOnce({
        capabilities: {
          available: false,
          modelName: null,
          contextWindow: null,
          unavailableReason: 'runtime_binary_missing',
        },
        generate: generateMock,
      })
      .mockResolvedValueOnce({
        capabilities: {
          available: true,
          modelName: 'ready.gguf',
          contextWindow: 4096,
          artifactSha256: 'b'.repeat(64),
          runtimeVersion: 'llama.cpp-b5001',
          workflowAuthoringQualified: true,
        },
        generate: generateMock,
      });

    await expect(probeEmbeddedProviderReadiness('auto')).resolves.toMatchObject({
      state: 'runtime_unavailable',
    });
    await expect(probeEmbeddedProviderReadiness('auto')).resolves.toEqual({
      state: 'ready',
      modelName: 'ready.gguf',
      artifactSha256: 'b'.repeat(64),
      runtimeVersion: 'llama.cpp-b5001',
      workflowAuthoringQualified: true,
    });
    expect(createPortMock).toHaveBeenCalledTimes(2);
  });

  it('caches the port across calls with the same model key', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate('', 'auto', 'hi');
    await embeddedGenerate('', 'auto', 'hello');
    expect(createPortMock).toHaveBeenCalledTimes(1);
  });

  it('re-discovers the automatic port after production cache invalidation', async () => {
    generateMock.mockResolvedValue('first');
    await embeddedGenerate('', 'auto', 'hi');
    clearEmbeddedPortCache();
    generateMock.mockResolvedValue('second');
    await expect(embeddedGenerate('', 'auto', 'again')).resolves.toBe('second');
    expect(createPortMock).toHaveBeenCalledTimes(2);
  });

  it('uses separate cache entries for different model paths', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate('', '/a.gguf', 'hi');
    await embeddedGenerate('', '/b.gguf', 'hello');
    expect(createPortMock).toHaveBeenCalledTimes(2);
  });

  it('propagates errors from the underlying port', async () => {
    generateMock.mockRejectedValue(new Error('llama-cli exited with code 1'));
    await expect(embeddedGenerate('', 'auto', 'hi')).rejects.toThrow(/exited with code 1/);
  });

  it('ignores apiKey and baseUrl arguments', async () => {
    generateMock.mockResolvedValue('ok');
    await embeddedGenerate(
      'sk-fake',
      'auto',
      'hi',
      { baseUrl: 'http://example.com' },
    );
    // No assertion on generateMock args other than that it ran — apiKey
    // and baseUrl are intentionally ignored by the provider.
    expect(generateMock).toHaveBeenCalled();
  });
});
