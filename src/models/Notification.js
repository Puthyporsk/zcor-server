import mongoose from "mongoose";

const { Schema, model } = mongoose;

const NotificationSchema = new Schema(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "invite_accepted",
        "time_entry_submitted",
        "time_entry_approved",
        "time_entry_rejected",
        "shift_assigned",
        "shift_updated",
        "leave_request_submitted",
        "leave_request_approved",
        "leave_request_denied",
        "payslip_available",
        "pay_period_status_change",
      ],
      required: true,
    },
    title: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 1000 },
    read: { type: Boolean, default: false },
    relatedEntity: {
      kind: { type: String },
      item: { type: Schema.Types.ObjectId },
    },
    metadata: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

NotificationSchema.index({ recipient: 1, deletedAt: 1, read: 1, createdAt: -1 });

export default model("Notification", NotificationSchema);
