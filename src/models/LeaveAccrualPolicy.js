import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Singleton document — company-level leave accrual configuration.
 * Fetched via LeaveAccrualPolicy.findOne({}).
 */
const TenureTierSchema = new Schema(
    {
        minYears:       { type: Number, required: true, min: 0 },
        vacationHours:  { type: Number, required: true, min: 0 },
        sickHours:      { type: Number, required: true, min: 0 },
        personalHours:  { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const LeaveAccrualPolicySchema = new Schema(
    {
        accrualEnabled: { type: Boolean, default: true },

        // Tenure tiers — evaluated descending by minYears; first match wins
        tenureTiers: {
            type: [TenureTierSchema],
            default: [
                { minYears: 0, vacationHours: 80, sickHours: 40, personalHours: 0 },
            ],
        },

        // Cap = annualAllocation × multiplier; stop accruing once remaining hits this
        accrualCapMultiplier: {
            vacation:  { type: Number, default: 1.5, min: 1 },
            sick:      { type: Number, default: 1.5, min: 1 },
            personal:  { type: Number, default: 1.5, min: 1 },
        },

        // Max hours that roll into the next year (0 = use-it-or-lose-it)
        carryoverLimits: {
            vacation:  { type: Number, default: 40, min: 0 },
            sick:      { type: Number, default: 40, min: 0 },
            personal:  { type: Number, default: 0, min: 0 },
        },

        // No accrual during first N calendar days of employment
        waitingPeriodDays: { type: Number, default: 90, min: 0 },

        // How leave hours become available to employees
        availabilityMode: {
            type: String,
            enum: ["front_loaded", "accrual_only", "hybrid"],
            default: "accrual_only",
        },

        // (hybrid mode only) Max hours an employee can borrow ahead of accrual
        maxBorrowAheadHours: {
            vacation:  { type: Number, default: 0, min: 0 },
            sick:      { type: Number, default: 0, min: 0 },
            personal:  { type: Number, default: 0, min: 0 },
        },

        // (front_loaded mode only) Prorate allocation for mid-year hires
        midYearHireProration: { type: Boolean, default: true },
    },
    { timestamps: true }
);

export default mongoose.model("LeaveAccrualPolicy", LeaveAccrualPolicySchema);
