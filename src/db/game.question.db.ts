import mongoose, { Schema, Document, Model } from "mongoose";
import { IQuestion } from "../interfaces/interface";

const QuestionSchema: Schema<IQuestion> = new Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
    category: { type: String, default: "general" },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      default: "medium",
    },
    used: { type: Boolean, default: false },
    answered_by: { type: Schema.Types.ObjectId },
    reward_amount: { type: Number },
  },
  { timestamps: true }
);

// Indexes for performance
QuestionSchema.index({ used: 1 });
QuestionSchema.index({ category: 1, used: 1 });
QuestionSchema.index({ difficulty: 1, used: 1 });

export const QuestionRepository: Model<IQuestion> =
  mongoose.models.Question ||
  mongoose.model<IQuestion>("Question", QuestionSchema);
