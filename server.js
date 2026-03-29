const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail({ to, subject, html }) {
  try {
    const response = await resend.emails.send({
      from: 'Kupujspolu.sk <info@kupujspolu.sk>',
      to,
      subject,
      html
    });

    console.log('EMAIL SENT:', response);
  } catch (error) {
    console.error('EMAIL ERROR:', error);
  }
}

// ADMIN EMAIL
async function sendAdminEmail(order) {
  await sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: 'Nová objednávka – kupujspolu.sk',
    html: `
      <h2>Nová objednávka</h2>
      <p><b>ID:</b> ${order.upload_id}</p>
      <p><b>Email:</b> ${order.email}</p>
      <p><b>Značka:</b> ${order.znacka}</p>
      <p><b>Model:</b> ${order.model}</p>
      <p><b>Cena:</b> ${order.cena}</p>
    `
  });
}

// CUSTOMER EMAIL
async function sendCustomerEmail(order) {
  await sendEmail({
    to: order.email,
    subject: 'Potvrdenie objednávky – kupujspolu.sk',
    html: `
      <h2>Ďakujeme za objednávku</h2>
      <p>Vaša objednávka bola prijatá.</p>
      <p><b>ID:</b> ${order.upload_id}</p>
    `
  });
}

module.exports = {
  sendAdminEmail,
  sendCustomerEmail
};