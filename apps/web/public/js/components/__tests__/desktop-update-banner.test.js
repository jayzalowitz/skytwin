import { describe, it, expect } from 'vitest';
import {
  computeUpdateBannerState,
  renderUpdateBannerHtml,
} from '../desktop-update-banner.js';

/**
 * Tests for the desktop auto-update banner's pure layer (#370 follow-up).
 * The web test env is Node (no jsdom), so we test the view-model decision +
 * HTML-string builder directly; the thin DOM wrapper (wireDesktopUpdateBanner)
 * is not unit-tested here (it requires the skytwinDesktop bridge + a real DOM).
 */

describe('computeUpdateBannerState', () => {
  it('hides on no-update', () => {
    expect(computeUpdateBannerState({ status: 'no-update' }).visible).toBe(false);
    expect(computeUpdateBannerState({ status: 'no-update' }).phase).toBe('idle');
  });

  it('shows a quiet heads-up while available (auto-download in progress, no action)', () => {
    const s = computeUpdateBannerState({ status: 'available', version: '0.7.0' });
    expect(s.visible).toBe(true);
    expect(s.phase).toBe('available');
    expect(s.action).toBeNull();
    expect(s.dismissible).toBe(false);
    expect(s.detail).toContain('0.7.0');
  });

  it('shows rounded, clamped percent while downloading', () => {
    const s = computeUpdateBannerState({ status: 'downloading', version: '0.7.0', downloadPercent: 42.6 });
    expect(s.phase).toBe('downloading');
    expect(s.percent).toBe(43);
    expect(s.detail).toContain('43%');
    expect(computeUpdateBannerState({ status: 'downloading', downloadPercent: 250 }).percent).toBe(100);
    expect(computeUpdateBannerState({ status: 'downloading', downloadPercent: -5 }).percent).toBe(0);
  });

  it('downloading without a percent leaves percent null', () => {
    const s = computeUpdateBannerState({ status: 'downloading', version: '0.7.0' });
    expect(s.percent).toBeNull();
  });

  it('ready-to-install is the actionable state: accent CTA + dismissible', () => {
    const s = computeUpdateBannerState({ status: 'ready-to-install', version: '0.7.0' });
    expect(s.visible).toBe(true);
    expect(s.phase).toBe('ready');
    expect(s.action).toEqual({ action: 'install-update', label: 'Restart to update' });
    expect(s.dismissible).toBe(true);
    expect(s.detail).toContain('0.7.0');
  });

  it('SUPPRESSES a background-poll error when no update was in flight (no 6h nag)', () => {
    // prev is null / not visible → a routine "couldn't reach GitHub" stays silent.
    expect(computeUpdateBannerState({ status: 'error', error: 'ENOTFOUND' }, null).visible).toBe(false);
    const idlePrev = computeUpdateBannerState({ status: 'no-update' });
    expect(computeUpdateBannerState({ status: 'error', error: 'ENOTFOUND' }, idlePrev).visible).toBe(false);
  });

  it('SURFACES an error when an update was already in flight', () => {
    const downloading = computeUpdateBannerState({ status: 'downloading', downloadPercent: 50 });
    const s = computeUpdateBannerState({ status: 'error', error: 'checksum mismatch' }, downloading);
    expect(s.visible).toBe(true);
    expect(s.phase).toBe('error');
    expect(s.dismissible).toBe(true);
    expect(s.detail).toContain('checksum mismatch');
  });

  it('uses generic copy when no version is present', () => {
    const ready = computeUpdateBannerState({ status: 'ready-to-install' });
    expect(ready.detail).not.toContain('undefined');
    expect(ready.detail.toLowerCase()).toContain('new version');
  });
});

describe('renderUpdateBannerHtml', () => {
  it('returns empty string for a non-visible state', () => {
    expect(renderUpdateBannerHtml(computeUpdateBannerState({ status: 'no-update' }))).toBe('');
    expect(renderUpdateBannerHtml(null)).toBe('');
  });

  it('renders the install CTA via data-action (no inline onclick)', () => {
    const html = renderUpdateBannerHtml(computeUpdateBannerState({ status: 'ready-to-install', version: '0.7.0' }));
    expect(html).toContain('data-action="install-update"');
    expect(html).toContain('Restart to update');
    expect(html).toContain('btn-primary');
    expect(html).not.toMatch(/onclick=/i);
  });

  it('renders a progressbar with aria values while downloading', () => {
    const html = renderUpdateBannerHtml(computeUpdateBannerState({ status: 'downloading', downloadPercent: 30 }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('width:30%');
  });

  it('escapes version + error text (XSS-safe)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const downloading = computeUpdateBannerState({ status: 'downloading', downloadPercent: 10 });
    const html = renderUpdateBannerHtml(
      computeUpdateBannerState({ status: 'error', error: evil }, downloading),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
