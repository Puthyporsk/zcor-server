// utils/jwt.js
import jwt from "jsonwebtoken";

export function signAccessToken(user, remember = false) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");

  const defaultExpiresIn = process.env.JWT_EXPIRES_IN || "12h";

  const expiresIn = remember ? "30d" : defaultExpiresIn;

  return jwt.sign(
    {
      sub: user._id.toString(),
      business: user.business?.toString(),
      role: user.role,
    },
    secret,
    { expiresIn },
  );
}

export function verifyAccessToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return jwt.verify(token, secret);
}
