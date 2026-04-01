/**
 * Theme Switcher — 3 visual variants × 2 modes
 *
 * Variants: mission-control, quiet-confidence, warm-glass
 * Modes: dark, light
 *
 * Persists to localStorage. Injects a dropdown into .page-header.
 */

const VARIANTS = [
  {
    id: 'mission-control',
    name: 'Mission Control',
    desc: 'Dense, monospace, Bloomberg terminal',
    swatch: 'swatch-mc-dark',
  },
  {
    id: 'quiet-confidence',
    name: 'Quiet Confidence',
    desc: 'Minimal, Linear/Vercel aesthetic',
    swatch: 'swatch-qc-dark',
  },
  {
    id: 'warm-glass',
    name: 'Warm Glass',
    desc: 'Glass-morphism, violet/teal gradients',
    swatch: 'swatch-wg-dark',
  },
];

const STORAGE_KEY_VARIANT = 'skytwin_theme_variant';
const STORAGE_KEY_MODE = 'skytwin_theme_mode';

function getCurrentVariant() {
  return localStorage.getItem(STORAGE_KEY_VARIANT) || 'quiet-confidence';
}

function getCurrentMode() {
  return localStorage.getItem(STORAGE_KEY_MODE) || 'dark';
}

function applyTheme(variant, mode) {
  const html = document.documentElement;
  html.setAttribute('data-variant', variant);
  html.setAttribute('data-mode', mode);
  localStorage.setItem(STORAGE_KEY_VARIANT, variant);
  localStorage.setItem(STORAGE_KEY_MODE, mode);

  // Update the dropdown UI if it exists
  updateDropdownUI(variant, mode);
}

function updateDropdownUI(variant, mode) {
  const nameEl = document.querySelector('.current-theme-name');
  const iconEl = document.querySelector('.mode-icon');
  if (nameEl) {
    const v = VARIANTS.find(v => v.id === variant);
    nameEl.textContent = v ? v.name : variant;
  }
  if (iconEl) {
    iconEl.textContent = mode === 'dark' ? '\u263E' : '\u2600';
  }

  // Update active state on options
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.variant === variant);
  });

  // Update mode toggle label
  const modeLabel = document.getElementById('mode-toggle-label');
  if (modeLabel) {
    modeLabel.textContent = mode === 'dark' ? 'Dark mode' : 'Light mode';
  }
}

function createDropdown() {
  // Don't double-create
  if (document.getElementById('theme-switcher-root')) return;

  const variant = getCurrentVariant();
  const mode = getCurrentMode();
  const currentV = VARIANTS.find(v => v.id === variant) || VARIANTS[1];

  const wrapper = document.createElement('div');
  wrapper.id = 'theme-switcher-root';
  wrapper.className = 'theme-switcher';
  wrapper.innerHTML = `
    <button class="theme-switcher-btn" aria-label="Change theme">
      <span class="mode-icon">${mode === 'dark' ? '\u263E' : '\u2600'}</span>
      <span class="current-theme-name">${currentV.name}</span>
      <span class="chevron">\u25BE</span>
    </button>
    <div class="theme-dropdown">
      <div class="theme-dropdown-section">
        <div class="theme-dropdown-label">Visual Style</div>
        ${VARIANTS.map(v => `
          <div class="theme-option ${v.id === variant ? 'active' : ''}" data-variant="${v.id}">
            <div class="theme-swatch ${v.swatch}"></div>
            <div class="theme-meta">
              <div class="theme-name">${v.name}</div>
              <div class="theme-desc">${v.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="theme-dropdown-divider"></div>
      <div class="theme-dropdown-section">
        <div class="mode-toggle-row">
          <span class="mode-toggle-label" id="mode-toggle-label">${mode === 'dark' ? 'Dark mode' : 'Light mode'}</span>
          <div class="mode-toggle-track" id="mode-toggle">
            <div class="mode-toggle-knob"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Event: toggle dropdown
  const btn = wrapper.querySelector('.theme-switcher-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrapper.classList.toggle('open');
  });

  // Event: select variant
  wrapper.querySelectorAll('.theme-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const newVariant = opt.dataset.variant;
      applyTheme(newVariant, getCurrentMode());
    });
  });

  // Event: toggle mode
  const modeToggle = wrapper.querySelector('#mode-toggle');
  modeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const newMode = getCurrentMode() === 'dark' ? 'light' : 'dark';
    applyTheme(getCurrentVariant(), newMode);
  });

  // Close on outside click
  document.addEventListener('click', () => {
    wrapper.classList.remove('open');
  });

  // Prevent dropdown clicks from closing
  wrapper.querySelector('.theme-dropdown').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  return wrapper;
}

/**
 * Mount the theme switcher into the page header.
 * Called once on app init and re-called if the header re-renders.
 */
export function mountThemeSwitcher() {
  const header = document.querySelector('.page-header');
  if (!header) return;

  // Check if already mounted
  const existing = document.getElementById('theme-switcher-root');
  if (existing) return;

  const dropdown = createDropdown();
  if (dropdown) {
    // Insert before user-badge or at end of header
    const badge = header.querySelector('.user-badge');
    if (badge) {
      header.insertBefore(dropdown, badge);
    } else {
      header.appendChild(dropdown);
    }
  }
}

/**
 * Initialize: apply saved theme immediately (before DOM is fully ready)
 * so there's no flash of unstyled content.
 */
export function initTheme() {
  applyTheme(getCurrentVariant(), getCurrentMode());
}

// Apply immediately on import
initTheme();
