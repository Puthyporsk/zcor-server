import mongoose from "mongoose";

const { Schema } = mongoose;

const ShiftSchema = new Schema(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        // Calendar date — time component ignored, treated as local calendar date
        date: { type: Date, required: true, index: true },

        // 24-hour format strings e.g. "09:00", "17:30"
        startTime: { type: String, required: true },
        endTime:   { type: String, required: true },

        task:  { type: Schema.Types.ObjectId, ref: "Task" },
        notes: { type: String, trim: true, maxlength: 300 },

        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

ShiftSchema.index({ employee: 1, date: 1 });

export default mongoose.model("Shift", ShiftSchema);
