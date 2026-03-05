import mongoose, { model } from "mongoose";
import { hash as _hash, compare } from "bcryptjs";
import { randomBytes, createHash } from "crypto";

const { Schema } = mongoose;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const UserSchema = new Schema(
    {
        firstName: { type: String, trim: true, maxlength: 80, required: true },
        lastName: { type: String, trim: true, maxlength: 80, required: true },
        userId: { type: String, trim: true, maxlength: 80, required: true },
        email: {
            type: String,
            unique: true,
            required: true,
            trim: true,
            lowercase: true,
            maxlength: 320,
            validate: {
                validator: (v) => EMAIL_REGEX.test(v),
                message: "Invalid email format",
            },
        },
        phone: { type: String, trim: true, maxlength: 40 },
        avatarUrl: { type: String, trim: true, maxlength: 2048 },
        avatar: {
          data: { type: Buffer, select: false },
          contentType: { type: String },
          updatedAt: { type: Date },
        },

        // Authorization
        role: {
            type: String,
            enum: ["owner", "manager", "employee"],
            default: "employee",
            required: true,
            index: true,
        },

        // Account status lifecycle
        status: {
            type: String,
            enum: ["active", "invited", "disabled"],
            default: "active",
            index: true,
        },

        // Authentication (local)
        passwordHash: { type: String, select: false },

        // Tokens (store hashes, never raw tokens)
        passwordReset: {
            tokenHash: { type: String, select: false },
            expiresAt: { type: Date },
        },

        // Employee/work metadata
        employeeMeta: {
            employeeCode: { type: String, trim: true, maxlength: 50 }, // e.g. internal ID
            jobTitle: { type: String, trim: true, maxlength: 120 },
            payType: { type: String, enum: ["hourly", "salary"], default: "hourly" },
            hourlyRate: { type: Number, min: 0 },
            salaryRate: { type: Number, min: 0 },
            startDate: { type: Date },
            notes: { type: String, trim: true, maxlength: 2000 },
        },

        // Leave policy — annual hour allocations used as defaults when creating LeaveBalance records
        leavePolicy: {
            vacationHours: { type: Number, min: 0, default: 80 },  // 10 days
            sickHours:     { type: Number, min: 0, default: 40 },  // 5 days
            personalHours: { type: Number, min: 0, default: 0 },
        },
    }
);

// --- Virtual password setter (not persisted) ---
UserSchema.virtual("password").set(function setPassword(pw) {
  this._password = pw;
});

// --- Middleware: hash password when provided ---
UserSchema.pre("save", async function preSave(next) {
  try {
    if (typeof this._password === "string" && this._password.length > 0) {
      const saltRounds = 12;
      this.passwordHash = await _hash(this._password, saltRounds);
      this._password = undefined;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// --- Instance methods ---
UserSchema.methods.comparePassword = async function comparePassword(plain) {
  if (!this.passwordHash) return false;
  return compare(plain, this.passwordHash);
};

// Create a reset token; return the *raw* token (send via email), store only the hash.
UserSchema.methods.createPasswordResetToken = function createPasswordResetToken(
  ttlMinutes = 30
) {
  const raw = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  this.passwordReset = {
    tokenHash,
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
  };
  return raw;
};

export default model("User", UserSchema);