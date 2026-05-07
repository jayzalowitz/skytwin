import {
  fetchAboutMe,
  submitSelfPortraitCorrection,
  fetchRiskProfile,
  saveRiskProfile,
  escapeHtml,
  renderApiError,
} from '../api-client.js';
import { showToast } from '../toast.js';
import { KEY_USER_ID } from '../storage-keys.js';

// Singleton delegator — see CLAUDE.md "Frontend Event Handling".
// Hash-gated, not container-gated, because the SPA reuses #page-content
// across all routes and container.contains is always true.
let _aboutMeListenerWired = false;
let _saveDebounce = null;
let _container = null;
let _profileText = '';
let _portrait = null;

function getCurrentUserId() {
  return localStorage.getItem(KEY_USER_ID) || '';
}

function ensureAboutMeListener() {
  if (_aboutMeListenerWired || typeof document === 'undefined') return;
  _aboutMeListenerWired = true;
  document.addEventListener('click', handleAboutMeClick);
  document.addEventListener('input', handleAboutMeInput);
  document.addEventListener('blur', handleAboutMeBlur, true);
}

function isOnAboutMe() {
  return (window.location.hash || '').split('?')[0] === '#/about-me';
}

function handleAboutMeClick(e) {
  if (!isOnAboutMe()) return;
  const target = e.target instanceof HTMLElement ? e.target.closest('[data-action]') : null;
  if (!target) return;

  const action = target.dataset.action;
  const userId = getCurrentUserId();
  if (!userId) return;

  if (action === 'correct-sentence') {
    const paragraphIndex = parseInt(target.dataset.paragraphIndex || '0', 10);
    const sentenceIndex = parseInt(target.dataset.sentenceIndex || '0', 10);
    openCorrectionModal(userId, paragraphIndex, sentenceIndex);
  } else if (action === 'save-risk-profile') {
    const textarea = document.getElementById('risk-profile-textarea');
    if (textarea) {
      saveRiskProfileNow(userId, textarea.value);
    }
  } else if (action === 'cancel-correction') {
    closeCorrectionModal();
  } else if (action === 'submit-correction') {
    submitCorrectionFromModal(userId);
  }
}

function handleAboutMeInput(e) {
  if (!isOnAboutMe()) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target || target.id !== 'risk-profile-textarea') return;
  // Debounce auto-save: 1.2s after last keystroke.
  if (_saveDebounce) clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => {
    _saveDebounce = null;
    const userId = getCurrentUserId();
    if (userId) saveRiskProfileNow(userId, target.value);
  }, 1200);
}

function handleAboutMeBlur(e) {
  if (!isOnAboutMe()) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (!target || target.id !== 'risk-profile-textarea') return;
  // Save immediately on blur if there's a pending debounce.
  if (_saveDebounce) {
    clearTimeout(_saveDebounce);
    _saveDebounce = null;
    const userId = getCurrentUserId();
    if (userId) saveRiskProfileNow(userId, target.value);
  }
}

async function saveRiskProfileNow(userId, text) {
  if (text === _profileText) return; // no-op
  _profileText = text;
  try {
    const res = await saveRiskProfile(userId, text);
    if (res && res.ok === false) {
      showToast('Could not save risk profile — will retry on next change.', { kind: 'warning' });
      return;
    }
    showToast('Risk profile saved.', { kind: 'success', durationMs: 2000 });
    renderInterpretedCaps(res?.profile?.interpretedCaps || {});
  } catch (err) {
    showToast('Risk profile save failed: ' + (err?.message || 'unknown error'), { kind: 'error' });
  }
}

function renderInterpretedCaps(caps) {
  const el = document.getElementById('interpreted-caps');
  if (!el) return;
  const keys = Object.keys(caps || {});
  if (keys.length === 0) {
    el.innerHTML = `<p class="muted">No profile interpretation yet — using safe defaults from your global autonomy settings.</p>
      <p class="muted small">LLM-driven interpretation will surface here when the prompts pipeline is wired up.</p>`;
    return;
  }
  const rows = keys.map((k) => {
    const v = caps[k];
    return `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(JSON.stringify(v))}</dd>`;
  }).join('');
  el.innerHTML = `<p>I understood your profile to mean:</p><dl class="interpreted-caps">${rows}</dl>`;
}

function openCorrectionModal(userId, paragraphIndex, sentenceIndex) {
  const existing = document.getElementById('correction-modal');
  if (existing) existing.remove();

  const sentence = lookupSentence(paragraphIndex, sentenceIndex);
  const modal = document.createElement('div');
  modal.id = 'correction-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content">
      <h3>Actually that's wrong</h3>
      <p class="muted">Tell us what's wrong with this sentence:</p>
      <blockquote>${escapeHtml(sentence)}</blockquote>
      <textarea id="correction-text" placeholder="What's the correction?" rows="4"></textarea>
      <div class="modal-actions">
        <button data-action="cancel-correction" class="btn btn-secondary">Cancel</button>
        <button data-action="submit-correction" class="btn btn-primary"
                data-paragraph-index="${paragraphIndex}"
                data-sentence-index="${sentenceIndex}">Submit correction</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  setTimeout(() => {
    const ta = document.getElementById('correction-text');
    if (ta) ta.focus();
  }, 50);
}

