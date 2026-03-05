import mongoose from "mongoose";

const { Schema } = mongoose;

const OrderItemSchema = new Schema(
    {
        inventoryItem: { type: Schema.Types.ObjectId, ref: "InventoryItem", required: true },
        quantity:      { type: Number, required: true, min: 1 },
        unitPrice:     { type: Number, min: 0, default: 0 },
        itemName:      { type: String, trim: true, maxlength: 150 }, // snapshot at order time
    },
    { _id: true }
);

const InventoryOrderSchema = new Schema(
    {
        orderType:   { type: String, enum: ["purchase", "sale", "usage"], required: true, index: true },
        orderDate:   { type: Date, required: true, default: Date.now, index: true },
        vendor:      { type: String, trim: true, maxlength: 200 },
        relatedUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
        items:       { type: [OrderItemSchema], validate: { validator: (v) => v.length >= 1, message: "At least one item is required" } },
        notes:       { type: String, trim: true, maxlength: 500 },
        createdBy:   { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

InventoryOrderSchema.index({ orderType: 1, orderDate: -1 });
InventoryOrderSchema.index({ "items.inventoryItem": 1, orderDate: -1 });
InventoryOrderSchema.index({ relatedUser: 1, orderDate: -1 });

export default mongoose.model("InventoryOrder", InventoryOrderSchema);
