import mongoose from "mongoose";

const { Schema } = mongoose;

const TimeEntrySchema = new Schema(
    {
        // Employee who owns this entry
        user: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        // Core entry fields
        project: { type: String, trim: true, maxlength: 120, required: true },
        task:    { type: String, trim: true, maxlength: 120, required: true },
        description: { type: String, trim: true, maxlength: 1000 },

        // Work date — time component is ignored; treat as a local calendar date
        date: { type: Date, required: true, index: true },

        // Decimal hours, e.g. 1.5 = 1 h 30 min
        hours: {
            type: Number,
            required: true,
            min: [0.25, "Minimum entry is 0.25 hours (15 minutes)"],
            max: [24,   "Cannot log more than 24 hours in a single entry"],
        },

        type: {
            type: String,
            enum: ["billable", "non-billable"],
            default: "billable",
            required: true,
        },

        // Workflow lifecycle
        status: {
            type: String,
            enum: ["draft", "submitted", "approved", "rejected"],
            default: "draft",
            required: true,
            index: true,
        },

        // Set when the employee clicks "Submit for Review"
        submittedAt: { type: Date },

        // Set when a manager approves or rejects
        reviewedBy:  { type: Schema.Types.ObjectId, ref: "User" },
        reviewedAt:  { type: Date },
        reviewNote:  { type: String, trim: true, maxlength: 500 },
    },
    {
        timestamps: true, // adds createdAt, updatedAt
    }
);

// --- Compound indexes for common query patterns ---

// Fetch a user's entries sorted by date (timesheet view, calendar)
TimeEntrySchema.index({ user: 1, date: -1 });

// Fetch a user's entries filtered by status (e.g. all drafts for a user)
TimeEntrySchema.index({ user: 1, status: 1 });

export default mongoose.model("TimeEntry", TimeEntrySchema);