function closeCorrectionModal() {
  const modal = document.getElementById('correction-modal');
  if (modal) modal.remove();
}

async function submitCorrectionFromModal(userId) {
  const button = document.querySelector('#correction-modal [data-action="submit-correction"]');
  const textarea = document.getElementById('correction-text');
  if (!button || !textarea) return;

  const paragraphIndex = parseInt(button.dataset.paragraphIndex || '0', 10);
  const sentenceIndex = parseInt(button.dataset.sentenceIndex || '0', 10);
  const correction = textarea.value.trim();
  if (!correction) {
    showToast('Please enter a correction.', { kind: 'warning' });
    return;
  }

  try {
    await submitSelfPortraitCorrection(userId, paragraphIndex, sentenceIndex, correction);
    showToast('Correction recorded. Your twin will adjust.', { kind: 'success' });
    closeCorrectionModal();
  } catch (err) {
    showToast('Could not record correction: ' + (err?.message || 'unknown'), { kind: 'error' });
  }
}

function lookupSentence(paragraphIndex, sentenceIndex) {
  if (!_portrait || !Array.isArray(_portrait.paragraphs)) return '';
  const p = _portrait.paragraphs[paragraphIndex];
  if (!p) return '';
  const sentences = (p.text || '').split(/(?<=[.!?])\s+/);
  return sentences[sentenceIndex] || p.text || '';
}

function renderPortraitParagraph(paragraph, idx) {
  const text = escapeHtml(paragraph.text || '');
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sentenceHtml = sentences.map((s, sIdx) => {
    return `<span class="self-portrait-sentence">
      ${s}
      <button class="inline-correct-btn"
              data-action="correct-sentence"
              data-paragraph-index="${idx}"
              data-sentence-index="${sIdx}"
              title="Actually that's wrong">✏︎</button>
    </span>`;
  }).join(' ');

  const cites = Array.isArray(paragraph.citations) && paragraph.citations.length > 0
    ? `<div class="self-portrait-citations">${paragraph.citations.map((c) =>
        `<a href="#${escapeHtml(c.ref || '')}" class="citation-link">[${escapeHtml(c.label || c.ref || 'source')}]</a>`
      ).join(' ')}</div>`
    : '';

  return `<div class="self-portrait-paragraph">
    <p>${sentenceHtml}</p>
    ${cites}
  </div>`;
}

export async function renderAboutMe(container) {
  ensureAboutMeListener();
  _container = container;
  const userId = getCurrentUserId();
  if (!userId) {
    container.innerHTML = '<p>Please log in to view your About me page.</p>';
    return;
  }

  container.innerHTML = `
    <section class="about-me-page">
      <header>
        <h1>About me</h1>
        <p class="subtle">Your twin's understanding of you, plus how autonomously it should act on your behalf.</p>
      </header>

      <section class="self-portrait" aria-busy="true">
        <h2>What I think I know about you</h2>
        <div id="self-portrait-content"><p class="muted">Loading…</p></div>
      </section>

      <section class="risk-profile">
        <h2>How should I act on your behalf?</h2>
        <p class="subtle">Describe your autonomy preferences in plain English. Hard rails (FS denylist, resource caps, your absolute spend ceiling) are never relaxed by this profile.</p>
        <textarea id="risk-profile-textarea"
                  placeholder="e.g. 'I'm a developer. Spend up to $50/day without asking. Never touch financial accounts.'"
                  rows="6"></textarea>
        <div class="risk-profile-actions">
          <button data-action="save-risk-profile" class="btn btn-primary">Save</button>
          <span class="muted small">Auto-saves on blur or after 1.2s of inactivity.</span>
        </div>
        <div id="interpreted-caps" class="interpreted-caps-section"></div>
      </section>
    </section>
  `;

  // Fetch in parallel.
  try {
    const [portrait, profile] = await Promise.all([
      fetchAboutMe(userId).catch((err) => ({ error: err })),
      fetchRiskProfile(userId).catch((err) => ({ error: err })),
    ]);

    const portraitEl = document.getElementById('self-portrait-content');
    if (portraitEl) {
      if (portrait && !portrait.error && Array.isArray(portrait.paragraphs)) {
        _portrait = portrait;
        portraitEl.innerHTML = portrait.paragraphs.map(renderPortraitParagraph).join('');
        portraitEl.parentElement?.removeAttribute('aria-busy');
      } else {
        portraitEl.innerHTML = renderApiError({
          message: 'Could not load your portrait',
          context: portrait?.error?.message || 'Unknown error',
          retry: () => renderAboutMe(container),
        });
      }
    }

    if (profile && !profile.error) {
      _profileText = profile.profileText || '';
      const ta = document.getElementById('risk-profile-textarea');
      if (ta) ta.value = _profileText;
      renderInterpretedCaps(profile.interpretedCaps || {});
    } else {
      renderInterpretedCaps({});
    }
  } catch (err) {
    container.innerHTML = renderApiError({
      message: 'Could not load About me',
      context: err?.message || 'unknown',
      retry: () => renderAboutMe(container),
    });
  }
}
