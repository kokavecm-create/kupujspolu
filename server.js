require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { Resend } = require('resend');

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
  RESEND_API_KEY,
  EMAIL_FROM = 'Kupujspolu.sk <info@kupujspolu.sk>',
  ADMIN_EMAIL = 'info@kupujspolu.sk',
  ADMIN_SECRET = ''
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Chýba SUPABASE_URL alebo SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const stripe =
  STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.trim()
    ? new Stripe(STRIPE_SECRET_KEY)
    : null;

const resend =
  RESEND_API_KEY && RESEND_API_KEY.trim()
    ? new Resend(RESEND_API_KEY)
    : null;

function isResendConfigured() {
  return Boolean(resend && EMAIL_FROM && ADMIN_EMAIL);
}

function sanitizeFilename(name) {
  return String(name || 'subor')
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_');
}

function makeUploadId() {
  return `UPL-${Date.now()}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrencyEur(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('sk-SK', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2
  }).format(num);
}

function planMetaFromFee(fee) {
  if (String(fee) === '399') {
    return {
      fee: '399',
      amount: 39900,
      label: 'Kupujspolu.sk — Garancia+',
      shortLabel: 'Garancia+ (399 EUR)',
      description: 'Digitálna služba skupinového vyjednávania — Garancia+',
      guaranteeText: 'Garantovaná minimálna úspora 1 400 EUR oproti predloženej ponuke.'
    };
  }

  return {
    fee: '129',
    amount: 12900,
    label: 'Kupujspolu.sk — Štandard',
    shortLabel: 'Štandard (129 EUR)',
    description: 'Digitálna služba skupinového vyjednávania — Štandard',
    guaranteeText: 'Garantovaná minimálna úspora 700 EUR oproti predloženej ponuke.'
  };
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
    status: row.status || '',
    invoiceStatus: row.invoice_status || 'nevystavena',
    invoiceIssuedAt: row.invoice_issued_at || null,
    invoiceNumber: row.invoice_number || ''
  };
}

function customerDisplayName(row) {
  if (row.buyer_type === 'company') {
    if (row.contact_person) return row.contact_person;
    if (row.company_name) return row.company_name;
    return 'zákazník';
  }

  return row.full_name || 'zákazník';
}

function customerEntityLabel(row) {
  if (row.buyer_type === 'company') {
    return row.company_name || 'Firma / podnikateľ';
  }
  return row.full_name || 'Súkromná osoba';
}

function checkAdmin(req) {
  const secret = req.headers['x-admin-secret'];
  return Boolean(ADMIN_SECRET) && Boolean(secret) && secret === ADMIN_SECRET;
}

function requireAdmin(req, res, next) {
  if (!checkAdmin(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  return next();
}

function buildAdminEmailHtml(row) {
  const plan = planMetaFromFee(row.fee);
  const billingAddress = [
    row.billing_address_street,
    row.billing_address_city,
    row.billing_address_zip
  ]
    .filter(Boolean)
    .join(', ');

  return `
  <div style="margin:0;padding:0;background:#f4f7fb;">
    <div style="max-width:760px;margin:0 auto;padding:24px 12px;">
      <div style="background:#0b1220;border-radius:22px;overflow:hidden;border:1px solid #1f2a44;">
        <div style="padding:28px 28px 18px;background:linear-gradient(135deg,#08101c 0%,#10213f 100%);">
          <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:#12331f;color:#dcfce7;border:1px solid #1f6b3a;font:700 12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;">
            Nová platená objednávka
          </div>
          <h1 style="margin:18px 0 8px;font:700 42px Arial,sans-serif;line-height:1.02;color:#ffffff;">
            Prišla nová objednávka
          </h1>
          <p style="margin:0;color:#cbd5e1;font:400 15px Arial,sans-serif;line-height:1.7;">
            Platba bola úspešne potvrdená a prípad bol označený ako paid.
            Ponuka bola zaradená do spracovania pre skupinové vyjednávanie.
          </p>
        </div>

        <div style="padding:24px 28px;background:#0f172a;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Upload ID</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.upload_id)}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Plán</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(plan.shortLabel)}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Značka / model</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.znacka)} / ${escapeHtml(row.model)}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Cena z ponuky</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(formatCurrencyEur(row.cena))}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Typ zákazníka</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${row.buyer_type === 'company' ? 'Firma / podnikateľ' : 'Súkromná osoba'}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Meno / firma</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(customerEntityLabel(row))}</td>
            </tr>
            ${row.contact_person ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Kontaktná osoba</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.contact_person)}</td>
            </tr>` : ''}
            ${row.ico ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">IČO</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.ico)}</td>
            </tr>` : ''}
            ${row.dic ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">DIČ</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.dic)}</td>
            </tr>` : ''}
            ${row.icdph ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">IČ DPH</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.icdph)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">E-mail</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.email)}</td>
            </tr>
            ${row.telefon ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Telefón</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.telefon)}</td>
            </tr>` : ''}
            ${billingAddress ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Fakturačná adresa</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(billingAddress)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Súbor</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.file_original_name || '—')}</td>
            </tr>
            ${row.billing_note ? `
            <tr>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#091327;color:#ffffff;font:700 14px Arial,sans-serif;">Poznámka</td>
              <td style="padding:12px 14px;border:1px solid #23314f;background:#0b162b;color:#cbd5e1;font:400 14px Arial,sans-serif;">${escapeHtml(row.billing_note)}</td>
            </tr>` : ''}
          </table>

          <div style="margin-top:18px;padding:16px 18px;background:#0b162b;border:1px solid #23314f;border-radius:16px;">
            <div style="color:#ffffff;font:700 14px Arial,sans-serif;margin-bottom:6px;">Čo ďalej</div>
            <div style="color:#cbd5e1;font:400 14px Arial,sans-serif;line-height:1.7;">
              Skontroluj použiteľnosť ponuky a zaraď prípad podľa značky alebo porovnateľnej konfigurácie do spracovania.
              Následne prebieha skupinové vyjednávanie s relevantnými predajcami.
              Faktúra zákazníkovi má odísť spravidla do 2–3 pracovných dní.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildCustomerEmailHtml(row) {
  const plan = planMetaFromFee(row.fee);
  const displayName = customerDisplayName(row);

  return `
  <div style="margin:0;padding:0;background:#f4f7fb;">
    <div style="max-width:760px;margin:0 auto;padding:24px 12px;">
      <div style="background:#0b1220;border-radius:22px;overflow:hidden;border:1px solid #1f2a44;">
        <div style="padding:28px 28px 18px;background:linear-gradient(135deg,#08101c 0%,#10213f 100%);">
          <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:#12331f;color:#dcfce7;border:1px solid #1f6b3a;font:700 12px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;">
            Platba potvrdená
          </div>
          <h1 style="margin:18px 0 8px;font:700 42px Arial,sans-serif;line-height:1.02;color:#ffffff;">
            Ďakujeme, ${escapeHtml(displayName)}
          </h1>
          <p style="margin:0;color:#cbd5e1;font:400 15px Arial,sans-serif;line-height:1.7;">
            Tvoja objednávka digitálnej služby bola úspešne prijatá.
            Tvoja ponuka na nové vozidlo bola zaradená do spracovania pre skupinové vyjednávanie.
          </p>
        </div>

        <div style="padding:24px 28px;background:#0f172a;">
          <div style="margin:0 0 16px;padding:16px 18px;background:#0b162b;border:1px solid #23314f;border-radius:16px;">
            <div style="color:#ffffff;font:700 15px Arial,sans-serif;margin-bottom:8px;">Prehľad prípadu</div>
            <div style="color:#cbd5e1;font:400 14px Arial,sans-serif;line-height:1.8;">
              <div><strong style="color:#ffffff;">Upload ID:</strong> ${escapeHtml(row.upload_id)}</div>
              <div><strong style="color:#ffffff;">Značka / model:</strong> ${escapeHtml(row.znacka)} / ${escapeHtml(row.model)}</div>
              <div><strong style="color:#ffffff;">Cena z ponuky:</strong> ${escapeHtml(formatCurrencyEur(row.cena))}</div>
              <div><strong style="color:#ffffff;">Vybraný plán:</strong> ${escapeHtml(plan.shortLabel)}</div>
              <div><strong style="color:#ffffff;">Stav:</strong> PAID</div>
            </div>
          </div>

          <div style="margin:0 0 16px;padding:16px 18px;background:#10213f;border:1px solid #24457b;border-radius:16px;">
            <div style="color:#ffffff;font:700 15px Arial,sans-serif;margin-bottom:8px;">Ako funguje tvoj prípad</div>
            <div style="color:#dbeafe;font:400 14px Arial,sans-serif;line-height:1.8;">
              Tvoja ponuka bude spojená s ďalšími relevantnými dopytmi na rovnakú značku alebo porovnateľnú konfiguráciu vozidla.
              Cieľom je vytvoriť silnejšiu vyjednávaciu pozíciu voči dealerom, než má jeden zákazník sám.
            </div>
          </div>

          <div style="margin:0 0 16px;padding:16px 18px;background:#0b162b;border:1px solid #23314f;border-radius:16px;">
            <div style="color:#ffffff;font:700 15px Arial,sans-serif;margin-bottom:10px;">Čo sa bude diať ďalej</div>
            <ol style="margin:0;padding-left:18px;color:#cbd5e1;font:400 14px Arial,sans-serif;line-height:1.8;">
              <li>Skontrolujeme, či je nahraná ponuka použiteľná a či ide o ponuku na nové auto od autorizovaného dealera alebo z oficiálneho konfigurátora.</li>
              <li>Tvoj prípad zaradíme medzi dopyty na rovnakú značku alebo porovnateľnú konfiguráciu a pripravíme ho na anonymizované porovnanie.</li>
              <li>Po vytvorení relevantnej skupiny prebieha skupinové vyjednávanie s predajcami s cieľom dosiahnuť lepší obchodný výsledok.</li>
              <li>Faktúru za službu zasielame spravidla do 2–3 pracovných dní na email uvedený v objednávke.</li>
              <li>Výsledok ti doručíme elektronicky podľa zvoleného plánu a obchodných podmienok.</li>
            </ol>
          </div>

          <div style="margin:0 0 16px;padding:16px 18px;background:#10213f;border:1px solid #24457b;border-radius:16px;">
            <div style="color:#ffffff;font:700 15px Arial,sans-serif;margin-bottom:8px;">Tvoj plán</div>
            <div style="color:#dbeafe;font:400 14px Arial,sans-serif;line-height:1.8;">
              ${escapeHtml(plan.guaranteeText)}
            </div>
          </div>

          <div style="color:#cbd5e1;font:400 14px Arial,sans-serif;line-height:1.8;">
            Ak budeme potrebovať doplniť údaje alebo spresniť konfiguráciu, budeme ťa kontaktovať emailom.
            V prípade otázok nám môžeš napísať na <a href="mailto:info@kupujspolu.sk" style="color:#93c5fd;">info@kupujspolu.sk</a>.
          </div>

          <div style="margin-top:18px;padding-top:18px;border-top:1px solid #23314f;color:#94a3b8;font:400 12px Arial,sans-serif;line-height:1.8;">
            Tento email je informačný. Vozidlo nekupuješ od kupujspolu.sk.
            Kupuješ digitálnu službu spracovania ponuky, zaradenia do systému a skupinového vyjednávania.
          </div>
        </div>
      </div>
    </div>
  </div>
  `;
}

