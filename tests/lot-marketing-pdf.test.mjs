import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const MARKETING_FLYER_MAX_BYTES');
const end = html.indexOf('function marketingFlyerStatusMessage');
assert.ok(start !== -1 && end > start);
const api = new Function(
  `${html.slice(start, end)}
   return {marketingFlyerSafeName,marketingFlyerPdfError,marketingFlyerPdfBytes,marketingFlyerStoragePath,marketingFlyersForLot,storeMarketingFlyer,printStoredMarketingFlyer,MARKETING_FLYER_MAX_BYTES};`
)();

function pdfFile(name, bytes, size = bytes.length, type = 'application/pdf') {
  return {
    name,
    type,
    size,
    slice() {
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
  };
}

const pdfHead = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

test('only a real PDF name, type, size, and header is accepted', () => {
  assert.equal(api.marketingFlyerPdfError(pdfFile('walk.pdf', pdfHead, 1200)), '');
  assert.match(api.marketingFlyerPdfError(pdfFile('photo.png', pdfHead, 1200, 'image/png')), /PDF/);
  assert.match(api.marketingFlyerPdfError(pdfFile('flyer.pdf', pdfHead, 0)), /empty/);
  assert.match(api.marketingFlyerPdfError(pdfFile('flyer.pdf', pdfHead, api.MARKETING_FLYER_MAX_BYTES + 1)), /50 MB/);
  assert.equal(api.marketingFlyerPdfBytes(pdfHead), true);
  assert.equal(api.marketingFlyerPdfBytes(new Uint8Array([1, 2, 3, 4])), false);
  assert.equal(api.marketingFlyerSafeName('../Lot 12 flyer.pdf'), 'Lot_12_flyer.pdf');
});

test('uploads stay on the chosen lot and a failed save removes only the new file', async () => {
  const calls = { uploads: [], removed: [], inserts: [] };
  const lotA = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const lotB = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const file = pdfFile('Finished flyer.pdf', pdfHead, 2048);
  const saved = await api.storeMarketingFlyer({
    lot: lotA,
    file,
    canEdit: true,
    userId: 'user-1',
    newId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    upload: async (path) => { calls.uploads.push(path); return { ok: true }; },
    remove: async (path) => { calls.removed.push(path); },
    insertRow: async (row) => { calls.inserts.push(row); return { ok: true, row }; }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.row.lot_id, lotA.id);
  assert.equal(saved.path, api.marketingFlyerStoragePath(lotA.id, saved.row.id));
  assert.ok(saved.path.startsWith(`${lotA.id}/`));
  assert.equal(saved.path.includes(lotB.id), false);
  assert.deepEqual(calls.removed, []);

  const failed = await api.storeMarketingFlyer({
    lot: lotB,
    file,
    canEdit: true,
    userId: 'user-1',
    newId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    upload: async (path) => { calls.uploads.push(path); return { ok: true }; },
    remove: async (path) => { calls.removed.push(path); },
    insertRow: async () => ({ ok: false, error: 'permission denied' })
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.removed, true);
  assert.deepEqual(calls.removed, [api.marketingFlyerStoragePath(lotB.id, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')]);
  assert.equal(calls.removed.some(path => path.startsWith(lotA.id)), false);

  const denied = await api.storeMarketingFlyer({
    lot: lotA,
    file,
    canEdit: false,
    upload: async () => { throw new Error('should not upload'); },
    remove: async () => {},
    insertRow: async () => { throw new Error('should not insert'); },
    newId: () => 'nope'
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /permission/);
  assert.equal(api.marketingFlyersForLot([
    { lot_id: lotA.id, file_name: 'a.pdf' },
    { lot_id: lotB.id, file_name: 'b.pdf' }
  ], lotA.id).map(row => row.file_name).join(), 'a.pdf');
});

test('print opens the stored PDF and falls back when the browser blocks printing', async () => {
  const row = { storage_path: 'lot-a/marketing-flyer/id.pdf', file_name: 'Finished.pdf' };
  const blocked = await api.printStoredMarketingFlyer(row, {
    signedUrl: async (path) => `https://files.test/${path}`,
    openWindow: () => null,
    printWindow: () => { throw new Error('should not print'); }
  });
  assert.equal(blocked.reason, 'popup-blocked');
  assert.equal(blocked.url, 'https://files.test/lot-a/marketing-flyer/id.pdf');

  const fallback = await api.printStoredMarketingFlyer(row, {
    signedUrl: async (path) => `https://files.test/${path}`,
    openWindow: (url) => ({ url }),
    printWindow: () => { throw new Error('cross-origin'); }
  });
  assert.equal(fallback.reason, 'print-fallback');
  assert.equal(fallback.printed, false);
  assert.match(fallback.url, /\.pdf$/);

  const printed = await api.printStoredMarketingFlyer(row, {
    signedUrl: async (path) => `https://files.test/${path}`,
    openWindow: (url) => ({ url }),
    printWindow: (popup) => { popup.printed = true; }
  });
  assert.equal(printed.ok, true);
  assert.equal(printed.printed, true);
  assert.doesNotMatch(html, /function marketingFlyerHtml|printMarketingFlyer\(/);
  assert.doesNotMatch(extractPrint(), /bowenbuilder_reset_crew_token|document\.write/);
});

function extractPrint() {
  const at = html.indexOf('async function printLotMarketingFlyer');
  return html.slice(at, html.indexOf('let crewQrCurrentUrl', at));
}
