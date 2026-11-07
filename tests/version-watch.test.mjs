import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function versionLabels(source) {
  const meta = source.match(/<meta name="bowenbuilder-version" content="([^"]*)"/);
  const constant = source.match(/const BOWENBUILDER_VERSION='([^']*)'/);
  const footer = source.match(/id="bbBuildVersion"[^>]*>\s*BowenBuilder ([0-9.]+)\s*</);
  assert.ok(meta && constant && footer, 'missing one of the three version labels');
  return {
    meta: meta[1],
    constant: constant[1],
    footer: footer[1]
  };
}

function watchSource(source) {
  const start = source.indexOf('function startBowenBuilderVersionWatch()');
  const end = source.indexOf('function reloadLatestBowenBuilder()');
  assert.ok(start !== -1 && end > start);
  return source.slice(start, end);
}

class FakeDOMParser {
  parseFromString(text) {
    const match = String(text).match(/name="bowenbuilder-version" content="([^"]*)"/);
    const content = match ? match[1] : '';
    return {
      querySelector(selector) {
        if (selector !== 'meta[name="bowenbuilder-version"]' || !match) return null;
        return { content };
      }
    };
  }
}

function createHarness({ remote = '6.2', search = '', signedIn = 'user-1', fetchBehavior } = {}) {
  const labels = versionLabels(html);
  const blockStart = html.indexOf('let bowenBuilderVersionWatchTimer=null;');
  const blockEnd = html.indexOf('\nfunction crewDateLabel');
  assert.ok(blockStart !== -1 && blockEnd > blockStart);
  const calls = {
    fetches: 0,
    signOuts: 0,
    activity: [],
    warnings: [],
    replaced: null,
    intervalDelay: null,
    cleared: 0
  };
  const document = { visibilityState: 'visible' };
  const location = {
    href: 'https://bowen-builder.vercel.app/',
    protocol: 'https:',
    hash: '',
    search,
    replace(next) {
      calls.replaced = String(next);
    }
  };
  const versionLabel = { textContent: 'New version available' };
  const lock = { classList: { removed: [], remove(name) { this.removed.push(name); } } };
  let intervalCallback = null;
  let releaseFetch = null;
  const fetch = async (url, options) => {
    calls.fetches += 1;
    calls.lastUrl = String(url);
    calls.lastOptions = options;
    if (fetchBehavior === 'hang') {
      await new Promise(resolve => {
        releaseFetch = resolve;
      });
    }
    if (fetchBehavior === 'throw') throw new Error('offline');
    if (fetchBehavior === 'http-error') return { ok: false, status: 500, async text() { return ''; } };
    return {
      ok: true,
      async text() {
        return `<meta name="bowenbuilder-version" content="${remote}">`;
      }
    };
  };
  const factory = new Function(
    'location',
    'fetch',
    'DOMParser',
    'logBowenActivity',
    'db',
    '$',
    'document',
    'setInterval',
    'clearInterval',
    'console',
    `const BOWENBUILDER_VERSION=${JSON.stringify(labels.constant)};
     let currentAuthUserId='';
     const crewTokenFromUrl=()=>new URLSearchParams(location.search).get('crew')||'';
     const guestTokenFromUrl=()=>new URLSearchParams(location.search).get('guest')||'';
     ${html.slice(blockStart, blockEnd)}
     return {
       startBowenBuilderVersionWatch,
       checkForBowenBuilderUpdate,
       reloadLatestBowenBuilder,
       signIn(id){ currentAuthUserId=id; }
     };`
  );
  const api = factory(
    location,
    fetch,
    FakeDOMParser,
    (action, detail) => calls.activity.push({ action, detail }),
    { auth: { async signOut() { calls.signOuts += 1; } } },
    id => (id === 'bbUpdateVersion' ? versionLabel : id === 'bbUpdateLock' ? lock : null),
    document,
    (callback, delay) => {
      intervalCallback = callback;
      calls.intervalDelay = delay;
      return 1;
    },
    () => {
      calls.cleared += 1;
      intervalCallback = null;
    },
    { warn(...args) { calls.warnings.push(args.map(String).join(' ')); } }
  );
  if (signedIn) api.signIn(signedIn);
  return {
    ...api,
    calls,
    document,
    location,
    versionLabel,
    lock,
    labels,
    fireInterval() {
      const callback = intervalCallback;
      if (callback) callback();
    },
    releaseFetch() {
      if (releaseFetch) releaseFetch();
    }
  };
}

async function settled() {
  await new Promise(resolve => setImmediate(resolve));
}

