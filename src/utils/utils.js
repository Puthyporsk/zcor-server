import nodemailer from "nodemailer";

export async function sendPasswordResetEmail({ to, resetUrl }) {
  const subject = "Reset your password";

  const text = `You requested a password reset.\n\nReset your password here:\n${resetUrl}\n\nIf you didn’t request this, you can ignore this email.`;

  const html = `
    <div style="font-family:Arial,sans-serif; line-height:1.4">
      <h2>Reset your password</h2>
      <p>You requested a password reset.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block; padding:10px 14px; border-radius:8px; background:#214318; color:#fff; text-decoration:none; font-weight:700">
          Reset password
        </a>
      </p>
      <p style="font-size:12px; color:#666">
        If you didn’t request this, you can ignore this email.
      </p>
      <p style="font-size:12px; color:#666">
        Or copy and paste this link: <br/>
        <a href="${resetUrl}">${resetUrl}</a>
      </p>
    </div>
  `;

  await sendMail({ to, subject, text, html });
}

function makeTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, html, text }) {
  const transport = makeTransport();

  return transport.sendMail({
    to,
    subject,
    text,
    html,
  });
}
