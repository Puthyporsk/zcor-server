import mongoose from "mongoose";

const { Schema } = mongoose;

const InventoryItemSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 150,
        },
        type: {
            type: String,
            required: true,
            enum: ["equipment", "supply"],
            index: true,
        },
        category: {
            type: String,
            trim: true,
            maxlength: 100,
            index: true,
        },
        description: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        isActive: { type: Boolean, default: true },
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

        // Equipment-only fields
        serialNumber: { type: String, trim: true, maxlength: 100 },
        condition: {
            type: String,
            enum: ["new", "good", "fair", "poor", "retired"],
            default: "good",
        },
        assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
        assignedAt: { type: Date, default: null },
        purchaseDate: { type: Date },
        purchaseCost: { type: Number, min: 0 },

        // Supply-only fields
        quantity: { type: Number, min: 0, default: 0 },
        unit: { type: String, trim: true, maxlength: 30, default: "units" },
        lowStockThreshold: { type: Number, min: 0, default: 0 },
    },
    { timestamps: true }
);

InventoryItemSchema.index({ isActive: 1, type: 1, category: 1 });

export default mongoose.model("InventoryItem", InventoryItemSchema);
