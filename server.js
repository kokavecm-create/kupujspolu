require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = 'offer-files',
  PAYMENT_PROVIDER = 'test',
  BASE_URL = `http://localhost:${PORT}`,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Chýba SUPABASE_URL alebo SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const stripe =
  STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.trim()
    ? new Stripe(STRIPE_SECRET_KEY)
    : null;

/**
 * Stripe webhook musí ísť pred express.json(),
 * inak sa rozbije verifikácia podpisu.
 */
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(500).send('Stripe nie je nakonfigurovaný.');
      }

      if (!STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send('Chýba STRIPE_WEBHOOK_SECRET.');
      }

      const signature = req.headers['stripe-signature'];
      if (!signature) {
        return res.status(400).send('Chýba Stripe signature.');
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('Stripe webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uploadId = session.metadata?.uploadId || null;
        const fee = session.metadata?.fee || '';

        if (uploadId) {
          const { error } = await supabase
            .from('uploads')
            .update({
              status: 'paid',
              fee,
              updated_at: new Date().toISOString()
            })
            .eq('upload_id', uploadId);

          if (error) {
            console.error('Supabase update after checkout.session.completed:', error);
            return res.status(500).send('Nepodarilo sa aktualizovať stav objednávky.');
          }
        }
      }

      if (event.type === 'checkout.session.async_payment_failed') {
        const session = event.data.object;
        const uploadId = session.metadata?.uploadId || null;
        const fee = session.metadata?.fee || '';

        if (uploadId) {
          const { error } = await supabase
            .from('uploads')
            .update({
              status: 'payment_failed',
              fee,
              updated_at: new Date().toISOString()
            })
            .eq('upload_id', uploadId);

          if (error) {
            console.error('Supabase update after async_payment_failed:', error);
            return res.status(500).send('Nepodarilo sa aktualizovať stav objednávky.');
          }
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error('Stripe webhook fatal error:', error);
      return res.status(500).send('Webhook processing error.');
    }
  }
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png'
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error('Povolené formáty sú iba PDF, JPG a PNG.'));
    }

    cb(null, true);
  }
});

function sanitizeFilename(name) {
  return String(name || 'subor')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_');
}

function makeUploadId() {
  return `UPL-${Date.now()}`;
}

function mapDbRow(row) {
  if (!row) return null;

  return {
    uploadId: row.upload_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    znacka: row.znacka || '',
    model: row.model || '',
    cena: row.cena != null ? String(row.cena) : '',
    buyerType: row.buyer_type || '',
    fullName: row.full_name || '',
    companyName: row.company_name || '',
    ico: row.ico || '',
    dic: row.dic || '',
    icdph: row.icdph || '',
    contactPerson: row.contact_person || '',
    billingAddressStreet: row.billing_address_street || '',
    billingAddressCity: row.billing_address_city || '',
    billingAddressZip: row.billing_address_zip || '',
    email: row.email || '',
    telefon: row.telefon || '',
    billingNote: row.billing_note || '',
    fileOriginalName: row.file_original_name || '',
    fileStoragePath: row.file_storage_path || '',
    fee: row.fee || '',
    status: row.status || ''
  };
}

function priceLabelFromFee(fee) {
  if (String(fee) === '399') {
    return {
      amount: 39900,
      label: 'Kupujspolu.sk — Garancia+',
      description: 'Digitálna služba skupinového vyjednávania — Garancia+'
    };
  }

  return {
    amount: 12900,
    label: 'Kupujspolu.sk — Štandard',
    description: 'Digitálna služba skupinového vyjednávania — Štandard'
  };
}

async function updateUploadStatus(uploadId, patch) {
  const payload = {
    ...patch,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('uploads')
    .update(payload)
    .eq('upload_id', uploadId);

  if (error) {
    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: PAYMENT_PROVIDER,
    env: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/uploads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('uploads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({
      uploads: (data || []).map(mapDbRow)
    });
  } catch (error) {
    console.error('GET /api/uploads error:', error);
    res.status(500).json({ error: 'Nepodarilo sa načítať zoznam uploadov.' });
  }
});

app.get('/api/upload/:id', async (req, res) => {
  try {
    const uploadId = req.params.id;

    const { data, error } = await supabase
      .from('uploads')
      .select('*')
      .eq('upload_id', uploadId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Upload nebol nájdený.' });
    }

    return res.json(mapDbRow(data));
  } catch (error) {
    console.error('GET /api/upload/:id error:', error);
    res.status(500).json({ error: 'Chyba servera pri načítaní detailu.' });
  }
});

