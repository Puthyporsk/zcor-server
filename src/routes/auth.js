// routes/auth.js
import { Router } from "express";
import slugify from "slugify";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import { signAccessToken } from "../utils/jwt.js";
import { badRequest, conflict, unauthorized } from "../utils/httpError.js";

const router = Router();
const COOKIE_NAME = process.env.COOKIE_NAME || "auth_token";
/**
 * Cookie options:
 * - httpOnly: JS can't read the token
 * - sameSite: "lax" works well for localhost + most normal navigation
 * - secure: only true in production (https)
 */
function cookieBaseOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

function setAuthCookie(res, token) {
  const opts = cookieBaseOptions();
  res.cookie(COOKIE_NAME, token, opts);
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieBaseOptions());
}

function userResponse(user) {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    userId: user.userId,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    status: user.status,
    employeeMeta: user.employeeMeta,
  };
}

/**
 * POST /api/auth/register
 * Body: {firstName, lastName, userId, email, password }
 * Creates Owner user, returns token.
 */
router.post("/register", async (req, res, next) => {
  try {
    const existing = await User.findOne({});
    if (existing) throw conflict("not allowed!");

    const {firstName, lastName, userId, email, password } = req.body || {};

    if (!email) throw badRequest("email is required");
    if (!password || String(password).length < 8) {
      throw badRequest("password must be at least 8 characters");
    }

    const owner = await User.create({
      firstName: firstName,
      lastName: lastName,
      userId: userId,
      email: String(email).toLowerCase().trim(),
      role: "owner",
      status: "active",
      password,
    });

    const token = signAccessToken(owner);
    setAuthCookie(res, token);

    res.status(201).json({
      user: userResponse(owner),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password, remember? }
 * Sets HttpOnly cookie, returns { user }
 */
router.post("/login", async (req, res, next) => {
  try {
    const { userId, password } = req.body || {};
    if (!userId || !password) throw badRequest("User ID and Password are required");

    const users = await User.find({
        userId: userId,
    }).select(
      "+passwordHash role status email firstName lastName userId employeeMeta",
    );

    if (!users || users.length === 0) throw unauthorized("Invalid credentials");

    const user = users[0];

    const ok = await user.comparePassword(password);
    if (!ok) throw unauthorized("Invalid credentials");

    if (user.status === "disabled") {
      throw unauthorized("Account is not active");
    }

    if (user.status === "invited") {
      // TODO: force user to reset password
      console.log(user);
    }

    const token = signAccessToken(user);
    setAuthCookie(res, token);

    res.json({ user: userResponse(user) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Clears cookie
 */
router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ message: "Logged out" });
});

/**
 * GET /api/auth/me (protected)
 */
router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: userResponse(req.user) });
});

/**
 * POST /api/auth/forgot-password
 * Body: { email, businessSlug? }
 * Always returns 200 so attackers can’t enumerate emails.
 * In development, returns resetToken for testing.
 */
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) throw badRequest("email is required");

    const emailNorm = String(email).toLowerCase().trim();

    // Need tokenHash field (select:false) => explicitly select it
    const users = await User.find({ email: emailNorm }).select("+passwordReset.tokenHash +passwordReset.expiresAt").limit(2);
    const user = users?.length === 1 ? users[0] : null;

    let resetToken = null;
    if (user) {
      resetToken = user.createPasswordResetToken(30);
      await user.save();
      // TODO: send email with resetToken
    }

    const payload = { message: "If the account exists, password reset instructions were sent." };
    if (process.env.NODE_ENV !== "production" && resetToken) {
      payload.resetToken = resetToken; // dev-only convenience
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export default router;