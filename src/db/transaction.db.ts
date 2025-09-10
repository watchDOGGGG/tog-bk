import { Schema } from "mongoose";
import { TransactionInterface } from "../interfaces/interface";
import { model } from "mongoose";

const transactionSchema = new Schema<TransactionInterface>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "GameUser", required: true },
    tokensPurchased: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const Transaction = model<TransactionInterface>(
  "Transaction",
  transactionSchema
);
