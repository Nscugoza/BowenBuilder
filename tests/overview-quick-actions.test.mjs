import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
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

function compile(name) {
  const source = extractFunction(html, name);
  const factory = new Function(
    'items',
    'db',
    'requireEditPermission',
    'subdivisionForLot',
    'logBowenActivity',
    'showLot',
    'alert',
    `${source}\nreturn ${name};`
  );
  return (ctx) => factory(
    ctx.items,
    ctx.db,
    ctx.requireEditPermission,
    ctx.subdivisionForLot,
    ctx.logBowenActivity,
    ctx.showLot,
    ctx.alert
  );
}

const completeOverview = compile('quickCompleteOverviewScheduleItem');
const inspectOverview = compile('quickSetOverviewInspectionStatus');

function overviewCompleteControl(item) {
  const isComplete = String(item.status || '').toLowerCase() === 'complete';
  return {
    label: isComplete ? '✓ Completed' : 'Mark Complete',
    disabled: isComplete
  };
}

function inspectionControl(item, status) {
  const inspectionRaw = String(item.inspection_status || 'not_linked').toLowerCase();
  return { active: inspectionRaw === status };
}

function context(item, result) {
  const items = [structuredClone(item)];
  const updates = [];
  const activity = [];
  const refreshes = [];
  const alerts = [];
  const db = {
    from(table) {
      return {
        update(payload) {
          const record = { table, payload, id: null };
          updates.push(record);
          const chain = {
            eq(_column, id) {
              record.id = id;
              return chain;
            },
            select() {
              return chain;
            },
            single() {
              if (result instanceof Error) return Promise.reject(result);
              return Promise.resolve(result);
            }
          };
          return chain;
        }
      };
    }
  };
  return {
    items,
    updates,
    activity,
    refreshes,
    alerts,
    db,
    requireEditPermission() {
      return true;
    },
    subdivisionForLot() {
      return 'subdivision-1';
    },
    logBowenActivity(action, detail) {
      activity.push({ action, detail });
    },
    showLot(preserveScroll) {
      refreshes.push(preserveScroll);
    },
    alert(message) {
      alerts.push(message);
    }
  };
}

const framingItem = {
  id: 'item-1',
  lot_id: 'lot-1',
  name: 'Framing',
  status: 'scheduled',
  inspection_status: 'requested'
};

test('lot overview source still refreshes the lot screen from item status', () => {
  assert.match(html, /const isComplete=String\(i\.status\|\|''\)\.toLowerCase\(\)==='complete'/);
  assert.match(html, /\$\{isComplete\?'✓ Completed':'Mark Complete'\}/);
  assert.match(html, /\$\{isComplete\?'disabled':''\}/);
  const overviewComplete = extractFunction(html, 'quickCompleteOverviewScheduleItem');
  assert.match(overviewComplete, /showLot\(true\)/);
  assert.doesNotMatch(overviewComplete, /\bnormalized\b/);
  const overviewInspection = extractFunction(html, 'quickSetOverviewInspectionStatus');
  assert.match(overviewInspection, /showLot\(true\)/);
  assert.match(overviewInspection, /metadata:\{inspection_status:normalized\}/);
});

test('successful Mark Complete records completion and asks the lot screen to refresh', async () => {
  const saved = { ...framingItem, status: 'complete' };
  const ctx = context(framingItem, { data: saved, error: null });
  await completeOverview(ctx)('item-1');

  assert.deepEqual(ctx.updates, [{
    table: 'schedule_items',
    payload: { status: 'complete' },
    id: 'item-1'
  }]);
  assert.equal(ctx.items[0].status, 'complete');
  assert.deepEqual(ctx.activity, [{
    action: 'schedule_completed',
    detail: {
      label: 'Marked Framing complete',
      entityType: 'schedule_item',
      entityId: 'item-1',
      subdivisionId: 'subdivision-1',
      lotId: 'lot-1',
      force: true
    }
  }]);
  assert.deepEqual(ctx.refreshes, [true]);
  assert.deepEqual(ctx.alerts, []);
  assert.deepEqual(overviewCompleteControl(ctx.items[0]), {
    label: '✓ Completed',
    disabled: true
  });
});

