import { Types, Document } from "mongoose";

export enum Platform {
  "TIKTOK" = "tiktok",
  "FACEBOOK" = "facebook",
}
/* ---------------- Game DB ---------------- */
export interface GameUserInterface extends Document {
  username: string;
  tokens: number;
  platform: Platform;
  balance: number;
}

export interface TransactionInterface extends Document {
  userId: Types.ObjectId; // ref to GameUser
  tokensPurchased: number;
  createdAt: Date;
}

export interface IQuestion extends Document {
  question: string;
  answer: string;
  category?: string;
  difficulty?: string;
  used: boolean;
  answered_by: Types.ObjectId;
  reward_amount: number;
  createdAt: Date;
}
