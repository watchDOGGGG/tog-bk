import mongoose, { Schema, Model } from "mongoose";
import { IWithdrawal } from "../interfaces/interface";

const WithdrawalSchema: Schema<IWithdrawal> = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "GameUser", required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    method: { type: String, required: true },
  },
  { timestamps: true }
);

WithdrawalSchema.index({ userId: 1, status: 1 });

export const WithdrawalRepository: Model<IWithdrawal> =
  mongoose.models.Withdrawal ||
  mongoose.model<IWithdrawal>("Withdrawal", WithdrawalSchema);