async function getStoredAttachment(row) {
  if (!row || !row.file_storage_path || !row.file_original_name) {
    return null;
  }

  try {
    const { data, error } = await supabase
      .storage
      .from(SUPABASE_BUCKET)
      .download(row.file_storage_path);

    if (error || !data) {
      console.error('Nepodarilo sa stiahnuť prílohu zo Supabase:', error);
      return null;
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      filename: sanitizeFilename(row.file_original_name),
      content: buffer.toString('base64')
    };
  } catch (error) {
    console.error('getStoredAttachment error:', error);
    return null;
  }
}

async function sendAdminEmail(row) {
  if (!isResendConfigured()) {
    console.warn('Resend nie je nakonfigurovaný, admin email sa neposiela.');
    return;
  }

  const attachment = await getStoredAttachment(row);
  const payload = {
    from: EMAIL_FROM,
    to: [ADMIN_EMAIL],
    subject: `Nová platená objednávka — ${row.upload_id} — ${row.znacka} ${row.model}`,
    html: buildAdminEmailHtml(row)
  };

  if (attachment) {
    payload.attachments = [attachment];
  }

  const result = await resend.emails.send(payload);
  if (result.error) {
    throw new Error(`Resend admin email error: ${result.error.message || 'unknown error'}`);
  }
}

