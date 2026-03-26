import mongoose from "mongoose";

const clockSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    clockIn: {
      type: Date,
      required: true,
    },
    clockOut: {
      type: Date,
      default: null,
    },
    hours: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["active", "completed", "auto-closed", "discarded"],
      default: "active",
      index: true,
    },
    timeEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TimeEntry",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Enforce at most one active session per user
clockSessionSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

export default mongoose.model("ClockSession", clockSessionSchema);
