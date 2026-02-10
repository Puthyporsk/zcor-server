// middleware/requireAuth.js
import { unauthorized } from "../utils/httpError.js";
import User from "../models/User.js";
import { verifyAccessToken } from "../utils/jwt.js";

const COOKIE_NAME = process.env.COOKIE_NAME || "auth_token";

export default async function requireAuth(req, res, next) {
  try {
    // 1) Try cookie
    let token = req.cookies?.[COOKIE_NAME];

    // 2) Fallback: Authorization header
    if (!token) {
      const auth = req.headers.authorization || "";
      if (auth.startsWith("Bearer ")) token = auth.slice(7);
    }

    if (!token) throw unauthorized("Not authenticated");

    const payload = verifyAccessToken(token); // should throw if invalid/expired
    const userId = payload?.sub || payload?._id || payload?.id;

    if (!userId) throw unauthorized("Not authenticated");

    const user = await User.findById(userId);
    if (!user) throw unauthorized("Not authenticated");

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
