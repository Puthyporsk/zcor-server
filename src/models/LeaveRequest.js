import mongoose from "mongoose";

const { Schema } = mongoose;

const LeaveRequestSchema = new Schema(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        type: {
            type: String,
            enum: ["sick", "vacation", "personal"],
            required: true,
        },

        startDate: { type: Date, required: true },
        endDate:   { type: Date, required: true },

        // Total hours requested (manually entered or calculated by frontend)
        totalHours: {
            type: Number,
            required: true,
            min: [0.25, "Minimum leave is 0.25 hours"],
        },

        reason: { type: String, trim: true, maxlength: 500 },

        status: {
            type: String,
            enum: ["pending", "approved", "denied", "cancelled"],
            default: "pending",
            required: true,
            index: true,
        },

        // Per-year hour distribution (for cross-year requests)
        yearBreakdown: [{
            year:  { type: Number, required: true },
            hours: { type: Number, required: true, min: 0 },
            _id: false,
        }],

        reviewedBy:  { type: Schema.Types.ObjectId, ref: "User" },
        reviewedAt:  { type: Date },
        reviewNote:  { type: String, trim: true, maxlength: 500 },
    },
    {
        timestamps: true,
    }
);

LeaveRequestSchema.index({ employee: 1, startDate: -1 });
LeaveRequestSchema.index({ employee: 1, status: 1 });

export default mongoose.model("LeaveRequest", LeaveRequestSchema);
