import { Router } from "express";
import rateLimit from "express-rate-limit";
import { sendMail } from "../utils/utils.js";

const router = Router();

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/", contactLimiter, async (req, res, next) => {
  try {
    const { name, email, message } = req.body;

    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ message: "Name and email are required." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: "Please provide a valid email address." });
    }

    const to = process.env.SMTP_USER;
    const subject = `ZCOR Demo Request from ${name.trim()}`;
    const text = `Name: ${name.trim()}\nEmail: ${email.trim()}\n\nMessage:\n${message?.trim() || "(no message)"}`;
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="margin:0; padding:0; background-color:#f4f7f6; font-family:'Segoe UI',Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f7f6; padding:40px 20px;">
          <tr><td align="center">
            <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
              <tr>
                <td style="background-color:#1a3a2e; padding:24px 40px; text-align:center;">
                  <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700; letter-spacing:1px;">New Demo Request</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:32px 40px;">
                  <p style="margin:0 0 6px; color:#888; font-size:13px;">Name</p>
                  <p style="margin:0 0 20px; color:#1a3a2e; font-size:16px; font-weight:600;">${name.trim()}</p>

                  <p style="margin:0 0 6px; color:#888; font-size:13px;">Email</p>
                  <p style="margin:0 0 20px; color:#1a3a2e; font-size:16px;">
                    <a href="mailto:${email.trim()}" style="color:#1a3a2e;">${email.trim()}</a>
                  </p>

                  <p style="margin:0 0 6px; color:#888; font-size:13px;">Message</p>
                  <p style="margin:0; color:#333; font-size:15px; line-height:1.6; white-space:pre-wrap;">${message?.trim() || "<em>No message provided</em>"}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:0 40px 24px;">
                  <hr style="border:none; border-top:1px solid #e8ece9; margin:0 0 16px;" />
                  <p style="margin:0; color:#aaa; font-size:12px; text-align:center;">
                    Sent from the ZCOR landing page contact form
                  </p>
                </td>
              </tr>
            </table>
          </td></tr>
        </table>
      </body>
      </html>
    `;

    await sendMail({ to, subject, html, text, replyTo: email.trim() });

    res.json({ message: "Message sent successfully." });
  } catch (err) {
    next(err);
  }
});

export default router;
