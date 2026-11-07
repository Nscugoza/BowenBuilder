import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
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

function load(names) {
  const source = names.map(name => extractFunction(html, name)).join('\n');
  return new Function(`${source}\nreturn { ${names.join(', ')} };`)();
}

const api = load([
  'scheduleAppointmentTimeValue',
  'scheduleAppointmentTimeStorage',
  'scheduleAppointmentTimeLabel',
  'scheduleDateRangeLabel',
  'scheduleMessageDateText',
  'scheduleWriteTimes',
  'dateInputValue',
  'localDateKey',
  'dateFromKey',
  'itemStartKey',
  'itemEndKey',
  'calendarDaysBetween',
  'calendarAddDays',
  'scheduleMovePayload',
  'scheduleAlertDateWithTime'
]);

test('a noon-UTC date-only item does not gain an appointment time', () => {
  const item = { starts_at: '2026-11-07T12:00:00Z', ends_at: '2026-11-07T12:00:00Z', appointment_time: null };
  assert.equal(api.dateInputValue(item.starts_at), '2026-11-07');
  assert.equal(api.scheduleAppointmentTimeLabel(item.appointment_time), '');
  assert.equal(api.scheduleDateRangeLabel('Nov 7, 2026', 'Nov 7, 2026', item), 'Nov 7, 2026');
  assert.equal(api.scheduleMessageDateText('Saturday, November 7, 2026', item), 'Saturday, November 7, 2026');
  const written = api.scheduleWriteTimes('2026-11-07', '2026-11-09', '');
  assert.deepEqual(written, {
    starts_at: '2026-11-07T12:00:00Z',
    ends_at: '2026-11-09T12:00:00Z',
    appointment_time: null
  });
});

test('an Eastern time round-trips, edits, and clears without changing the date', () => {
  assert.equal(api.scheduleAppointmentTimeValue('10:00'), '10:00');
  assert.equal(api.scheduleAppointmentTimeValue('10:00:00'), '10:00');
  assert.equal(api.scheduleAppointmentTimeStorage('10:00'), '10:00:00');
  assert.equal(api.scheduleAppointmentTimeLabel('10:00:00'), '10:00 AM ET');
  assert.equal(api.scheduleAppointmentTimeLabel('00:05:00'), '12:05 AM ET');
  assert.equal(api.scheduleAppointmentTimeLabel('15:30'), '3:30 PM ET');
  assert.equal(api.scheduleAppointmentTimeStorage(''), null);
  assert.equal(api.scheduleAppointmentTimeStorage('25:00'), null);

  const saved = api.scheduleWriteTimes('2026-11-07', '2026-11-07', '10:00');
  assert.equal(saved.starts_at, '2026-11-07T12:00:00Z');
  assert.equal(saved.appointment_time, '10:00:00');
  assert.equal(api.scheduleAppointmentTimeValue(saved.appointment_time), '10:00');

  const edited = api.scheduleWriteTimes('2026-11-07', '2026-11-07', '14:15');
  assert.equal(edited.starts_at, '2026-11-07T12:00:00Z');
  assert.equal(edited.appointment_time, '14:15:00');

  const cleared = api.scheduleWriteTimes('2026-11-07', '2026-11-07', '');
  assert.equal(cleared.appointment_time, null);
  assert.equal(cleared.starts_at, saved.starts_at);
});

test('Eastern wall-clock time does not shift across browser zones or DST', () => {
  for (const date of ['2026-01-15', '2026-03-08', '2026-07-15', '2026-11-01']) {
    const written = api.scheduleWriteTimes(date, date, '10:00');
    assert.equal(written.starts_at, `${date}T12:00:00Z`);
    assert.equal(written.appointment_time, '10:00:00');
    assert.equal(api.dateInputValue(written.starts_at), date);
    assert.equal(api.scheduleAppointmentTimeLabel(written.appointment_time), '10:00 AM ET');
    assert.equal(api.scheduleDateRangeLabel(date, date, { starts_at: written.starts_at, appointment_time: written.appointment_time }), `${date} · 10:00 AM ET`);
  }
});

test('moving a day keeps the Eastern time and the noon-UTC date span', () => {
  const item = {
    starts_at: '2026-03-07T12:00:00Z',
    ends_at: '2026-03-09T12:00:00Z',
    appointment_time: '10:00:00'
  };
  const moved = api.scheduleMovePayload(item, '2026-03-08');
  assert.equal(api.calendarDaysBetween('2026-03-07', '2026-03-09'), 2);
  assert.deepEqual(moved, {
    p_start: '2026-03-08T12:00:00Z',
    p_end: '2026-03-10T12:00:00Z',
    appointment_time: '10:00:00'
  });
  const stored = { ...item, starts_at: moved.p_start, ends_at: moved.p_end };
  assert.equal(stored.appointment_time, '10:00:00');
  assert.equal(api.dateInputValue(stored.starts_at), '2026-03-08');
  assert.equal(api.scheduleAppointmentTimeLabel(stored.appointment_time), '10:00 AM ET');

  const moveSource = extractFunction(html, 'moveScheduleItemToDate');
  assert.match(moveSource, /p_start:moved\.p_start/);
  assert.match(moveSource, /p_end:moved\.p_end/);
  assert.doesNotMatch(moveSource, /appointment_time:moved\.appointment_time/);
});

test('schedule message text includes a time only when one is stored', () => {
  const linked = new Function(
    'lots',
    'subdivisions',
    'api',
    `const {dateInputValue,scheduleMessageDateText}=api;
     function linkedScheduleCanonicalName(name){return String(name||'');}
     function includedOptionsLinesForMessage(){return []}
     ${extractFunction(html, 'linkedScheduleMessageBody')}
     return linkedScheduleMessageBody;`
  )(
    [{ id: 'lot', lot_name: 'Lot 72', subdivision_id: 'sub', address: '1 Main' }],
    [{ id: 'sub', name: 'Goldfinch' }],
    api
  );
  const body = linked('lot', [
    { name: 'First Walk', starts_at: '2026-03-08T12:00:00Z', ends_at: '2026-03-08T12:00:00Z', appointment_time: '10:00:00' },
    { name: 'Prime', starts_at: '2026-03-09T12:00:00Z', ends_at: '2026-03-09T12:00:00Z', appointment_time: null }
  ], 'fallback');
  assert.match(body, /First Walk: .* at 10:00 AM ET/);
  assert.match(body, /Prime: /);
  assert.doesNotMatch(body.split('Prime:')[1], /AM ET|PM ET/);
  assert.equal(api.scheduleAlertDateWithTime('Nov 7, 2026', null), 'Nov 7, 2026');
  assert.equal(api.scheduleAlertDateWithTime('Nov 7, 2026', '10:00:00'), 'Nov 7, 2026 at 10:00 AM ET');
  assert.equal(linked('lot', [{ name: 'Only', starts_at: '2026-11-07T12:00:00Z' }], 'fallback body'), 'fallback body');
});
