import { Schema } from "mongoose";
import { GameUserInterface } from "../interfaces/interface";
import { model } from "mongoose";

const gameUserSchema = new Schema<GameUserInterface>({
  username: { type: String, required: true, unique: true },
  tokens: { type: Number, default: 0 },
  platform: { type: String, required: true },
  balance: { type: Number, default: 0 },
  exp: { type: Number, default: 0 },
  referral_code: { type: String },
  no_of_referrals: { type: Number, default: 0 },
  passkey: { type: String },
  referred_by: { type: Schema.Types.ObjectId, ref: "GameUser", default: null },
});

export const GameUserRepository = model<GameUserInterface>(
  "GameUser",
  gameUserSchema
);
