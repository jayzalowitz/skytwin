import { describe, expect, it } from 'vitest';
import { NotAvailableError } from '../errors.js';
import { NullEmbeddedSttPort } from '../stt-port.js';
import { NullEmbeddedTextPort } from '../text-port.js';
import { NullEmbeddedTtsPort } from '../tts-port.js';

describe('NullEmbeddedTextPort', () => {
  it('reports capabilities.available as false', () => {
    const port = new NullEmbeddedTextPort();
    expect(port.capabilities.available).toBe(false);
  });

  it('reports null modelName and contextWindow', () => {
    const port = new NullEmbeddedTextPort();
    expect(port.capabilities.modelName).toBeNull();
    expect(port.capabilities.contextWindow).toBeNull();
  });

  it('throws NotAvailableError with runtime=llama on generate()', async () => {
    const port = new NullEmbeddedTextPort();
    await expect(port.generate('hello')).rejects.toThrow(NotAvailableError);
    await expect(port.generate('hello')).rejects.toMatchObject({ runtime: 'llama' });
  });

  it('throws NotAvailableError even when opts are provided', async () => {
    const port = new NullEmbeddedTextPort();
    await expect(port.generate('hello', { maxTokens: 128, temperature: 0.5 })).rejects.toThrow(
      NotAvailableError,
    );
  });
});

describe('NullEmbeddedSttPort', () => {
  it('reports capabilities.available as false', () => {
    const port = new NullEmbeddedSttPort();
    expect(port.capabilities.available).toBe(false);
  });

  it('reports an empty supportedFormats array', () => {
    const port = new NullEmbeddedSttPort();
    expect(port.capabilities.supportedFormats).toEqual([]);
  });

  it('throws NotAvailableError with runtime=whisper on transcribe()', async () => {
    const port = new NullEmbeddedSttPort();
    const audio = Buffer.from('fake-audio');
    await expect(port.transcribe(audio)).rejects.toThrow(NotAvailableError);
    await expect(port.transcribe(audio)).rejects.toMatchObject({ runtime: 'whisper' });
  });

  it('throws NotAvailableError when language opt is provided', async () => {
    const port = new NullEmbeddedSttPort();
    const audio = Buffer.from('fake-audio');
    await expect(port.transcribe(audio, { language: 'en' })).rejects.toThrow(NotAvailableError);
  });
});

describe('NullEmbeddedTtsPort', () => {
  it('reports capabilities.available as false', () => {
    const port = new NullEmbeddedTtsPort();
    expect(port.capabilities.available).toBe(false);
  });

  it('reports an empty voices array', () => {
    const port = new NullEmbeddedTtsPort();
    expect(port.capabilities.voices).toEqual([]);
  });

  it('throws NotAvailableError with runtime=piper on synthesize()', async () => {
    const port = new NullEmbeddedTtsPort();
    await expect(port.synthesize('hello')).rejects.toThrow(NotAvailableError);
    await expect(port.synthesize('hello')).rejects.toMatchObject({ runtime: 'piper' });
  });

  it('throws NotAvailableError when voice opt is provided', async () => {
    const port = new NullEmbeddedTtsPort();
    await expect(port.synthesize('hello', { voice: 'en_US-amy-medium' })).rejects.toThrow(
      NotAvailableError,
    );
  });
});

describe('NotAvailableError', () => {
  it('has the correct name and runtime field', () => {
    const err = new NotAvailableError('llama');
    expect(err.name).toBe('NotAvailableError');
    expect(err.runtime).toBe('llama');
    expect(err.message).toContain('llama');
  });

  it('is an instance of Error', () => {
    const err = new NotAvailableError('piper');
    expect(err).toBeInstanceOf(Error);
  });
});