test('the three release labels are 6.2', () => {
  const labels = versionLabels(html);
  assert.deepEqual(labels, { meta: '6.2', constant: '6.2', footer: '6.2' });
  assert.match(html, /Increase by 0\.1 on every release/);
  assert.doesNotMatch(html, /bowenbuilder-version" content="5\.8"/);
  assert.doesNotMatch(html, /BOWENBUILDER_VERSION='5\.8'/);
  assert.doesNotMatch(html, /BowenBuilder 5\.8/);
});

test('the version watcher polls every 5 seconds and leaves other timers alone', () => {
  const watch = watchSource(html);
  assert.match(watch, /every 5 seconds/);
  assert.match(watch, /},5000\);/);
  assert.doesNotMatch(watch, /30000/);
  assert.match(html, /scheduleAlertsDispatch\(\);\s*\},30000\);/);
});

test('a different deployed version locks and signs out without reloading', async () => {
  const harness = createHarness({ remote: '6.3' });
  assert.equal(await harness.checkForBowenBuilderUpdate(), true);
  assert.equal(harness.calls.fetches, 1);
  assert.equal(harness.calls.signOuts, 1);
  assert.equal(harness.calls.cleared, 0);
  assert.deepEqual(harness.lock.classList.removed, ['hidden']);
  assert.equal(harness.versionLabel.textContent, 'BowenBuilder 6.2 → 6.3');
  assert.equal(harness.calls.activity[0].action, 'app_update_detected');
  assert.equal(harness.calls.activity[0].detail.metadata.old_version, '6.2');
  assert.equal(harness.calls.activity[0].detail.metadata.new_version, '6.3');
  assert.equal(harness.calls.replaced, null);
  assert.equal(await harness.checkForBowenBuilderUpdate(), false);
  assert.equal(harness.calls.fetches, 1);
});

test('the same deployed version does not lock or sign out', async () => {
  const harness = createHarness({ remote: '6.2' });
  assert.equal(await harness.checkForBowenBuilderUpdate(), false);
  assert.equal(harness.calls.fetches, 1);
  assert.equal(harness.calls.signOuts, 0);
  assert.deepEqual(harness.lock.classList.removed, []);
  assert.equal(harness.calls.replaced, null);
  assert.equal(harness.versionLabel.textContent, 'New version available');
});

test('the open-tab interval is 5000ms, skips a hidden tab, and checks again when visible', async () => {
  const harness = createHarness({ remote: '6.2' });
  harness.startBowenBuilderVersionWatch();
  await settled();
  assert.equal(harness.calls.intervalDelay, 5000);
  assert.equal(harness.calls.fetches, 1);

  harness.document.visibilityState = 'hidden';
  harness.fireInterval();
  await settled();
  assert.equal(harness.calls.fetches, 1);

  harness.document.visibilityState = 'visible';
  harness.fireInterval();
  await settled();
  assert.equal(harness.calls.fetches, 2);
  assert.equal(harness.calls.signOuts, 0);
});

test('a visible interval tick locks when the deployed version changes', async () => {
  const harness = createHarness({ remote: '6.3' });
  harness.startBowenBuilderVersionWatch();
  await settled();
  assert.equal(harness.calls.signOuts, 1);
  assert.equal(harness.calls.cleared, 1);
  assert.equal(harness.calls.replaced, null);
  harness.fireInterval();
  await settled();
  assert.equal(harness.calls.fetches, 1);
});

test('crew, guest, and signed-out sessions do not check', async () => {
  const crew = createHarness({ search: '?crew=qr-token' });
  crew.startBowenBuilderVersionWatch();
  await settled();
  assert.equal(await crew.checkForBowenBuilderUpdate(), false);
  assert.equal(crew.calls.fetches, 0);
  assert.equal(crew.calls.intervalDelay, null);

  const guest = createHarness({ search: '?guest=invite-token' });
  assert.equal(await guest.checkForBowenBuilderUpdate(), false);
  assert.equal(guest.calls.fetches, 0);

  const signedOut = createHarness({ signedIn: '' });
  signedOut.startBowenBuilderVersionWatch();
  await settled();
  assert.equal(signedOut.calls.intervalDelay, 5000);
  assert.equal(signedOut.calls.fetches, 0);
  signedOut.fireInterval();
  await settled();
  assert.equal(signedOut.calls.fetches, 0);
  assert.equal(signedOut.calls.signOuts, 0);
});

test('an in-flight check is reused, and failed requests do not lock', async () => {
  const hanging = createHarness({ fetchBehavior: 'hang' });
  const first = hanging.checkForBowenBuilderUpdate();
  const second = hanging.checkForBowenBuilderUpdate();
  assert.equal(hanging.calls.fetches, 1);
  hanging.releaseFetch();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(hanging.calls.signOuts, 0);

  const offline = createHarness({ fetchBehavior: 'throw' });
  assert.equal(await offline.checkForBowenBuilderUpdate(), false);
  assert.equal(offline.calls.signOuts, 0);
  assert.deepEqual(offline.lock.classList.removed, []);
  assert.match(offline.calls.warnings[0], /version check skipped/);

  const serverError = createHarness({ fetchBehavior: 'http-error' });
  assert.equal(await serverError.checkForBowenBuilderUpdate(), false);
  assert.equal(serverError.calls.signOuts, 0);
  assert.equal(serverError.calls.replaced, null);
});
