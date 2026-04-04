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
  ADMIN_SECRET
} = process.env;

// 🔐 ADMIN CHECK
function checkAdmin(req) {
  const secret = req.headers['x-admin-secret'];
  return secret && secret === ADMIN_SECRET;
}

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
    currency: 'EUR'
  }).format(num);
}

// ======================= STRIPE WEBHOOK =======================

app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      if (!stripe) return res.status(500).send('Stripe nie je nakonfigurovaný.');

      const signature = req.headers['stripe-signature'];

      let event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uploadId = session.metadata?.uploadId;

        await supabase
          .from('uploads')
          .update({ status: 'paid' })
          .eq('upload_id', uploadId);
      }

      return res.json({ received: true });
    } catch (error) {
      console.error(error);
      return res.status(500).send('Webhook error');
    }
  }
);

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ======================= ADMIN PROTECTED =======================

app.get('/api/uploads', async (req, res) => {
  if (!checkAdmin(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { data } = await supabase.from('uploads').select('*');
  res.json(data);
});

app.get('/api/upload/:id', async (req, res) => {
  if (!checkAdmin(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { data } = await supabase
    .from('uploads')
    .select('*')
    .eq('upload_id', req.params.id)
    .single();

  res.json(data);
});

app.get('/api/test-email', async (req, res) => {
  if (!checkAdmin(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.json({ ok: true });
});

// ======================= UPLOAD =======================

const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload-offer', upload.single('offerFile'), async (req, res) => {
  const uploadId = makeUploadId();

  const { error } = await supabase.from('uploads').insert({
    upload_id: uploadId,
    email: req.body.email,
    status: 'pending_payment'
  });

  if (error) return res.status(500).json({ error: 'DB error' });

  res.json({ uploadId });
});

// ======================= PAYMENT =======================

app.post('/api/create-checkout-session', async (req, res) => {
  const { uploadId } = req.body;

  await supabase
    .from('uploads')
    .update({ status: 'paid' })
    .eq('upload_id', uploadId);

  res.json({
    url: `${BASE_URL}/success.html?uploadId=${uploadId}`
  });
});

// ======================= START =======================

app.listen(PORT, () => {
  console.log(`Server beží na ${BASE_URL}`);
});