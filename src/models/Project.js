import mongoose from "mongoose";

const { Schema } = mongoose;

const ProjectSchema = new Schema(
    {
        name: {
            type: String,
            trim: true,
            maxlength: 120,
            required: true,
            unique: true,
        },
        description: { type: String, trim: true, maxlength: 500 },
        isActive: { type: Boolean, default: true, index: true },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

export default mongoose.model("Project", ProjectSchema);
