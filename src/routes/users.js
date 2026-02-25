import { Router } from "express";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";

const router = Router();

/***
 * GET /api/user (protected)
 * Returns list of users
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const users = await User.find()
      .select({})
      .sort({ createdAt: -1 });

    res.json(users);
  } catch (err) {
    next(err);
  }
});

/***
 * POST /api/user (protected)
 * Create a new user (Manager, Employee)
 * Body: { email, firstName, lastName, role }
 */
router.post("/", requireAuth, async (req, res, next) => {
  try {
    // Create user logic here
    res.status(201).json({ message: "TODO: User created" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/user/me/change-password
 * Change current user's password
 * Body: { currentPassword, newPassword, confirmPassword? }
 */
router.post("/me/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "currentPassword and newPassword are required." });
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters." });
    }

    const userId = req.user._id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    // passwordHash is select:false → must include it explicitly
    const user = await User.findById(userId).select("+passwordHash");
    if (!user) return res.status(404).json({ message: "User not found." });

    const ok = await user.comparePassword(currentPassword);
    if (!ok) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    // Use your virtual setter → pre-save hook hashes into passwordHash
    user.password = newPassword;
    await user.save();

    return res.status(200).json({ message: "Password changed successfully." });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/user/me
 * Update current user's profile
 * Body: { phone }
 */
router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized." });

    const { phone } = req.body || {};

    const update = {};

    if (typeof phone === "string") {
      const p = phone.trim();
      const PHONE_REGEX = /^\(\d{3}\)-\d{3} \d{4}$/;
      if (p && !PHONE_REGEX.test(p)) {
        return res.status(400).json({ message: "Phone must be in format (XXX)-XXX XXXX." });
      }
      update.phone = p;
    }

    const user = await User.findByIdAndUpdate(userId, update, {
      new: true,
      runValidators: true,
    });

    return res.json({
      ...user,
      phone: user.phone,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/user/avatar
 * Upload avatar image (multipart/form-data with "avatar" field)
 * Body: { base64, contentType }
 */
router.patch("/me/avatar", requireAuth, async (req, res, next) => {
  try {
    const userId =req.user?._id;
    if (!userId) return res.status(401).json({ message: "Unauthorized." });

    const { base64, contentType } = req.body || {};

    if (!base64 || typeof base64 !== "string") {
      return res.status(400).json({ message: "base64 is required." });
    }
    if (!contentType || typeof contentType !== "string") {
      return res.status(400).json({ message: "contentType is required." });
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      return res.status(400).json({ message: "Only PNG/JPEG/WEBP allowed." });
    }

    const raw = base64.includes("base64,") ? base64.split("base64,")[1] : base64;
    const buf = Buffer.from(raw, "base64");
    if (!buf.length) return res.status(400).json({ message: "Invalid base64." });

    // optional safety limit: 2MB
    if (buf.length > 2 * 1024 * 1024) {
      return res.status(400).json({ message: "Image too large (max 2MB)." });
    }

    const avatarUrl = "/api/user/me/avatar";

    const user = await User.findByIdAndUpdate(
      userId,
      {
        avatar: { data: buf, contentType, updatedAt: new Date() },
        avatarUrl, // keep existing field, now points to DB-backed endpoint
      },
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ message: "User not found." });

    return res.json({ avatarUrl: user.avatarUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/user/me/avatar
 * Get avatar image
 */
router.get("/me/avatar", requireAuth, async (req, res, next) => {
  try {
    const userId =req.user?._id;
    if (!userId) return res.status(401).end();

    const user = await User.findById(userId).select("+avatar.data avatar.contentType");
    if (!user?.avatar?.data) return res.status(404).end();

    res.setHeader("Content-Type", user.avatar.contentType || "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.send(user.avatar.data);
  } catch (err) {
    next(err);
  }
});


export default router;