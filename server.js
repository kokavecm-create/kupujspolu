require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Cesty
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'uploads.json');

// Vytvor priečinky/súbory ak neexistujú
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ uploads: [] }, null, 2), 'utf8');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// SMTP transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Nastavenie uploadu
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = Date.now() + '_' + safeName;
    cb(null, fileName);
  }
});

function fileFilter(req, file, cb) {
  const allowedTypes = [
    'application/pdf',
    'image/jpeg',
    'image/png'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Povolený je iba PDF, JPG alebo PNG súbor.'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    files: 1,
    fileSize: 10 * 1024 * 1024
  }
});

// Pomocné funkcie
function readUploads() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function saveUploads(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function formatStatus(status) {
  if (status === 'new') return 'Nová ponuka';
  if (status === 'pending_payment') return 'Čaká na platbu';
  if (status === 'paid') return 'Zaplatené';

  // staré statusy kvôli kompatibilite
  if (status === 'uploaded') return 'Nová ponuka';
  if (status === 'checkout_created') return 'Čaká na platbu';

  return status || 'Neznámy';
}

function formatBuyerType(type) {
  if (type === 'private') return 'Súkromná osoba';
  if (type === 'company') return 'Právnická osoba';
  return type || '';
}

function formatPlan(fee) {
  if (fee === '129' || fee === 129) return 'Štandard (129 €)';
  if (fee === '399' || fee === 399) return 'Garancia+ (399 €)';
  return '';
}

async function sendAdminEmail(uploadData) {
  const buyerBlock =
    uploadData.buyerType === 'private'
      ? `Meno a priezvisko: ${uploadData.fullName}`
      : `Firma: ${uploadData.companyName}
IČO: ${uploadData.ico}
DIČ: ${uploadData.dic}
IČ DPH: ${uploadData.icdph}
Kontaktná osoba: ${uploadData.contactPerson}`;

  const mailText = `Nová ponuka — kupujspolu.sk

Upload ID: ${uploadData.uploadId}
Dátum: ${uploadData.createdAt}
Status: ${formatStatus(uploadData.status)}

AUTO
Značka: ${uploadData.znacka}
Model: ${uploadData.model}
Cena: ${uploadData.cena} €

KUPUJÚCI
Typ: ${formatBuyerType(uploadData.buyerType)}

${buyerBlock}

Fakturačná adresa:
${uploadData.billingAddressStreet}
${uploadData.billingAddressCity}
${uploadData.billingAddressZip}

Email: ${uploadData.email}
Telefón: ${uploadData.telefon}
Poznámka: ${uploadData.billingNote}
`;

  return await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    subject: `Nová ponuka — kupujspolu.sk — ${uploadData.znacka} ${uploadData.model}`,
    text: mailText,
    attachments: [
      {
        filename: uploadData.fileOriginalName,
        path: uploadData.filePath
      }
    ]
  });
}

async function sendCustomerEmail(uploadData) {
  const customerName =
    uploadData.buyerType === 'private'
      ? (uploadData.fullName || 'zákazník')
      : (uploadData.contactPerson || uploadData.companyName || 'zákazník');

  const selectedPlan = formatPlan(uploadData.fee);

  const mailText = `Dobrý deň ${customerName},

ďakujeme, vašu ponuku a výber plánu sme úspešne zaevidovali v systéme kupujspolu.sk.

ZHRNUTIE
Upload ID: ${uploadData.uploadId}
Značka: ${uploadData.znacka}
Model: ${uploadData.model}
Cena z ponuky: ${uploadData.cena} €
Typ kupujúceho: ${formatBuyerType(uploadData.buyerType)}
Vybraný plán: ${selectedPlan || 'Neurčený'}

ČO SA DEJE ĎALEJ
1. Vašu ponuku evidujeme a pripravujeme na ďalšie spracovanie.
2. Po potvrdení úhrady bude ponuka anonymizovaná a zaradená do skupiny porovnateľných ponúk.
3. Po nazbieraní dostatočného počtu ponúk oslovíme dealerov a budeme vyjednávať lepšie podmienky pre skupinu.
4. Po vyhodnotení vám doručíme výsledok emailom — konkrétnu zľavu, ponuku alebo ďalšie inštrukcie.

Ak ste tento formulár neposlali vy, kontaktujte nás na:
${process.env.EMAIL_FROM}

S pozdravom
kupujspolu.sk
`;

  return await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: uploadData.email,
    subject: `Potvrdenie prijatia ponuky — kupujspolu.sk — ${uploadData.uploadId}`,
    text: mailText
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend funguje' });
});

