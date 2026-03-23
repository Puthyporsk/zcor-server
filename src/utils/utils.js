import nodemailer from "nodemailer";

export async function sendInvitationEmail({ to, inviteUrl, inviterName }) {
  const subject = "You've been invited to ZCOR";
  const text = `${inviterName} has invited you to join ZCOR.\n\nCreate your account here:\n${inviteUrl}\n\nThis link expires in 7 days.`;
  const html = `
    <div style="font-family:Arial,sans-serif; line-height:1.4">
      <h2>You've been invited to ZCOR</h2>
      <p>${inviterName} has invited you to join the team on ZCOR.</p>
      <p>
        <a href="${inviteUrl}" style="display:inline-block; padding:10px 14px; border-radius:8px; background:#214318; color:#fff; text-decoration:none; font-weight:700">
          Create your account
        </a>
      </p>
      <p style="font-size:12px; color:#666">
        This link expires in 7 days. If you didn't expect this invitation, you can ignore this email.
      </p>
      <p style="font-size:12px; color:#666">
        Or copy and paste this link: <br/>
        <a href="${inviteUrl}">${inviteUrl}</a>
      </p>
    </div>
  `;
  await sendMail({ to, subject, text, html });
}

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

export async function sendInviteAcceptedEmail({ to, inviteeName, dashboardUrl }) {
  const subject = `${inviteeName} has joined ZCOR`;
  const text = `${inviteeName} has accepted your invitation and created their account on ZCOR.\n\nView your dashboard:\n${dashboardUrl}`;
  const html = `
    <div style="font-family:Arial,sans-serif; line-height:1.4">
      <h2>${inviteeName} has joined ZCOR</h2>
      <p>${inviteeName} has accepted your invitation and created their account.</p>
      <p>
        <a href="${dashboardUrl}" style="display:inline-block; padding:10px 14px; border-radius:8px; background:#214318; color:#fff; text-decoration:none; font-weight:700">
          Go to Dashboard
        </a>
      </p>
      <p style="font-size:12px; color:#666">
        Or copy and paste this link: <br/>
        <a href="${dashboardUrl}">${dashboardUrl}</a>
      </p>
    </div>
  `;
  await sendMail({ to, subject, text, html });
}

function makeTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, html, text }) {
  const transport = makeTransport();
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
  const from = `ZCOR <${fromAddr}>`;

  return transport.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}
