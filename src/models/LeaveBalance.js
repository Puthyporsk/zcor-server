import mongoose from "mongoose";

const { Schema } = mongoose;

const LeaveBalanceSchema = new Schema(
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

        year: {
            type: Number,
            required: true,
        },

        // Total hours allocated for this type/year (set by manager/owner)
        allocated: { type: Number, default: 0, min: 0 },

        // Hours consumed by approved requests
        used: { type: Number, default: 0, min: 0 },

        // Hours locked in pending requests (not yet approved/denied)
        pending: { type: Number, default: 0, min: 0 },

        // Hours carried over from previous year (included in allocated)
        carriedOver: { type: Number, default: 0, min: 0 },

        // Audit trail of per-pay-period accruals
        accrualLog: [
            {
                payPeriod:        { type: Schema.Types.ObjectId, ref: "PayPeriod" },
                hoursAccrued:     { type: Number },
                runningAllocated: { type: Number },
                accrualDate:      { type: Date },
                note:             { type: String },
                _id: false,
            },
        ],
    },
    {
        timestamps: true,
    }
);

// One balance record per employee/type/year
LeaveBalanceSchema.index({ employee: 1, type: 1, year: 1 }, { unique: true });

export default mongoose.model("LeaveBalance", LeaveBalanceSchema);
