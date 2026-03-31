import { getGoogleAuthUrl, updateTrustTier } from '../api-client.js';

const STEPS = [
  {
    render: (container, next) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 1 of 3</div>
        <div class="onboarding-title">Meet your digital twin</div>
        <div class="onboarding-desc">
          SkyTwin learns how you handle email, calendar, and everyday decisions — then starts handling them for you. It watches, learns your preferences, and gradually takes action with your permission.
        </div>
        <ul class="feature-list">
          <li>Learns which emails you archive, label, or respond to</li>
          <li>Figures out your calendar preferences and meeting habits</li>
          <li>Handles routine decisions so you can focus on what matters</li>
          <li>Always asks before doing anything you haven't approved before</li>
          <li>Gets smarter every time you give it feedback</li>
        </ul>
        <div class="onboarding-actions">
          <button class="btn btn-primary btn-lg" id="onb-next-1">Get started</button>
        </div>
      `;
      document.getElementById('onb-next-1').addEventListener('click', next);
    },
  },
  {
    render: (container, next, _back, setUserId) => {
      container.innerHTML = `
        <div class="onboarding-step">Step 2 of 3</div>
        <div class="onboarding-title">Set up your identity</div>
        <div class="onboarding-desc">
          Enter a name for yourself. This can be your email or any identifier — it's how SkyTwin tracks your preferences and decisions.
        </div>
        <div class="form-group">
          <label>Your name or email</label>
          <input class="form-input" id="onb-userid" placeholder="e.g. alex@company.com" autofocus>
        </div>
        <div class="onboarding-desc" style="font-size: 0.8rem; margin-top: 0.5rem;">
          You can optionally connect your Google account to let SkyTwin read your email and calendar. This is not required — you can connect later in Settings.
        </div>
        <div style="margin-bottom: 1.5rem;">
          <button class="btn btn-outline" id="onb-connect-google">Connect Google (optional)</button>
        </div>
        <div class="onboarding-actions">
          <button class="btn btn-primary btn-lg" id="onb-next-2">Continue</button>
        </div>
      `;

      document.getElementById('onb-connect-google').addEventListener('click', async () => {
        const userId = document.getElementById('onb-userid').value.trim() || 'default-user';
        try {
          const data = await getGoogleAuthUrl(userId);
          if (data.url) window.open(data.url, '_blank');
        } catch {
          // OAuth not configured — that's fine
        }
      });

      document.getElementById('onb-next-2').addEventListener('click', () => {
        const userId = document.getElementById('onb-userid').value.trim() || 'default-user';
        setUserId(userId);
        next();
      });
    },
  },
  {
    render: (container, _next, _back, _setUserId, complete) => {
      let selectedTier = 'suggest';

      const TIERS = [
        { value: 'observer', name: 'Watch only', desc: 'Your twin observes but never takes action. Great for seeing what it would do.' },
        { value: 'suggest', name: 'Suggest first', desc: 'Your twin suggests actions and waits for you to approve each one. The safest way to start.' },
        { value: 'low_autonomy', name: 'Handle routine stuff', desc: 'Auto-handles low-risk repetitive tasks (like archiving newsletters). Asks about everything else.' },
        { value: 'moderate_autonomy', name: 'Mostly autonomous', desc: 'Handles most things on its own. Only asks about high-risk or unusual situations.' },
        { value: 'high_autonomy', name: 'Full autopilot', desc: 'Handles everything within your policies. Only stops for critical decisions or spending limits.' },
      ];

      container.innerHTML = `
        <div class="onboarding-step">Step 3 of 3</div>
        <div class="onboarding-title">How much control?</div>
        <div class="onboarding-desc">
          Choose how much autonomy your twin should have. You can change this anytime in Settings.
        </div>
        <div class="tier-options" id="tier-options">
          ${TIERS.map(t => `
            <div class="tier-option ${t.value === selectedTier ? 'selected' : ''}" data-tier="${t.value}">
              <div class="tier-radio"></div>
              <div>
                <div class="tier-name">${t.name}</div>
                <div class="tier-desc">${t.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="onboarding-actions" style="margin-top: 1.5rem;">
          <button class="btn btn-primary btn-lg" id="onb-complete">Start using SkyTwin</button>
        </div>
      `;

      document.querySelectorAll('.tier-option').forEach(el => {
        el.addEventListener('click', () => {
          document.querySelectorAll('.tier-option').forEach(o => o.classList.remove('selected'));
          el.classList.add('selected');
          selectedTier = el.getAttribute('data-tier');
        });
      });

      document.getElementById('onb-complete').addEventListener('click', () => {
        complete(selectedTier);
      });
    },
  },
];

/**
 * Render the onboarding flow.
 */
export function renderOnboarding(container, onComplete) {
  let step = 0;
  let userId = 'default-user';

  function renderStep() {
    const stepDef = STEPS[step];
    stepDef.render(
      container,
      () => { step++; renderStep(); },                          // next
      () => { if (step > 0) { step--; renderStep(); } },       // back
      (id) => { userId = id; },                                  // setUserId
      async (trustTier) => {                                     // complete
        try {
          await updateTrustTier(userId, trustTier);
        } catch {
          // User might not exist in DB yet — that's OK
        }
        onComplete(userId);
      },
    );
  }

  renderStep();
}
