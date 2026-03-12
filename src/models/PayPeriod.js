import mongoose from "mongoose";

const { Schema } = mongoose;

const PayPeriodSchema = new Schema(
    {
        startDate: { type: Date, required: true },
        endDate:   { type: Date, required: true },

        frequency: {
            type: String,
            enum: ["biweekly", "monthly"],
            required: true,
        },

        status: {
            type: String,
            enum: ["draft", "reviewed", "approved", "paid"],
            default: "draft",
            required: true,
            index: true,
        },

        createdBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        approvedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        approvedAt: { type: Date },

        paidAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

PayPeriodSchema.index({ startDate: 1, endDate: 1 });
PayPeriodSchema.index({ frequency: 1, status: 1 });

export default mongoose.model("PayPeriod", PayPeriodSchema);
