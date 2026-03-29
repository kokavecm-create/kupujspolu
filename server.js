require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

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
  STRIPE_WEBHOOK_SECRET,
  SMTP_HOST,
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM = 'Kupujspolu.sk <info@kupujspolu.sk>',
  ADMIN_EMAIL = 'info@kupujspolu.sk'
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Chýba SUPABASE_URL alebo SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const stripe =
  STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.trim()
    ? new Stripe(STRIPE_SECRET_KEY)
    : null;

const mailerConfigured = Boolean(
  SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS
);

const transporter = mailerConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      requireTLS: Number(SMTP_PORT) === 587,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      tls: {
        servername: SMTP_HOST
      }
    })
  : null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCustomerName(order) {
  if (order.full_name && String(order.full_name).trim()) {
    return String(order.full_name).trim();
  }

  if (order.contact_person && String(order.contact_person).trim()) {
    return String(order.contact_person).trim();
  }

  if (order.company_name && String(order.company_name).trim()) {
    return String(order.company_name).trim();
  }

  return 'zákazník';
}

function getPlanNameFromFee(fee) {
  if (String(fee) === '399') return 'Garancia+';
  return 'Štandard';
}

function logSmtpConfig() {
  console.log('SMTP CONFIG CHECK:', {
    host: SMTP_HOST || '',
    port: SMTP_PORT || '',
    user: SMTP_USER || '',
    hasPass: Boolean(SMTP_PASS),
    mailFrom: MAIL_FROM || '',
    adminEmail: ADMIN_EMAIL || '',
    secure: Number(SMTP_PORT) === 465,
    requireTLS: Number(SMTP_PORT) === 587
  });
}

async function verifyMailer() {
  if (!transporter) {
    console.warn('SMTP verify skipped: transporter nie je nakonfigurovaný.');
    return false;
  }

  try {
    logSmtpConfig();
    await transporter.verify();
    console.log('SMTP VERIFY OK');
    return true;
  } catch (err) {
    console.error('SMTP VERIFY ERROR:', err);
    return false;
  }
}

async function sendAdminEmail(order) {
  if (!transporter) {
    console.warn('SMTP nie je nakonfigurované. Admin email sa neposlal.');
    return;
  }

  const customerName = getCustomerName(order);
  const planName = getPlanNameFromFee(order.fee);

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;padding:20px;">
      <h2 style="margin-top:0;">Nová zaplatená objednávka – kupujspolu.sk</h2>
      <p>Bola prijatá nová objednávka po úspešnej platbe cez Stripe.</p>

      <table style="border-collapse:collapse;width:100%;max-width:760px;">
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Upload ID</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.upload_id)}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Stav</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.status || 'paid')}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Plán</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(planName)} (${escapeHtml(order.fee)} €)</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Značka / model</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.znacka)} / ${escapeHtml(order.model)}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Požadovaná cena vozidla</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.cena)}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Typ kupujúceho</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.buyer_type)}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Meno / kontakt</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(customerName)}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Firma</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.company_name || '-')}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Email</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.email || '-')}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Telefón</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.telefon || '-')}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Adresa</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">
            ${escapeHtml(order.billing_address_street || '-')}<br>
            ${escapeHtml(order.billing_address_zip || '')} ${escapeHtml(order.billing_address_city || '')}
          </td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Poznámka</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.billing_note || '-')}</td>
        </tr>
        <tr>
          <td style="padding:10px;border:1px solid #d1d5db;"><strong>Súbor</strong></td>
          <td style="padding:10px;border:1px solid #d1d5db;">${escapeHtml(order.file_original_name || '-')}</td>
        </tr>
      </table>
    </div>
  `;

  console.log(`SEND ADMIN EMAIL START: ${order.upload_id}`);

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: ADMIN_EMAIL,
    subject: 'Nová objednávka – kupujspolu.sk',
    html
  });

  console.log('SEND ADMIN EMAIL OK:', {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response
  });
}

async function sendCustomerEmail(order) {
  if (!transporter) {
    console.warn('SMTP nie je nakonfigurované. Zákaznícky email sa neposlal.');
    return;
  }

  if (!order.email) {
    console.warn(`Objednávka ${order.upload_id} nemá email zákazníka.`);
    return;
  }

  const customerName = getCustomerName(order);
  const planName = getPlanNameFromFee(order.fee);

  const html = `
    <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;padding:30px 20px;">
        <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">
          <div style="background:#0f172a;padding:28px 32px;">
            <h1 style="margin:0;color:#ffffff;font-size:28px;">kupujspolu.sk</h1>
            <p style="margin:8px 0 0 0;color:#cbd5e1;font-size:15px;">
              Potvrdenie prijatia objednávky
            </p>
          </div>

          <div style="padding:32px;">
            <p style="margin-top:0;font-size:16px;">Dobrý deň ${escapeHtml(customerName)},</p>

            <p style="font-size:16px;line-height:1.7;">
              ďakujeme za vašu objednávku a dôveru. Vašu platbu sme úspešne prijali
              a váš dopyt je teraz zaradený do spracovania.
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;margin:24px 0;">
              <h2 style="margin:0 0 12px 0;font-size:18px;">Prehľad objednávky</h2>
              <p style="margin:6px 0;"><strong>Referenčné číslo:</strong> ${escapeHtml(order.upload_id)}</p>
              <p style="margin:6px 0;"><strong>Plán:</strong> ${escapeHtml(planName)}</p>
              <p style="margin:6px 0;"><strong>Popis dopytu:</strong> ${escapeHtml(order.znacka)} ${escapeHtml(order.model)}</p>
            </div>

            <h2 style="font-size:20px;margin:28px 0 12px;">Čo bude nasledovať?</h2>

            <ol style="padding-left:20px;line-height:1.8;font-size:16px;">
              <li>Skontrolujeme vaše zadané údaje a špecifikáciu dopytu.</li>
              <li>Anonymizovane oslovíme relevantných predajcov a partnerov.</li>
              <li>Zozbierame a porovnáme dostupné ponuky.</li>
              <li>Vyberieme pre vás najvýhodnejšie riešenie podľa zadaných parametrov.</li>
              <li>Výslednú ponuku vám doručíme emailom.</li>
            </ol>

            <p style="font-size:16px;line-height:1.7;">
              Ak bude potrebné doplniť akékoľvek údaje, budeme vás kontaktovať.
            </p>

            <p style="font-size:16px;line-height:1.7;">
              S pozdravom<br>
              <strong>Tím kupujspolu.sk</strong>
            </p>
          </div>

          <div style="background:#f8fafc;padding:18px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:13px;color:#64748b;">
              Toto je automatické potvrdenie prijatia objednávky po úspešnej úhrade.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;

  console.log(`SEND CUSTOMER EMAIL START: ${order.upload_id} -> ${order.email}`);

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to: order.email,
    subject: 'Potvrdenie prijatia objednávky – kupujspolu.sk',
    html
  });

  console.log('SEND CUSTOMER EMAIL OK:', {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response
  });
}

