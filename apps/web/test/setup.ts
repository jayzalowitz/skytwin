/**
 * Minimal DOM/browser-global stubs for unit-testing the web dashboard's
 * browser ESM modules in a Node vitest environment, without adding a
 * jsdom/happy-dom dependency the rest of the repo doesn't carry.
 *
 * Only the surface the pure helpers actually touch is stubbed:
 *   - `document.createElement(...).textContent`/`.innerHTML` — used by
 *     `escapeHtml` in `api-client.js`.
 *   - `window.location.hash` — read by route parsers / hash gates.
 *   - `localStorage` — read for the current user id.
 *
 * The `escapeHtml` stub mirrors browser behavior closely enough for the
 * assertions in these tests (escapes `&`, `<`, `>`, `"`, `'`).
 */

interface FakeElement {
  _text: string;
  textContent: string;
  innerHTML: string;
}

function makeElement(): FakeElement {
  const el = {
    _text: '',
    get textContent() {
      return el._text;
    },
    set textContent(v: string) {
      el._text = v == null ? '' : String(v);
    },
    get innerHTML() {
      // Match the browser: setting textContent then reading innerHTML
      // returns the HTML-escaped form of the text. api-client.escapeHtml
      // additionally replaces " and ' afterwards.
      return el._text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
    set innerHTML(_v: string) {
      /* not used by the helpers under test */
    },
  };
  return el;
}

if (typeof (globalThis as Record<string, unknown>).document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => makeElement(),
  };
}

if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    location: { hash: '' },
  };
}

if (typeof (globalThis as Record<string, unknown>).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
}