async function sendCustomerEmail(row) {
  if (!isResendConfigured()) {
    console.warn('Resend nie je nakonfigurovaný, zákaznícky email sa neposiela.');
    return;
  }

  if (!row.email) {
    console.warn('Chýba zákaznícky email, potvrdenie sa neposiela.');
    return;
  }

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: [row.email],
    subject: `Potvrdenie objednávky — ${row.upload_id}`,
    html: buildCustomerEmailHtml(row)
  });

  if (result.error) {
    throw new Error(`Resend customer email error: ${result.error.message || 'unknown error'}`);
  }
}

async function sendPaymentEmailsForUpload(uploadId) {
  const { data: row, error } = await supabase
    .from('uploads')
    .select('*')
    .eq('upload_id', uploadId)
    .single();

  if (error || !row) {
    throw new Error('Nepodarilo sa načítať údaje uploadu pre odoslanie emailov.');
  }

  await sendAdminEmail(row);
  await sendCustomerEmail(row);
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
          const { data: existingRow, error: existingError } = await supabase
            .from('uploads')
            .select('*')
            .eq('upload_id', uploadId)
            .single();

          if (existingError || !existingRow) {
            console.error('Webhook upload fetch error:', existingError);
            return res.status(404).send('Upload nebol nájdený.');
          }

          if (existingRow.status !== 'paid') {
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

            try {
              await sendPaymentEmailsForUpload(uploadId);
            } catch (mailError) {
              console.error('Odoslanie emailov po platbe zlyhalo:', mailError);
            }
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    provider: PAYMENT_PROVIDER,
    env: process.env.NODE_ENV || 'development',
    resendConfigured: isResendConfigured()
  });
});

