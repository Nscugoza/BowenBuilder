// Vercel serverless function: /api/crew-photo
// Required Vercel environment variable:
// SUPABASE_SERVICE_ROLE_KEY = your CURRENT Supabase project's service_role key

const SUPABASE_URL = 'https://oztefiymckpyxiewgxtc.supabase.co';

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured in Vercel.'
    );
  }

  return {
    apikey: key,
    Authorization: `Bearer ${key}`
  };
}

async function rest(path) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        ...supabaseHeaders(),
        Accept: 'application/json'
      }
    }
  );

  if (!r.ok) {
    throw new Error(
      `Supabase lookup failed (${r.status}).`
    );
  }

  return r.json();
}

function storagePath(path) {
  return String(path || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

export default async function handler(req, res) {
  try {

    if (req.method !== 'GET') {
      res.status(405).send('Method not allowed');
      return;
    }

    const token = String(req.query.token || '');
    const path = String(req.query.path || '');

    if (
      !token ||
      !path ||
      path.includes('..')
    ) {
      res.status(400).send('Invalid request');
      return;
    }

    // Validate Crew QR token -> lot.

    const lots = await rest(
      `lots?select=id&crew_access_token=eq.${encodeURIComponent(token)}&limit=1`
    );

    if (!lots.length) {
      res.status(404).send(
        'Invalid or reset Crew QR'
      );
      return;
    }

    const lotId = lots[0].id;


    // Validate storage path -> punchout photo row.

    const photos = await rest(
      `punchout_photos?select=punchout_item_id,storage_path&storage_path=eq.${encodeURIComponent(path)}&limit=1`
    );

    if (!photos.length) {
      res.status(404).send(
        'Photo not found'
      );
      return;
    }


    // Validate that the photo belongs to a punchout
    // item for this exact lot.

    const itemId =
      photos[0].punchout_item_id;

    const items = await rest(
      `punchout_items?select=id,lot_id,completed&id=eq.${encodeURIComponent(itemId)}&lot_id=eq.${encodeURIComponent(lotId)}&limit=1`
    );

    if (
      !items.length ||
      items[0].completed === true
    ) {
      res.status(403).send(
        'Photo is not available for this Crew QR'
      );
      return;
    }


    // Retrieve the private photo from Supabase.
    //
    // The service-role key stays inside Vercel.
    // It is NEVER sent to the crew member's browser.

    const image = await fetch(
      `${SUPABASE_URL}/storage/v1/object/authenticated/punchout-photos/${storagePath(path)}`,
      {
        headers: supabaseHeaders()
      }
    );


    if (!image.ok) {
      res.status(image.status).send(
        'Photo could not be loaded'
      );
      return;
    }


    const contentType =
      image.headers.get('content-type') ||
      'image/jpeg';

    const bytes = Buffer.from(
      await image.arrayBuffer()
    );


    res.setHeader(
      'Content-Type',
      contentType
    );

    res.setHeader(
      'Cache-Control',
      'private, max-age=300'
    );

    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    );


    res.status(200).send(bytes);

  } catch (err) {

    console.error(
      'crew-photo error',
      err
    );

    res.status(500).send(
      err?.message ||
      'Crew photo error'
    );
  }
}
