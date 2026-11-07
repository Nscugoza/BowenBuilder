-- Optional Eastern wall-clock time for schedule items.
-- Null means the existing date-only item. Do not infer a time from starts_at.
-- Apply this before deploying the 6.0 page. Then reload the API schema cache.
-- This file does not change row level security policies.

alter table public.schedule_items
  add column if not exists appointment_time time without time zone;

comment on column public.schedule_items.appointment_time is
  'Optional America/New_York wall-clock time (HH:MM:SS). Null means date-only. Never derived from starts_at.';

-- Existing table-level SELECT, INSERT, and UPDATE grants already cover new columns.

create or replace function public.bowenbuilder_update_schedule_item(p_item_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare v_item public.schedule_items%rowtype; v_subdivision uuid; v_lot uuid;
begin
 if auth.uid() is null then raise exception 'Sign in required'; end if;
 select l.subdivision_id into v_subdivision from public.schedule_items si join public.lots l on l.id=si.lot_id where si.id=p_item_id;
 if v_subdivision is null then raise exception 'Schedule item not found'; end if;
 v_lot:=coalesce(nullif(p_payload->>'lot_id','')::uuid,(select lot_id from public.schedule_items where id=p_item_id));
 if not public.bowenbuilder_can_edit_subdivision(v_subdivision) or not exists(select 1 from public.lots l where l.id=v_lot and public.bowenbuilder_can_edit_subdivision(l.subdivision_id)) then raise exception 'No permission to edit this schedule item or destination lot'; end if;
 update public.schedule_items set
 lot_id=v_lot,
 item_type=coalesce(p_payload->>'item_type',item_type),
 name=coalesce(p_payload->>'name',name),
 status=coalesce((p_payload->>'status')::public.schedule_status,status),
 crew=coalesce(p_payload->>'crew',crew),
 starts_at=coalesce((p_payload->>'starts_at')::timestamptz,starts_at),
 ends_at=coalesce((p_payload->>'ends_at')::timestamptz,ends_at),
 location=coalesce(p_payload->>'location',location),
 inspection_status=coalesce((p_payload->>'inspection_status')::public.inspection_status,inspection_status),
 notes=coalesce(p_payload->>'notes',notes),
 appointment_time=case
  when p_payload ? 'appointment_time' then nullif(btrim(p_payload->>'appointment_time'),'')::time
  else appointment_time
 end,
 updated_at=now()
 where id=p_item_id returning * into v_item;
 if not found then raise exception 'Schedule item could not be updated'; end if;
 return to_jsonb(v_item);
end $function$;

create or replace function public.bowenbuilder_portal_schedule()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare v_uid uuid:=auth.uid();v_portal_user public.portal_users%rowtype;
begin
 if v_uid is null then raise exception 'Portal sign in required'; end if;
 select pu.* into v_portal_user from public.portal_users pu join public.vendor_companies vc on vc.id=pu.company_id and vc.active=true where pu.user_id=v_uid and pu.active=true limit 1;
 if v_portal_user.id is null then raise exception 'Active Portal access required'; end if;
 return jsonb_build_object(
 'items',coalesce((select jsonb_agg(jsonb_build_object(
 'id',si.id,'lot_id',si.lot_id,'subdivision_id',l.subdivision_id,'name',si.name,
 'status',si.status::text,'starts_at',si.starts_at,'ends_at',si.ends_at,'appointment_time',si.appointment_time,
 'notes',si.notes,'lot_name',l.lot_name,'address',l.address,'included_options',l.included_options,'subdivision_name',s.name,
 'media',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'storage_path',m.storage_path,'mime_type',m.mime_type,'file_name',m.file_name) order by m.created_at) from public.bowen_schedule_media m where m.schedule_item_id=si.id),'[]'::jsonb)
 ) order by si.starts_at,s.name,l.lot_name,si.name)
 from public.schedule_items si join public.lots l on l.id=si.lot_id and l.active=true
 join public.subdivisions s on s.id=l.subdivision_id and s.active=true
 join public.portal_company_subdivision_access a on a.company_id=v_portal_user.company_id and a.subdivision_id=l.subdivision_id and a.can_view=true
 join public.portal_company_schedule_visibility v on v.company_id=v_portal_user.company_id and lower(btrim(v.schedule_name))=lower(btrim(si.name))),'[]'::jsonb),
 'visibility',coalesce((select jsonb_agg(v.schedule_name order by v.schedule_name) from public.portal_company_schedule_visibility v where v.company_id=v_portal_user.company_id),'[]'::jsonb),
 'generated_at',now());
