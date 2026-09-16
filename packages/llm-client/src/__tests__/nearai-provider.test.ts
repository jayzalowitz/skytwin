import { describe, expect, it } from 'vitest';
import { generate } from '../providers/nearai.js';

describe('NEAR AI confidential provider', () => {
  it('fails before transport while workload verification remains incomplete', async () => {
    await expect(generate(
      'near-key',
      'deepseek-ai/DeepSeek-V4-Flash',
      'sensitive prompt',
    )).rejects.toThrow('cannot yet pin the dynamically selected inference workload');
  });
});