app.get('/api/uploads', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('uploads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    res.json({
      uploads: (data || []).map(mapDbRow)
    });
  } catch (error) {
    console.error('GET /api/uploads error:', error);
    res.status(500).json({ error: 'Nepodarilo sa načítať zoznam uploadov.' });
  }
});

app.get('/api/upload/:id', requireAdmin, async (req, res) => {
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

app.post('/api/admin/invoice', requireAdmin, async (req, res) => {
  try {
    const {
      uploadId,
      invoiceStatus,
      invoiceNumber,
      invoiceIssuedAt
    } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'Chýba uploadId.' });
    }

    const normalizedStatus =
      invoiceStatus === 'vystavena' ? 'vystavena' : 'nevystavena';

    const patch = {
      invoice_status: normalizedStatus,
      invoice_number: invoiceNumber ? String(invoiceNumber).trim() : null,
      invoice_issued_at:
        normalizedStatus === 'vystavena'
          ? (invoiceIssuedAt || new Date().toISOString())
          : null,
      updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('uploads')
      .update(patch)
      .eq('upload_id', uploadId)
      .select('*')
      .single();

    if (error || !data) {
      console.error('POST /api/admin/invoice error:', error);
      return res.status(500).json({ error: 'Nepodarilo sa uložiť stav faktúry.' });
    }

    return res.json({
      ok: true,
      upload: mapDbRow(data)
    });
  } catch (error) {
    console.error('POST /api/admin/invoice fatal error:', error);
    return res.status(500).json({ error: 'Chyba servera pri ukladaní faktúry.' });
  }
});

