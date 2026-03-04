import mongoose from "mongoose";

const { Schema } = mongoose;

const TaskSchema = new Schema(
    {
        name: {
            type: String,
            trim: true,
            maxlength: 80,
            required: true,
            unique: true,
        },
        description: { type: String, trim: true, maxlength: 300 },
        isActive: { type: Boolean, default: true, index: true },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

export default mongoose.model("Task", TaskSchema);