end $function$;

create or replace function public.bowenbuilder_crew_lot(p_token text)
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
      select jsonb_build_object(
        'subdivision', s.name,

        'lot', jsonb_build_object(
          'id', l.id,
          'lot_name', l.lot_name,
          'address', l.address,
          'permit_number', l.permit_number,
          'plan_name', l.plan_name,
          'county', l.county,
          'included_options', l.included_options,
          'permit_url', l.permit_url,
          'rendering_signed_url', l.color_rendering_url,
          'deco_url', l.deco_url,
          'hlp_url', l.hlp_url,
          'lgp_url', l.lgp_url,
          'crew_plan_link', l.crew_plan_link,
          'crew_plan_link_label', l.crew_plan_link_label
        ),

        'schedule', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', si.id,
              'name', si.name,
              'starts_at', si.starts_at,
              'ends_at', si.ends_at,
              'appointment_time', si.appointment_time,
              'status', si.status,
              'crew', si.crew
            )
            order by si.starts_at, si.name
          )
          from public.schedule_items si
          where si.lot_id = l.id
            and (
              si.status is null
              or si.status <> 'complete'::schedule_status
            )
        ), '[]'::jsonb),

        'punchout', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', p.id,
              'description', p.description,
              'photos', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', ph.id,
                    'storage_path', ph.storage_path
                  )
                  order by ph.created_at
                )
                from public.punchout_photos ph
                where ph.punchout_item_id = p.id
              ), '[]'::jsonb)
            )
            order by p.created_at desc
          )
          from public.punchout_items p
          where p.lot_id = l.id
            and coalesce(p.completed,false) = false
        ), '[]'::jsonb)

      )
      from public.lots l
      left join public.subdivisions s
        on s.id = l.subdivision_id
      where l.crew_access_token = p_token
      limit 1;
    $function$;

create or replace function portal_alerts_private.emit(item schedule_items, event_kind text, previous_item schedule_items default null::schedule_items)
returns void
language plpgsql
set search_path to ''
as $function$
    declare
      l record;
      ev uuid:=gen_random_uuid();
    begin
      select
        lot.*,
        s.name as subdivision_name
      into l
      from public.lots lot
      join public.subdivisions s
        on s.id=lot.subdivision_id
       and s.active
      where lot.id=item.lot_id
        and lot.active;

      if not found then return; end if;

      insert into portal_alerts_private.notifications(
        event_id,
        rule_id,
        company_id,
        portal_user_id,
        subdivision_id,
        schedule_id,
        kind,
        details,
        email_state
      )
      select
        ev,
        r.id,
        r.company_id,
        u.id,
        l.subdivision_id,
        item.id,
        event_kind,
        jsonb_build_object(
          'work',item.name,
          'lot_id',l.id,
          'lot',l.lot_name,
          'address',coalesce(l.address,''),
          'subdivision',l.subdivision_name,
          'included_options',coalesce(l.included_options,''),
          'start',item.starts_at,
          'end',item.ends_at,
          'appointment_time',item.appointment_time,
          'previous_start',previous_item.starts_at,
          'previous_end',previous_item.ends_at,
          'previous_appointment_time',previous_item.appointment_time
        ),
        case when r.email_enabled then 'pending' else 'off' end
      from portal_alerts_private.rules r
      join portal_alerts_private.recipients rr
        on rr.rule_id=r.id
      join public.portal_users u
        on u.id=rr.portal_user_id
       and u.active
       and u.company_id=r.company_id
      join public.vendor_companies c
        on c.id=r.company_id
       and c.active
      join public.portal_company_subdivision_access a
        on a.company_id=r.company_id
       and a.subdivision_id=l.subdivision_id
       and a.can_view
      where r.enabled
        and lower(btrim(r.schedule_name))=lower(btrim(item.name))
      on conflict(event_id,portal_user_id) do nothing;
    end;
    $function$;

notify pgrst, 'reload schema';
