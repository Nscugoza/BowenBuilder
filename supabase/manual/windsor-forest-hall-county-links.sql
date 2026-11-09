-- Owner step for Windsor Forest / Hall County. Not a migration.
-- Do not apply this file from the 6.3 pull request, and do not reapply
-- 20261107220011 (already recorded as history version 20261107223821).
--
-- The app already opens Hall County Accela for a subdivision named
-- Windsor Forest, and keeps every other subdivision on the Barrow portal.
-- Optional later: add subdivisions.county_portal_key (text, nullable) and
-- set it to 'hall' or 'barrow' when a name match is not enough. The page
-- reads that column only when it is present.
--
-- Lot links are lots.permit_url. Confirm the subdivision name and the two
-- lot_name values, then run the update. Edit Lot → Permit URL is the same
-- change in the app. Public record numbers seen on those pages, for the
-- permit number field only if it is still empty: lot 53 GRNEW26-0330,
-- lot 87 GRNEW26-0374. This statement does not write permit_number.

-- update public.subdivisions
--    set county_portal_key = 'hall'
--  where name ilike '%windsor%forest%'
--    and county_portal_key is null;

update public.lots
   set permit_url = case
         when lot_name ~* '^(lot[[:space:]]*)?53$'
           then 'https://aca-prod.accela.com/HALLCO/Cap/CapDetail.aspx?Module=Gainesville&TabName=Gainesville&capID1=REC26&capID2=00000&capID3=009QD&agencyCode=HALLCO&IsToShowInspection='
         when lot_name ~* '^(lot[[:space:]]*)?87$'
           then 'https://aca-prod.accela.com/HALLCO/Cap/CapDetail.aspx?Module=Gainesville&TabName=Gainesville&capID1=REC26&capID2=00000&capID3=00AR1&agencyCode=HALLCO&IsToShowInspection='
       end,
       county = 'Hall County, GA'
 where subdivision_id in (
         select id from public.subdivisions where name ilike '%windsor%forest%'
       )
   and lot_name ~* '^(lot[[:space:]]*)?(53|87)$';