app.post('/api/upload-offer', upload.single('offerFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nebola nahratá žiadna príloha.' });
    }

    const {
      znacka,
      model,
      cena,
      buyerType,
      fullName,
      companyName,
      ico,
      dic,
      icdph,
      contactPerson,
      billingAddressStreet,
      billingAddressCity,
      billingAddressZip,
      email,
      telefon,
      billingNote
    } = req.body;

    if (!znacka || !model || !cena || !buyerType || !email) {
      return res.status(400).json({ error: 'Chýbajú povinné údaje.' });
    }

    if (buyerType === 'private' && !fullName) {
      return res.status(400).json({ error: 'Pri súkromnej osobe je povinné meno a priezvisko.' });
    }

    if (buyerType === 'company' && (!companyName || !ico || !contactPerson)) {
      return res.status(400).json({ error: 'Pri firme sú povinné názov firmy, IČO a kontaktná osoba.' });
    }

    const uploadId = makeUploadId();
    const safeFileName = sanitizeFilename(req.file.originalname);
    const storagePath = `${uploadId}/${Date.now()}_${safeFileName}`;

    const { error: storageError } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (storageError) {
      console.error('Supabase storage error:', storageError);
      return res.status(500).json({ error: 'Nepodarilo sa uložiť prílohu.' });
    }

    const now = new Date().toISOString();

    const insertPayload = {
      upload_id: uploadId,
      created_at: now,
      updated_at: now,
      znacka,
      model,
      cena: Number(cena),
      buyer_type: buyerType,
      full_name: fullName || null,
      company_name: companyName || null,
      ico: ico || null,
      dic: dic || null,
      icdph: icdph || null,
      contact_person: contactPerson || null,
      billing_address_street: billingAddressStreet || null,
      billing_address_city: billingAddressCity || null,
      billing_address_zip: billingAddressZip || null,
      email,
      telefon: telefon || null,
      billing_note: billingNote || null,
      file_original_name: req.file.originalname,
      file_storage_path: storagePath,
      fee: '',
      status: 'pending_payment'
    };

    const { data, error } = await supabase
      .from('uploads')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      console.error('Supabase insert error:', error);

      await supabase.storage.from(SUPABASE_BUCKET).remove([storagePath]);

      return res.status(500).json({ error: 'Nepodarilo sa uložiť údaje o ponuke.' });
    }

    res.json({
      ok: true,
      uploadId: data.upload_id
    });
  } catch (error) {
    console.error('POST /api/upload-offer error:', error);
    res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { fee, uploadId } = req.body;

    if (!uploadId || !fee) {
      return res.status(400).json({ error: 'Chýba uploadId alebo fee.' });
    }

    const normalizedFee = String(fee);
    if (!['129', '399'].includes(normalizedFee)) {
      return res.status(400).json({ error: 'Neplatná hodnota fee.' });
    }

    const { data: existingUpload, error: fetchError } = await supabase
      .from('uploads')
      .select('*')
      .eq('upload_id', uploadId)
      .single();

    if (fetchError || !existingUpload) {
      return res.status(404).json({ error: 'Upload nebol nájdený.' });
    }

    if (PAYMENT_PROVIDER === 'test') {
      await updateUploadStatus(uploadId, {
        fee: normalizedFee,
        status: 'pending_payment'
      });

      return res.json({
        ok: true,
        url: `${BASE_URL}/success.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(normalizedFee)}`
      });
    }

    if (PAYMENT_PROVIDER === 'stripe') {
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe nie je nakonfigurovaný.' });
      }

      const pricing = priceLabelFromFee(normalizedFee);

      await updateUploadStatus(uploadId, {
        fee: normalizedFee,
        status: 'checkout_created'
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${BASE_URL}/success.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(normalizedFee)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/upload.html?plan=${encodeURIComponent(normalizedFee)}`,
        customer_email: existingUpload.email || undefined,
        metadata: {
          uploadId,
          fee: normalizedFee
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: pricing.amount,
              product_data: {
                name: pricing.label,
                description: pricing.description
              }
            }
          }
        ]
      });

      return res.json({
        ok: true,
        url: session.url
      });
    }

    if (PAYMENT_PROVIDER === 'gopay') {
      return res.status(501).json({ error: 'GoPay ešte nie je nakonfigurovaný.' });
    }

    return res.status(400).json({ error: 'Neplatné nastavenie PAYMENT_PROVIDER v .env' });
  } catch (error) {
    console.error('POST /api/create-checkout-session error:', error);
    res.status(500).json({ error: 'Nepodarilo sa vytvoriť checkout session.' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint neexistuje.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled middleware error:', err);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Súbor je príliš veľký. Maximum je 10 MB.' });
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Je povolená iba jedna príloha.' });
    }
  }

  return res.status(400).json({ error: err.message || 'Nastala chyba pri spracovaní požiadavky.' });
});

app.listen(PORT, () => {
  console.log(`Server beží na ${BASE_URL}`);
});