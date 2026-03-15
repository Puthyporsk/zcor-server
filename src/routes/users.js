import { Router } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import requireAuth from "../middleware/requireAuth.js";
import requireRole from "../middleware/requireRole.js";
import { sendInvitationEmail } from "../utils/utils.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";

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
 * POST /api/user (protected — owner/manager only)
 * Send an invitation email to a new user.
 * Body: { firstName, lastName, email }
 */
router.post("/", requireAuth, requireRole("owner", "manager"), async (req, res, next) => {
  try {
    const { firstName, lastName, email, payType, hourlyRate, salaryRate } = req.body || {};
    if (!firstName) throw badRequest("firstName is required");
    if (!lastName)  throw badRequest("lastName is required");
    if (!email)     throw badRequest("email is required");
    if (!payType || !["hourly", "salary"].includes(payType)) throw badRequest("payType must be hourly or salary");
    if (payType === "hourly" && (hourlyRate == null || hourlyRate < 0)) throw badRequest("hourlyRate is required for hourly employees");
    if (payType === "salary" && (salaryRate == null || salaryRate < 0)) throw badRequest("salaryRate is required for salaried employees");

    const emailNorm = String(email).toLowerCase().trim();
    const firstSlug = String(firstName).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const lastSlug  = String(lastName).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const baseUserId = `${firstSlug}.${lastSlug}`;

    const existing = await User.findOne({ email: emailNorm });
    if (existing) throw conflict("A user with this email already exists");

    // Ensure userId is unique — append a number if taken
    let userId = baseUserId;
    let suffix = 1;
    while (await User.findOne({ userId })) {
      userId = `${baseUserId}${suffix++}`;
    }

    // Create placeholder user with real name and employee meta
    const empCode = `EMP-${String(Math.floor(1000 + Math.random() * 9000))}`;
    const placeholder = await User.create({
      firstName: String(firstName).trim(),
      lastName:  String(lastName).trim(),
      userId,
      email: emailNorm,
      role: "employee",
      status: "invited",
      employeeMeta: {
        employeeCode: empCode,
        jobTitle: "Staff Member",
        payType,
        hourlyRate: payType === "hourly" ? Number(hourlyRate) : 0,
        salaryRate: payType === "salary" ? Number(salaryRate) : 0,
        payFrequency: payType === "hourly" ? "biweekly" : "monthly",
        overtimeEligible: payType === "hourly",
        startDate: new Date(),
        notes: `Joined via invitation on ${new Date().toLocaleDateString("en-US")}.`,
      },
    });

    // Sign a 7-day invite JWT (include name so signup page can pre-fill)
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set");
    const token = jwt.sign(
      {
        email: emailNorm,
        firstName: String(firstName).trim(),
        lastName:  String(lastName).trim(),
        userId,
        placeholderId: placeholder._id.toString(),
      },
      secret,
      { expiresIn: "7d" }
    );

    const base = process.env.FRONTEND_URL || "http://localhost:3000";
    const inviteUrl = `${base}/signup?invite=${encodeURIComponent(token)}`;

    const inviterName = `${req.user.firstName} ${req.user.lastName}`.trim();
    try {
      await sendInvitationEmail({ to: emailNorm, inviteUrl, inviterName });
    } catch (mailErr) {
      // Roll back placeholder if email fails
      await User.findByIdAndDelete(placeholder._id);
      console.error("sendInvitationEmail failed:", mailErr);
      throw new Error("Failed to send invitation email. Please check SMTP settings.");
    }

    res.status(201).json({ message: "Invitation sent", user: placeholder });
  } catch (err) {
    next(err);
  }
});

/***
 * PATCH /api/user/:id/role (protected — owner/manager only)
 * Change a user's role.
 * Body: { role }
 */
router.patch("/:id/role", requireAuth, requireRole("owner"), async (req, res, next) => {
  try {
    const { role } = req.body || {};
    const validRoles = ["owner", "manager", "employee"];
    if (!role || !validRoles.includes(role)) {
      throw badRequest("role must be one of: owner, manager, employee");
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true, runValidators: true }
    );
    if (!user) throw notFound("User not found");

    res.json(user);
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