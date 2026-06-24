import { searchMemory, escapeHtml, renderApiError } from '../api-client.js';

/**
 * Instant memory search page (#/search).
 *
 * The semantic retrieval engine has always existed but was reachable only
 * through a chat turn. This surfaces it directly: type, and see matches
 * across your emails, calendar, and what the twin has learned.
 *
 * Listeners attach to the freshly-rendered input each time `renderSearch`
 * runs (the SPA swaps `#page-content` innerHTML per navigation), so there's
 * no listener accumulation and no stale-userId closure — `userId` is the
 * current value passed by `navigate()` on every render.
 */

// Plain-language labels for record origins — the raw values are connector /
// record-type slugs. Per the human-meaningful-presentation rule, an unmapped
// slug must never leak to the UI; the fallback is the generic 'your memory'.
const SOURCE_LABELS = {
  gmail: 'Gmail',
  email: 'Email',
  calendar: 'Calendar',
  decision: 'a past decision',
  episode: 'a past decision',
  signal: 'your activity',
  extract: 'your notes',
  note: 'your notes',
  voice: 'a voice note',
  page: 'your memory',
  memory: 'your memory',
};

function prettySource(source) {
  if (typeof source !== 'string' || !source) return 'your memory';
  // hasOwnProperty guard so an untrusted slug ('__proto__' / 'constructor')
  // can't resolve to a prototype member.
  return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source)
    ? SOURCE_LABELS[source]
    : 'your memory';
}

const DEBOUNCE_MS = 220;
const SEARCH_LIMIT = 15;

// Monotonic request token: a slow earlier response must never overwrite the
// results of a later query the user has already typed.
let _searchSeq = 0;
let _debounceTimer;

export function renderSearch(container, userId) {
  container.innerHTML = `
    <div class="search-page" data-region="search">
      <div class="search-bar">
        <input
          id="search-input"
          class="search-input"
          type="search"
          placeholder="Search your emails, calendar, and what your twin has learned…"
          autocomplete="off"
          aria-label="Search your memory"
        />
      </div>
      <div id="search-results" class="search-results" data-region="results">
        <div class="search-hint">Start typing to search everything your twin remembers.</div>
      </div>
    </div>
  `;

  const input = container.querySelector('#search-input');
  const results = container.querySelector('#search-results');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(_debounceTimer);
    if (!query) {
      _searchSeq += 1; // cancel any in-flight render
      results.innerHTML = '<div class="search-hint">Start typing to search everything your twin remembers.</div>';
      return;
    }
    results.innerHTML = '<div class="search-hint">Searching…</div>';
    _debounceTimer = setTimeout(() => {
      void runSearch(query, userId, results);
    }, DEBOUNCE_MS);
  });

  input.focus();
}

async function runSearch(query, userId, results) {
  const seq = ++_searchSeq;
  let data;
  try {
    data = await searchMemory(userId, query, SEARCH_LIMIT);
  } catch (err) {
    if (seq !== _searchSeq) return; // a newer query superseded this one
    results.innerHTML = renderApiError(err, { context: "Couldn't run the search." });
    return;
  }
  if (seq !== _searchSeq) return; // stale response — newer query in flight

  const items = Array.isArray(data?.results) ? data.results : [];
  if (items.length === 0) {
    const degraded = data?.degraded
      ? ' Search is warming up — try again in a moment.'
      : '';
    results.innerHTML = `<div class="search-empty">No matches for “${escapeHtml(query)}”.${escapeHtml(degraded)}</div>`;
    return;
  }

  const list = items
    .map((r) => {
      const snippet = escapeHtml(typeof r?.snippet === 'string' ? r.snippet : '');
      const origin = escapeHtml(prettySource(r?.source));
      return `
        <li class="search-result">
          <div class="search-result-text">${snippet}</div>
          <div class="search-result-meta">from ${origin}</div>
        </li>
      `;
    })
    .join('');
  results.innerHTML = `<ul class="search-result-list">${list}</ul>`;
}
