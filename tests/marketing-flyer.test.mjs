import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  let i = source.indexOf('{', start);
  let depth = 0;
  let state = 'code';
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; i++; continue; }
      if (c === '"') { state = 'double'; i++; continue; }
      if (c === '`') { state = 'template'; i++; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
    } else if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
    } else if (state === 'single' || state === 'double') {
      if (c === '\\') { i += 2; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) state = 'code';
    } else if (state === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') state = 'code';
    }
    i += 1;
  }
  throw new Error(`unclosed ${name}`);
}

const start = html.indexOf('function crewAccessUrl(');
const end = html.indexOf('function marketingFlyerQrDataUrl(');
assert.ok(start !== -1 && end > start);
const api = new Function(
  `${html.slice(start, end)}
   return {crewAccessUrl,marketingFlyerImageSrc,marketingFlyerModel,marketingFlyerHtml};`
)();

function lot(overrides = {}) {
  return {
    id: 'lot-1',
    lot_name: 'Lot 12',
    address: '10 Oak St, Town, ST 00000',
    permit_number: 'PERMIT-12',
    plan_name: 'Plan A',
    color_rendering_url: PNG,
    crew_access_token: 'crew-token-12',
    subdivision_id: 'sub-1',
    ...overrides
  };
}

test('each lot uses its own data and existing crew token', () => {
  const first = api.marketingFlyerModel(lot(), 'Goldfinch Farms', 'https://builder.test', '/');
  const second = api.marketingFlyerModel(lot({
    id: 'lot-2',
    lot_name: 'Lot 4',
    address: '4 Pine Rd',
    permit_number: 'PERMIT-4',
    plan_name: 'Plan B',
    crew_access_token: 'crew-token-4'
  }), 'Other Farm', 'https://builder.test', '/app');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.title, 'LOT 12');
  assert.equal(second.title, 'LOT 4');
  assert.equal(new URL(first.qrText).searchParams.get('crew'), 'crew-token-12');
  assert.equal(new URL(second.qrText).searchParams.get('crew'), 'crew-token-4');
  assert.equal(new URL(first.qrText).origin, 'https://builder.test');
  assert.equal(new URL(second.qrText).pathname, '/app');
  const page = api.marketingFlyerHtml(first, PNG, {autoPrint: false});
  assert.match(page, /LOT 12/);
  assert.match(page, /10 Oak St/);
  assert.match(page, /PERMIT-12/);
  assert.match(page, /Plan A/);
  assert.match(page, /GOLDFINCH FARMS/);
  assert.doesNotMatch(page, /crew-token-4|LOT 4|PERMIT-4/);
  assert.doesNotMatch(html, /1024 GOLDFINCH|RESBLDG0626|FINCH 3/);
});

test('a missing crew token does not invent a QR or reset one', () => {
  const model = api.marketingFlyerModel(lot({crew_access_token: '  '}), 'Farm', 'https://builder.test', '/');
  assert.equal(model.ok, false);
  assert.match(model.error, /will not generate or reset/);
  assert.equal(model.qrText, undefined);
  const flyer = extractFunction(html, 'printMarketingFlyer');
  assert.doesNotMatch(flyer, /bowenbuilder_reset_crew_token/);
  const builder = extractFunction(html, 'marketingFlyerModel');
  assert.doesNotMatch(builder, /bowenbuilder_reset_crew_token/);
});

test('dynamic text and unsafe rendering URLs cannot inject markup', () => {
  const model = api.marketingFlyerModel(lot({
    lot_name: '<script>alert(1)</script>',
    address: '<img src=x onerror=alert(1)>',
    permit_number: '"><script>',
    plan_name: "O'Hara & Sons",
    color_rendering_url: 'javascript:alert(1)',
    crew_access_token: 'token&next=1'
  }), '<b>Farm</b>', 'https://builder.test', '/');
  assert.equal(model.rendering, '');
  assert.equal(new URL(model.qrText).searchParams.get('crew'), 'token&next=1');
  const page = api.marketingFlyerHtml(model, PNG, {autoPrint: false});
  assert.match(page, /&lt;SCRIPT&gt;ALERT\(1\)&lt;\/SCRIPT&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /O&#39;Hara &amp; Sons/);
  assert.match(page, /&lt;B&gt;FARM&lt;\/B&gt;/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(page, /javascript:alert/);
  assert.match(page, /Rendering not available/);
  assert.match(page, /id="flyerQr"/);
});

test('missing address, permit, plan, and rendering stay printable without fake values', () => {
  const model = api.marketingFlyerModel(lot({
    address: '',
    permit_number: null,
    plan_name: '',
    color_rendering_url: ''
  }), '', 'https://builder.test', '/');
  const page = api.marketingFlyerHtml(model, PNG, {autoPrint: false});
  assert.match(page, /Address not added/);
  assert.match(page, /Permit not added/);
  assert.match(page, /Plan not added/);
  assert.match(page, /COMMUNITY NOT ADDED/);
  assert.match(page, /Rendering not available/);
  assert.doesNotMatch(page, /id="flyerRendering"/);
});

test('a flyer without a real QR image does not auto-print', () => {
  const model = api.marketingFlyerModel(lot(), 'Farm', 'https://builder.test', '/');
  const page = api.marketingFlyerHtml(model, 'not-an-image', {autoPrint: true});
  assert.match(page, /Crew QR unavailable/);
  assert.doesNotMatch(page, /id="flyerQr"/);
});
