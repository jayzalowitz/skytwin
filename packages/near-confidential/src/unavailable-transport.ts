import type {
  AttestationPolicy,
  ConfidentialFailure,
  ConfidentialModel,
  ConfidentialTransport,
  VerifiedChannel,
} from './types.js';

/** Default until a packaged, pinned verifier can prove same-connection TLS binding. */
export class UnavailableConfidentialTransport implements ConfidentialTransport {
  async discoverModels(): Promise<readonly ConfidentialModel[]> {
    throw new Error('No confidential verifier is installed');
  }

  async openVerifiedChannel(_input: { policy: AttestationPolicy; nonce: Uint8Array }): Promise<VerifiedChannel | ConfidentialFailure> {
    return {
      ok: false,
      code: 'verifier_unavailable',
      message: 'No packaged verifier can prove same-connection TLS attestation.',
      promptTransmitted: false,
    };
  }

}
