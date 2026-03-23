import nodemailer from "nodemailer";

export async function sendInvitationEmail({ to, inviteUrl, inviterName }) {
  const subject = "You've been invited to join ZCOR";
  const text = `${inviterName} has invited you to join their team on ZCOR.\n\nCreate your account here:\n${inviteUrl}\n\nThis link expires in 7 days. If you didn't expect this invitation, you can safely ignore this email.`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="margin:0; padding:0; background-color:#f4f7f6; font-family:'Segoe UI',Arial,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6; padding:40px 20px;">
        <tr><td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08);">

            <!-- Header -->
            <tr>
              <td style="background-color:#1a3a2e; padding:32px 40px; text-align:center;">
                <h1 style="margin:0; color:#ffffff; font-size:28px; font-weight:700; letter-spacing:1px;">ZCOR</h1>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:40px 40px 32px;">
                <h2 style="margin:0 0 8px; color:#1a3a2e; font-size:22px; font-weight:600;">You're invited!</h2>
                <p style="margin:0 0 24px; color:#555; font-size:15px; line-height:1.6;">
                  <strong>${inviterName}</strong> has invited you to join their team on ZCOR. Create your account to get started.
                </p>

                <!-- Button -->
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                  <tr>
                    <td style="border-radius:8px; background-color:#1a3a2e;">
                      <a href="${inviteUrl}" target="_blank" style="display:inline-block; padding:14px 32px; color:#ffffff; font-size:15px; font-weight:600; text-decoration:none; letter-spacing:0.3px;">
                        Create your account
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 16px; color:#888; font-size:13px; line-height:1.5; text-align:center;">
                  This invitation expires in 7 days.
                </p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding:0 40px;">
                <hr style="border:none; border-top:1px solid #e8ece9; margin:0;" />
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:20px 40px 28px; text-align:center;">
                <p style="margin:0 0 6px; color:#aaa; font-size:12px; line-height:1.5;">
                  If the button doesn't work, copy and paste this link into your browser:
                </p>
                <p style="margin:0; font-size:12px; line-height:1.5; word-break:break-all;">
                  <a href="${inviteUrl}" style="color:#1a3a2e;">${inviteUrl}</a>
                </p>
                <p style="margin:16px 0 0; color:#bbb; font-size:11px;">
                  If you didn't expect this invitation, you can safely ignore this email.
                </p>
              </td>
            </tr>

          </table>
        </td></tr>
      </table>
    </body>
    </html>
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

  return transport.sendMail({
    from: { name: "ZCOR", address: fromAddr },
    to,
    subject,
    text,
    html,
  });
}