async function sendOrderEmails(uploadId) {
  const { data: order, error } = await supabase
    .from('uploads')
    .select('*')
    .eq('upload_id', uploadId)
    .single();

  if (error || !order) {
    console.error('Nepodarilo sa načítať objednávku pre email:', error);
    return;
  }

  try {
    console.log(`Odosielam admin email pre uploadId=${uploadId}`);
    await sendAdminEmail(order);
    console.log(`Admin email úspešne odoslaný pre uploadId=${uploadId}`);
  } catch (err) {
    console.error(`Chyba pri odosielaní admin emailu pre uploadId=${uploadId}:`, err);
  }

  try {
    console.log(`Odosielam zákaznícky email pre uploadId=${uploadId}`);
    await sendCustomerEmail(order);
    console.log(`Zákaznícky email úspešne odoslaný pre uploadId=${uploadId}`);
  } catch (err) {
    console.error(`Chyba pri odosielaní zákazníckeho emailu pre uploadId=${uploadId}:`, err);
  }
}

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

      console.log('Stripe webhook received:', event.type);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uploadId = session.metadata?.uploadId || null;
        const fee = session.metadata?.fee || '';

        if (uploadId) {
          const { data: existingOrder, error: fetchError } = await supabase
            .from('uploads')
            .select('*')
            .eq('upload_id', uploadId)
            .single();

          if (fetchError || !existingOrder) {
            console.error('Supabase fetch before paid update failed:', fetchError);
            return res.status(500).send('Nepodarilo sa načítať objednávku.');
          }

          const wasAlreadyPaid = existingOrder.status === 'paid';

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

          if (!wasAlreadyPaid) {
            await sendOrderEmails(uploadId);
          } else {
            console.log(`Objednávka ${uploadId} už bola paid, emaily znova neposielam.`);
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
    env: process.env.NODE_ENV || 'development',
    mailerConfigured: Boolean(mailerConfigured),
    smtpHost: SMTP_HOST || '',
    smtpPort: SMTP_PORT || ''
  });
});

app.get('/api/test-mailer', async (req, res) => {
  try {
    if (!transporter) {
      return res.status(500).json({
        ok: false,
        error: 'SMTP nie je nakonfigurované.'
      });
    }

    logSmtpConfig();

    await transporter.verify();

    return res.json({
      ok: true,
      message: 'SMTP verify prebehlo úspešne.'
    });
  } catch (error) {
    console.error('TEST MAILER ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'SMTP verify zlyhalo.'
    });
  }
});

app.get('/api/test-email', async (req, res) => {
  try {
    if (!transporter) {
      return res.status(500).json({
        ok: false,
        error: 'SMTP nie je nakonfigurované.'
      });
    }

    const testTo = req.query.to || ADMIN_EMAIL;

    console.log(`TEST EMAIL START -> ${testTo}`);
    logSmtpConfig();

    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to: testTo,
      subject: 'Test email – kupujspolu.sk',
      html: `
        <div style="font-family:Arial,sans-serif;padding:20px;">
          <h2>Test email z kupujspolu.sk</h2>
          <p>Ak čítaš tento email, SMTP funguje správne.</p>
          <p><strong>Čas odoslania:</strong> ${new Date().toISOString()}</p>
        </div>
      `
    });

    console.log('TEST EMAIL OK:', {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response
    });

    return res.json({
      ok: true,
      message: 'Test email bol odoslaný.',
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response
    });
  } catch (error) {
    console.error('TEST EMAIL ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Odoslanie test emailu zlyhalo.'
    });
  }
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

app.listen(PORT, async () => {
  console.log(`Server beží na ${BASE_URL}`);
  console.log(`Mailer configured: ${mailerConfigured ? 'áno' : 'nie'}`);

  if (mailerConfigured) {
    await verifyMailer();
  }
});