app.post('/api/checkout-cancel', async (req, res) => {
  try {
    const { uploadId, fee } = req.body || {};

    if (!uploadId) {
      return res.status(400).json({ ok: false, error: 'Chýba uploadId.' });
    }

    const { data: existingRow, error: fetchError } = await supabase
      .from('uploads')
      .select('*')
      .eq('upload_id', uploadId)
      .single();

    if (fetchError || !existingRow) {
      return res.status(404).json({ ok: false, error: 'Upload nebol nájdený.' });
    }

    if (existingRow.status === 'paid') {
      return res.json({ ok: true, skipped: true, status: 'paid' });
    }

    if (existingRow.status === 'payment_failed') {
      return res.json({ ok: true, skipped: true, status: 'payment_failed' });
    }

    const { error } = await supabase
      .from('uploads')
      .update({
        status: 'canceled',
        fee: fee || existingRow.fee || '',
        updated_at: new Date().toISOString()
      })
      .eq('upload_id', uploadId);

    if (error) {
      console.error('POST /api/checkout-cancel error:', error);
      return res.status(500).json({ ok: false, error: 'Nepodarilo sa uložiť cancel status.' });
    }

    return res.json({ ok: true, status: 'canceled' });
  } catch (error) {
    console.error('POST /api/checkout-cancel fatal error:', error);
    return res.status(500).json({ ok: false, error: 'Chyba servera pri ukladaní cancel statusu.' });
  }
});

app.get('/api/test-email', requireAdmin, async (req, res) => {
  try {
    if (!isResendConfigured()) {
      return res.status(500).json({
        ok: false,
        error: 'Resend nie je nakonfigurovaný.'
      });
    }

    const to = req.query.to ? String(req.query.to).trim() : ADMIN_EMAIL;

    const result = await resend.emails.send({
      from: EMAIL_FROM,
      to: [to],
      subject: 'Test email — kupujspolu.sk',
      html: `
        <div style="font-family:Arial,sans-serif;background:#f4f7fb;padding:24px;">
          <div style="max-width:640px;margin:0 auto;background:#0f172a;border:1px solid #23314f;border-radius:18px;padding:24px;">
            <h1 style="margin:0 0 12px;color:#fff;font-size:30px;">Test email z kupujspolu.sk</h1>
            <p style="margin:0 0 10px;color:#cbd5e1;line-height:1.7;">
              Ak čítaš tento email, Resend funguje správne.
            </p>
            <p style="margin:0;color:#94a3b8;line-height:1.7;">
              Čas odoslania: ${escapeHtml(new Date().toISOString())}
            </p>
          </div>
        </div>
      `
    });

    if (result.error) {
      return res.status(500).json({
        ok: false,
        error: result.error.message || 'Nepodarilo sa odoslať test email.'
      });
    }

    res.json({
      ok: true,
      result
    });
  } catch (error) {
    console.error('GET /api/test-email error:', error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Nepodarilo sa odoslať test email.'
    });
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
      billingNote,
      fee
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
      fee: fee || '',
      status: 'pending_payment',
      invoice_status: 'nevystavena',
      invoice_issued_at: null,
      invoice_number: null
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
        status: 'paid'
      });

      try {
        await sendPaymentEmailsForUpload(uploadId);
      } catch (mailError) {
        console.error('Odoslanie emailov v test režime zlyhalo:', mailError);
      }

      return res.json({
        ok: true,
        url: `${BASE_URL}/success.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(normalizedFee)}`
      });
    }

    if (PAYMENT_PROVIDER === 'stripe') {
      if (!stripe) {
        return res.status(500).json({ error: 'Stripe nie je nakonfigurovaný.' });
      }

      const pricing = planMetaFromFee(normalizedFee);

      await updateUploadStatus(uploadId, {
        fee: normalizedFee,
        status: 'checkout_created'
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${BASE_URL}/success.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(normalizedFee)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/cancel.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(normalizedFee)}&plan=${encodeURIComponent(normalizedFee)}`,
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