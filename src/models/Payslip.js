import mongoose from "mongoose";

const { Schema } = mongoose;

const DeductionSchema = new Schema(
    {
        name:       { type: String, required: true, trim: true },
        type:       { type: String, enum: ["tax", "benefit", "retirement", "other"], required: true },
        calcMethod: { type: String, enum: ["percentage", "flat"], required: true },
        rate:       { type: Number },           // percentage rate used (for reference)
        amount:     { type: Number, required: true, min: 0 },  // calculated dollar amount
        preTax:     { type: Boolean, default: false },
    },
    { _id: false }
);

const EmployerCostSchema = new Schema(
    {
        name:   { type: String, required: true, trim: true },
        amount: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const PayslipSchema = new Schema(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        payPeriod: {
            type: Schema.Types.ObjectId,
            ref: "PayPeriod",
            required: true,
            index: true,
        },

        // Hours breakdown
        regularHours:   { type: Number, default: 0, min: 0 },
        overtimeHours:  { type: Number, default: 0, min: 0 },
        paidLeaveHours: { type: Number, default: 0, min: 0 },
        totalHours:     { type: Number, default: 0, min: 0 },

        // Pay breakdown
        payType:    { type: String, enum: ["hourly", "salary"], required: true },
        payRate:    { type: Number, min: 0 },  // hourly rate or per-period salary amount
        otRate:     { type: Number, min: 0 },  // overtime rate (1.5x)
        regularPay:  { type: Number, default: 0, min: 0 },
        overtimePay: { type: Number, default: 0, min: 0 },
        grossPay:    { type: Number, default: 0, min: 0 },

        // Deductions
        deductions:      [DeductionSchema],
        totalDeductions: { type: Number, default: 0, min: 0 },

        // Net
        netPay: { type: Number, default: 0 },

        // Employer costs (not deducted from employee, tracked for reporting)
        employerCosts:      [EmployerCostSchema],
        totalEmployerCosts: { type: Number, default: 0, min: 0 },

        // Payment tracking (future integration ready)
        payment: {
            method: {
                type: String,
                enum: ["pending", "manual", "direct_deposit", "check"],
                default: "pending",
            },
            status: {
                type: String,
                enum: ["unpaid", "processing", "paid", "failed"],
                default: "unpaid",
            },
            processedAt:  { type: Date },
            transactionId: { type: String },
            providerRef:   { type: String },
        },

        // Manual adjustments by manager
        adjustments: {
            note: { type: String, trim: true, maxlength: 500 },
            adjustedBy: { type: Schema.Types.ObjectId, ref: "User" },
            adjustedAt: { type: Date },
        },
    },
    {
        timestamps: true,
    }
);

PayslipSchema.index({ employee: 1, payPeriod: 1 }, { unique: true });

export default mongoose.model("Payslip", PayslipSchema);