test('successful inspection result records the inspection activity, not completion', async () => {
  const saved = { ...framingItem, inspection_status: 'passed' };
  const ctx = context(framingItem, { data: saved, error: null });
  await inspectOverview(ctx)('item-1', 'Passed');

  assert.deepEqual(ctx.updates[0].payload, { inspection_status: 'passed' });
  assert.equal(ctx.items[0].inspection_status, 'passed');
  assert.equal(ctx.items[0].status, 'scheduled');
  assert.equal(ctx.activity.length, 1);
  assert.equal(ctx.activity[0].action, 'inspection_status_changed');
  assert.equal(ctx.activity[0].detail.label, 'Marked Framing passed');
  assert.deepEqual(ctx.activity[0].detail.metadata, { inspection_status: 'passed' });
  assert.deepEqual(ctx.refreshes, [true]);
  assert.deepEqual(ctx.alerts, []);
  assert.deepEqual(overviewCompleteControl(ctx.items[0]), {
    label: 'Mark Complete',
    disabled: false
  });
  assert.deepEqual(inspectionControl(ctx.items[0], 'passed'), { active: true });
  assert.deepEqual(inspectionControl(ctx.items[0], 'failed'), { active: false });
});

test('a failed completion write leaves the overview unchanged', async () => {
  const ctx = context(framingItem, {
    data: { ...framingItem, status: 'complete' },
    error: { message: 'permission denied' }
  });
  await completeOverview(ctx)('item-1');

  assert.equal(ctx.items[0].status, 'scheduled');
  assert.deepEqual(ctx.activity, []);
  assert.deepEqual(ctx.refreshes, []);
  assert.deepEqual(ctx.alerts, ['permission denied']);
  assert.deepEqual(overviewCompleteControl(ctx.items[0]), {
    label: 'Mark Complete',
    disabled: false
  });
});

test('a failed inspection write does not record completion or change the buttons', async () => {
  const ctx = context(framingItem, {
    data: { ...framingItem, inspection_status: 'failed', status: 'complete' },
    error: { message: 'could not save inspection' }
  });
  await inspectOverview(ctx)('item-1', 'failed');

  assert.equal(ctx.items[0].status, 'scheduled');
  assert.equal(ctx.items[0].inspection_status, 'requested');
  assert.deepEqual(ctx.activity, []);
  assert.deepEqual(ctx.refreshes, []);
  assert.deepEqual(ctx.alerts, ['could not save inspection']);
  assert.deepEqual(overviewCompleteControl(ctx.items[0]), {
    label: 'Mark Complete',
    disabled: false
  });
  assert.deepEqual(inspectionControl(ctx.items[0], 'failed'), { active: false });
});

test('a rejected completion request does not report success', async () => {
  const ctx = context(framingItem, new Error('network down'));
  await assert.rejects(() => completeOverview(ctx)('item-1'), /network down/);
  assert.equal(ctx.items[0].status, 'scheduled');
  assert.deepEqual(ctx.activity, []);
  assert.deepEqual(ctx.refreshes, []);
  assert.deepEqual(ctx.alerts, []);
  assert.equal(overviewCompleteControl(ctx.items[0]).label, 'Mark Complete');
});

test('already complete and disallowed edits do not write or refresh', async () => {
  const done = context({ ...framingItem, status: 'complete' }, { data: null, error: null });
  await completeOverview(done)('item-1');
  assert.deepEqual(done.updates, []);
  assert.deepEqual(done.activity, []);
  assert.deepEqual(done.refreshes, []);

  const denied = context(framingItem, { data: { ...framingItem, status: 'complete' }, error: null });
  denied.requireEditPermission = () => false;
  await completeOverview(denied)('item-1');
  await inspectOverview(denied)('item-1', 'passed');
  assert.deepEqual(denied.updates, []);
  assert.deepEqual(denied.activity, []);
  assert.deepEqual(denied.refreshes, []);
  assert.equal(denied.items[0].status, 'scheduled');
});
