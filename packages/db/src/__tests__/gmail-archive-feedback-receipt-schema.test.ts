import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('Gmail archive feedback receipt finalizer boundaries', () => {
  it('requires no additional migration and remains absent from DB barrels', () => {
    expect(existsSync(new URL('../migrations/088-gmail-archive-feedback-receipt.sql', import.meta.url)))
      .toBe(false);
    expect(read('../index.ts')).not.toContain('gmailArchiveFeedbackReceiptRepository');
    expect(read('../repositories/index.ts')).not.toContain('gmailArchiveFeedbackReceiptRepository');
  });

  it('contains no provider, credential, API, worker, or preparation-gate authority', () => {
    const source = read('../repositories/gmail-archive-feedback-receipt-repository.ts');
    expect(source).not.toMatch(/oauth|credential|provider|GmailApi|apps\/api|apps\/worker/i);
    expect(source).not.toContain('prepareGmailArchive');
    expect(source).not.toContain('gmailArchivePreparationRepository.prepare');
  });
});
