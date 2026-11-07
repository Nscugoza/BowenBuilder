import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../supabase/migrations/20261107220011_schedule_appointment_time.sql', import.meta.url),
  'utf8'
);

function extractFunction(source, name) {
  const asyncAt = source.indexOf(`async function ${name}(`);
  const plainAt = source.indexOf(`function ${name}(`);
  const start = asyncAt === -1 ? plainAt : asyncAt;
  assert.notEqual(start, -1, `missing ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

const existing = {
  id: 'item-1',
  lot_id: 'lot-1',
  name: 'Building Inspection',
  status: 'scheduled',
  starts_at: '2026-11-07T12:00:00Z',
  ends_at: '2026-11-08T12:00:00Z',
  appointment_time: '10:00:00',
  inspection_status: 'requested'
};

function partialUpdate(row, patch) {
  const next = { ...row };
  for (const key of Object.keys(patch)) next[key] = patch[key];
  return next;
}

function compile(name) {
  const source = extractFunction(html, name);
  return new Function(
    'items',
    'db',
    'requireEditPermission',
    'subdivisionForLot',
    'logBowenActivity',
    'showLot',
    'renderSubdivisionAgenda',
    'alert',
    `${source}\nreturn ${name};`
  );
}

function runChecker(name) {
  const fn = compile(name);
  return async (status) => {
    const items = [structuredClone(existing)];
    const patches = [];
    const db = {
      from(table) {
        return {
          update(patch) {
            patches.push({ table, patch });
            const chain = {
              eq() { return chain; },
              select() { return chain; },
              async single() {
                const next = partialUpdate(items[0], patch);
                items[0] = next;
                return { data: next, error: null };
              }
            };
            return chain;
          }
        };
      }
    };
    const ctx = {
      items,
      db,
      requireEditPermission() { return true; },
      subdivisionForLot() { return 'subdivision-1'; },
      logBowenActivity() {},
      showLot() {},
      renderSubdivisionAgenda() {},
      alert() { throw new Error('unexpected alert'); }
    };
    await fn(ctx.items, ctx.db, ctx.requireEditPermission, ctx.subdivisionForLot, ctx.logBowenActivity, ctx.showLot, ctx.renderSubdivisionAgenda, ctx.alert)('item-1', status);
    return { items, patches };
  };
}

function applyUpdateRpc(row, payload) {
  const text = (key) => {
    if (!Object.prototype.hasOwnProperty.call(payload, key) || payload[key] == null) return null;
    const value = String(payload[key]).trim();
    return value === '' ? null : value;
  };
  return {
    ...row,
    starts_at: text('starts_at') ?? row.starts_at,
    ends_at: text('ends_at') ?? row.ends_at,
    inspection_status: text('inspection_status') ?? row.inspection_status,
    appointment_time: Object.prototype.hasOwnProperty.call(payload, 'appointment_time')
      ? (payload.appointment_time == null || String(payload.appointment_time).trim() === '' ? null : String(payload.appointment_time).trim())
      : row.appointment_time
  };
}

for (const [name, label] of [
  ['quickSetOverviewInspectionStatus', 'lot overview'],
  ['quickSetAgendaInspectionStatus', 'subdivision agenda']
]) {
  test(`${label} pass and fail send only inspection_status and keep date and time`, async () => {
    const check = runChecker(name);
    for (const status of ['passed', 'Failed']) {
      const { items, patches } = await check(status);
      assert.deepEqual(Object.keys(patches[0].patch), ['inspection_status']);
      assert.equal(patches[0].patch.inspection_status, status.toLowerCase());
      assert.equal(items[0].starts_at, existing.starts_at);
      assert.equal(items[0].ends_at, existing.ends_at);
      assert.equal(items[0].appointment_time, existing.appointment_time);
      assert.equal(items[0].inspection_status, status.toLowerCase());
    }
    const source = extractFunction(html, name);
    assert.match(source, /\.update\(\{inspection_status:normalized\}\)/);
    assert.doesNotMatch(source, /appointment_time|starts_at|ends_at/);
  });
}

test('update RPC keeps dates when omitted or null, and clears appointment time only when the key is present', () => {
  assert.match(migration, /starts_at=coalesce\(\(p_payload->>'starts_at'\)::timestamptz,starts_at\)/);
  assert.match(migration, /ends_at=coalesce\(\(p_payload->>'ends_at'\)::timestamptz,ends_at\)/);
  assert.match(migration, /when p_payload \? 'appointment_time'/);

  const inspectionOnly = applyUpdateRpc(existing, { inspection_status: 'passed' });
  assert.equal(inspectionOnly.starts_at, existing.starts_at);
  assert.equal(inspectionOnly.ends_at, existing.ends_at);
  assert.equal(inspectionOnly.appointment_time, '10:00:00');
  assert.equal(inspectionOnly.inspection_status, 'passed');

  const explicitNullDates = applyUpdateRpc(existing, {
    inspection_status: 'failed',
    starts_at: null,
    ends_at: null
  });
  assert.equal(explicitNullDates.starts_at, existing.starts_at);
  assert.equal(explicitNullDates.ends_at, existing.ends_at);
  assert.equal(explicitNullDates.appointment_time, '10:00:00');

  const cleared = applyUpdateRpc(existing, { appointment_time: null });
  assert.equal(cleared.appointment_time, null);
  assert.equal(cleared.starts_at, existing.starts_at);
  assert.equal(cleared.ends_at, existing.ends_at);

  const blank = applyUpdateRpc(existing, { appointment_time: '  ' });
  assert.equal(blank.appointment_time, null);
  assert.equal(blank.starts_at, existing.starts_at);
});
