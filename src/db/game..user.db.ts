import { Schema } from "mongoose";
import { GameUserInterface } from "../interfaces/interface";
import { model } from "mongoose";

const gameUserSchema = new Schema<GameUserInterface>({
  username: { type: String, required: true, unique: true },
  tokens: { type: Number, default: 0 },
  platform: { type: String, required: true },
  balance: { type: Number, default: 0 },
  exp: { type: Number, default: 0 },
  passkey: { type: String },
});

export const GameUserRepository = model<GameUserInterface>(
  "GameUser",
  gameUserSchema
);
