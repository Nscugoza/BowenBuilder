import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function loadPortal() {
  const start = html.indexOf('const COUNTY_PORTALS=');
  const end = html.indexOf('function renderSubdivisionInspectionMenu()');
  assert.ok(start !== -1 && end > start, 'county portal helpers were not found');
  const source = html.slice(start, end);
  return new Function(`${source}
    return { COUNTY_PORTALS, countyPortalForSubdivision, parseHallCountyAccelaRecord };
  `)();
}

const { COUNTY_PORTALS, countyPortalForSubdivision, parseHallCountyAccelaRecord } = loadPortal();

const BARROW_URL = 'https://barrowcountyga-energovweb.tylerhost.net/apps/selfservice';
const HALL_URL = 'https://aca-prod.accela.com/HALLCO/Default.aspx?Module=Gainesville';

function accelaRecord({ permitNumber, expirationDate }) {
  return `
    <span id="ctl00_PlaceHolderMain_lblPermitNumber">${permitNumber}</span>
    <span id="ctl00_PlaceHolderMain_lblPermitType">G - Residential New Construction Permit</span>
    <span id="ctl00_PlaceHolderMain_lblRecordStatus">Inspection Phase</span>
    <span id="ctl00_PlaceHolderMain_lblExpirtionDate">${expirationDate}</span>
    <span id="ctl00_PlaceHolderMain_InspectionList_gvListCompleted_ctl01_lblEmptyCompleted">There are no completed inspections on this record.</span>
    <span id="ctl00_PlaceHolderMain_InspectionList_lblEmptyUpcoming">You have not added any inspections.</span>
  `;
}

test('Barrow stays the portal for existing subdivisions', () => {
  assert.equal(COUNTY_PORTALS.barrow.url, BARROW_URL);
  for (const name of ['', 'Goldfinch', 'Barrow County', 'Reserve at Barrow']) {
    const portal = countyPortalForSubdivision({ name });
    assert.equal(portal.key, 'barrow', name || '(blank)');
    assert.equal(portal.url, BARROW_URL);
    assert.equal(portal.countyName, 'Barrow County, GA');
  }
  assert.match(html, new RegExp(`id="subdivisionCountyPortalLink"[^>]*href="${BARROW_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /l\.permit_url/);
  assert.match(html, /Automatic inspection sync is not enabled/);
});

test('Windsor Forest uses Hall County Accela and an explicit key overrides the name', () => {
  const portal = countyPortalForSubdivision({ name: 'Windsor Forest' });
  assert.equal(portal.key, 'hall');
  assert.equal(portal.url, HALL_URL);
  assert.equal(portal.agencyCode, 'HALLCO');
  assert.equal(portal.module, 'Gainesville');
  assert.equal(portal.countyName, 'Hall County, GA');
  assert.equal(countyPortalForSubdivision({ name: 'Windsor   Forest Phase 2' }).key, 'hall');
  assert.equal(countyPortalForSubdivision({ name: 'Barrow Estates', county_portal_key: 'hall' }).key, 'hall');
  assert.equal(countyPortalForSubdivision({ name: 'Windsor Forest', county_portal_key: 'barrow' }).key, 'barrow');
  assert.equal(countyPortalForSubdivision({ name: 'Windsor Forest', county_portal_key: 'unknown' }).key, 'hall');
});

test('Hall County Accela pages for both Windsor Forest records parse, and bad pages fail closed', () => {
  const lot53 = parseHallCountyAccelaRecord(accelaRecord({
    permitNumber: 'GRNEW26-0330',
    expirationDate: '05/05/2027'
  }));
  assert.equal(lot53.ok, true);
  assert.equal(lot53.permitNumber, 'GRNEW26-0330');
  assert.equal(lot53.recordStatus, 'Inspection Phase');
  assert.equal(lot53.expirationDate, '05/05/2027');
  assert.match(lot53.inspectionNote, /no completed inspections/i);
  assert.match(lot53.inspectionNote, /not added any inspections/i);

  const lot87 = parseHallCountyAccelaRecord(accelaRecord({
    permitNumber: 'GRNEW26-0374',
    expirationDate: '05/06/2027'
  }));
  assert.equal(lot87.ok, true);
  assert.equal(lot87.permitNumber, 'GRNEW26-0374');
  assert.equal(lot87.permitType, 'G - Residential New Construction Permit');
  assert.equal(lot87.expirationDate, '05/06/2027');

  for (const htmlText of ['', '   ', '<html><title>Sign in</title></html>', '<span id="ctl00_PlaceHolderMain_lblPermitNumber"></span>']) {
    const failed = parseHallCountyAccelaRecord(htmlText);
    assert.equal(failed.ok, false);
    assert.equal(failed.permitNumber, '');
    assert.ok(failed.error);
  }
});