// Upload formulára
app.post('/api/upload-offer', upload.single('offerFile'), (req, res) => {
  try {
    console.log('PRIŠIEL REQUEST NA /api/upload-offer');

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
      return res.status(400).json({
        error: 'Pri súkromnej osobe je povinné meno a priezvisko.'
      });
    }

    if (buyerType === 'company' && (!companyName || !ico || !contactPerson)) {
      return res.status(400).json({
        error: 'Pri firme sú povinné názov firmy, IČO a kontaktná osoba.'
      });
    }

    const uploadId = 'UPL-' + Date.now();
    const db = readUploads();

    const newUpload = {
      uploadId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      znacka,
      model,
      cena,
      buyerType,
      fullName: fullName || '',
      companyName: companyName || '',
      ico: ico || '',
      dic: dic || '',
      icdph: icdph || '',
      contactPerson: contactPerson || '',
      billingAddressStreet: billingAddressStreet || '',
      billingAddressCity: billingAddressCity || '',
      billingAddressZip: billingAddressZip || '',
      email,
      telefon: telefon || '',
      billingNote: billingNote || '',
      fileOriginalName: req.file.originalname,
      fileStoredName: req.file.filename,
      filePath: req.file.path,
      fee: '',
      status: 'new'
    };

    db.uploads.push(newUpload);
    saveUploads(db);

    console.log('Idem odosielať admin email na:', process.env.EMAIL_TO);

    sendAdminEmail(newUpload)
      .then((info) => {
        console.log('Admin email bol úspešne odoslaný.');
        console.log('Odpoveď mail servera (admin):', info.response);
      })
      .catch((err) => {
        console.error('Chyba pri odosielaní admin emailu:', err);
      });

    return res.json({
      ok: true,
      message: 'Ponuka bola úspešne uložená.',
      uploadId
    });
  } catch (error) {
    console.error('Chyba pri upload-offer:', error);
    return res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

// Create checkout / payment session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { fee, uploadId } = req.body;

    if (!fee || !uploadId) {
      return res.status(400).json({ error: 'Chýba fee alebo uploadId.' });
    }

    const db = readUploads();
    const found = db.uploads.find((item) => item.uploadId === uploadId);

    if (!found) {
      return res.status(404).json({ error: 'Upload nebol nájdený.' });
    }

    found.fee = fee;
    found.status = 'pending_payment';
    found.updatedAt = new Date().toISOString();
    saveUploads(db);

    console.log('Idem odosielať zákaznícky email na:', found.email);

    sendCustomerEmail(found)
      .then((info) => {
        console.log('Zákaznícky email bol úspešne odoslaný.');
        console.log('Odpoveď mail servera (customer):', info.response);
      })
      .catch((err) => {
        console.error('Chyba pri odosielaní zákazníckeho emailu:', err);
      });

    // TESTOVACÍ REŽIM
    if (process.env.PAYMENT_PROVIDER === 'test') {
      return res.json({
        ok: true,
        provider: 'test',
        url: `${process.env.BASE_URL}/success.html?uploadId=${encodeURIComponent(uploadId)}&fee=${encodeURIComponent(fee)}`
      });
    }

    // BUDÚCI GoPay REŽIM
    if (process.env.PAYMENT_PROVIDER === 'gopay') {
      return res.status(501).json({
        error: 'GoPay integrácia ešte nie je dokončená. Zatiaľ používaj PAYMENT_PROVIDER=test.'
      });
    }

    return res.status(400).json({
      error: 'Neplatné nastavenie PAYMENT_PROVIDER v .env'
    });
  } catch (error) {
    console.error('Chyba pri create-checkout-session:', error);
    return res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

// GoPay notify endpoint - pripravený
app.post('/api/gopay/notify', express.json(), (req, res) => {
  try {
    console.log('PRIŠLA GoPay NOTIFIKÁCIA');
    console.log(req.body);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Chyba pri GoPay notify:', error);
    return res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

// Test endpoint - ručné označenie paid
app.post('/api/test/mark-paid', (req, res) => {
  try {
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'Chýba uploadId.' });
    }

    const db = readUploads();
    const found = db.uploads.find((item) => item.uploadId === uploadId);

    if (!found) {
      return res.status(404).json({ error: 'Upload nebol nájdený.' });
    }

    found.status = 'paid';
    found.updatedAt = new Date().toISOString();
    saveUploads(db);

    return res.json({
      ok: true,
      message: 'Upload bol označený ako paid.',
      uploadId
    });
  } catch (error) {
    console.error('Chyba pri test mark-paid:', error);
    return res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

// Detail jedného uploadu podľa uploadId
app.get('/api/upload/:uploadId', (req, res) => {
  try {
    const db = readUploads();
    const found = db.uploads.find((item) => item.uploadId === req.params.uploadId);

    if (!found) {
      return res.status(404).json({ error: 'Upload nebol nájdený.' });
    }

    return res.json({
      ok: true,
      upload: {
        uploadId: found.uploadId,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt || '',
        znacka: found.znacka,
        model: found.model,
        cena: found.cena,
        buyerType: found.buyerType,
        email: found.email,
        status: found.status,
        fee: found.fee || ''
      }
    });
  } catch (error) {
    console.error('Chyba pri načítaní uploadu:', error);
    return res.status(500).json({ error: 'Interná chyba servera.' });
  }
});

// Zoznam uploadov - JSON
app.get('/api/uploads', (req, res) => {
  try {
    const db = readUploads();
    res.json(db);
  } catch (error) {
    res.status(500).json({ error: 'Nepodarilo sa načítať uploads.' });
  }
});

// Jednoduchý admin prehľad
app.get('/admin/uploads', (req, res) => {
  try {
    const db = readUploads();
    const items = [...db.uploads].reverse();

    const rows = items
      .map((item) => {
        const actionButton =
          item.status !== 'paid'
            ? `<button onclick="markPaid('${item.uploadId}')" style="margin-top:6px;padding:6px 10px;border:none;border-radius:8px;background:#22c55e;color:#fff;cursor:pointer;font-weight:700;">Označiť ako zaplatené</button>`
            : '';

        return `
          <tr>
            <td>${item.uploadId}</td>
            <td>${item.znacka || ''}</td>
            <td>${item.model || ''}</td>
            <td>${item.cena || ''} €</td>
            <td>${item.buyerType || ''}</td>
            <td>${item.email || ''}</td>
            <td>${item.fee ? item.fee + ' €' : '—'}</td>
            <td>
              ${formatStatus(item.status)}
              ${actionButton}
            </td>
            <td>${item.createdAt || ''}</td>
          </tr>
        `;
      })
      .join('');

    const html = `
      <!DOCTYPE html>
      <html lang="sk">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin uploads — kupujspolu.sk</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #0b1220;
            color: #f8fafc;
            margin: 0;
            padding: 2rem;
          }
          h1 {
            margin-bottom: 1.5rem;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: #111827;
            border-radius: 12px;
            overflow: hidden;
          }
          th, td {
            padding: 12px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            text-align: left;
            font-size: 14px;
            vertical-align: top;
          }
          th {
            background: #1f2937;
          }
          tr:hover td {
            background: rgba(255,255,255,0.03);
          }
          a {
            color: #60a5fa;
          }
          button:hover {
            opacity: 0.9;
          }
        </style>
      </head>
      <body>
        <h1>Admin prehľad ponúk</h1>
        <p><a href="/">← Späť na web</a></p>
        <table>
          <thead>
            <tr>
              <th>Upload ID</th>
              <th>Značka</th>
              <th>Model</th>
              <th>Cena</th>
              <th>Typ</th>
              <th>Email</th>
              <th>Plán</th>
              <th>Status</th>
              <th>Dátum</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="9">Zatiaľ žiadne ponuky.</td></tr>'}
          </tbody>
        </table>

        <script>
          async function markPaid(uploadId) {
            if (!confirm('Naozaj označiť ako zaplatené?')) return;

            try {
              const res = await fetch('/api/test/mark-paid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId })
              });

              const data = await res.json();

              if (data.ok) {
                alert('Označené ako zaplatené');
                location.reload();
              } else {
                alert('Chyba: ' + data.error);
              }
            } catch (err) {
              alert('Chyba spojenia');
            }
          }
        </script>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('Chyba pri admin prehľade:', error);
    res.status(500).send('Chyba pri načítaní admin prehľadu.');
  }
});

// Chyby z multeru
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'Súbor je príliš veľký. Maximum je 10 MB.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Je povolená iba jedna príloha.'
      });
    }
  }

  if (err) {
    return res.status(400).json({ error: err.message });
  }

  next();
});

// Spustenie servera
app.listen(PORT, () => {
  console.log(`Server beží na: http://localhost:${PORT}`);
});