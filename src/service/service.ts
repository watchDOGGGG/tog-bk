import { Types } from "mongoose";
import { GameUserRepository } from "../db/game..user.db";
import jwt from "jsonwebtoken";
import { QuestionRepository } from "../db/game.question.db";
import { WithdrawalRepository } from "../db/game.withdrawal.db";
import bcrypt from "bcryptjs";

class GameService {
  private readonly gameUserRepository = GameUserRepository;
  private readonly questionRepository = QuestionRepository;
  private readonly withdrawalRepository = WithdrawalRepository;

  /**
   * Join or login existing user
   */

  public async joinGame(username: string, platform: string, passkey: string) {
    // 1. Try to find the user
    let user = await this.gameUserRepository.findOne({ username });

    if (user) {
      // 2. If user exists, check passkey
      if (!user.passkey) {
        // For old accounts with no passkey, set one
        const hashedPasskey = await bcrypt.hash(passkey, 10);
        user.passkey = hashedPasskey;
        await user.save();
      } else {
        const isMatch = await bcrypt.compare(passkey, user.passkey);
        if (!isMatch) {
          throw new Error("Invalid passkey. Access denied.");
        }
      }
    } else {
      // 3. If not found, create new user with hashed passkey
      const hashedPasskey = await bcrypt.hash(passkey, 10);
      user = new this.gameUserRepository({
        username,
        platform,
        passkey: hashedPasskey,
      });
      await user.save();
    }

    // 4. Generate JWT (expires in 7 days)
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET || "supersecret",
      { expiresIn: "7d" }
    );

    return { user, token };
  }

  public async getAllUsers() {
    return this.gameUserRepository.find();
  }

  public async getUserById(userId: Types.ObjectId) {
    const objectId = new Types.ObjectId(userId);

    const user = await this.gameUserRepository.findById(objectId);

    if (!user) {
      throw new Error("User not found");
    }

    return user;
  }

  /**
   * Add tokens to a user's balance (buy tokens)
   */
  public async buyToken(user_id: Types.ObjectId, no_of_token: number) {
    const user = await this.gameUserRepository.findById(user_id);
    if (!user) throw new Error("User not found");

    user.tokens += no_of_token;
    await user.save();

    return user;
  }

  /**
   * Deduct tokens when a user spends them
   */
  public async useToken(userId: Types.ObjectId, no_of_token: number) {
    return this.gameUserRepository.findOneAndUpdate(
      { _id: userId, tokens: { $gte: no_of_token } }, // only if user has enough
      { $inc: { tokens: -no_of_token } },
      { new: true } // return updated user
    );
  }

  public async getTokenCount(user_id: Types.ObjectId) {
    const token_count = await this.gameUserRepository
      .findById(user_id)
      .select("tokens");

    return token_count;
  }

  public async getAndUpdateQuestion() {
    const question = await this.questionRepository.findOneAndUpdate(
      { used: false },
      { $set: { used: true } },
      { new: true }
    );
    return question;
  }

  public async addBalance(userId: Types.ObjectId, amount: number) {
    return this.gameUserRepository.findOneAndUpdate(
      { _id: userId },
      { $inc: { balance: amount } },
      { new: true } // return updated user
    );
  }
  // question.service.ts
  public async markAnswered(
    questionId: Types.ObjectId,
    userId: Types.ObjectId
  ) {
    return this.questionRepository.findByIdAndUpdate(
      questionId,
      { $set: { answered_by: userId } },
      { new: true }
    );
  }

  public async requestWithdrawal(
    userId: Types.ObjectId,
    amount: number,
    method: string
  ) {
    const user = await this.gameUserRepository.findById(userId);

    if (!user) throw new Error("User not found");
    if (user.balance < amount) throw new Error("Insufficient balance");

    // Deduct balance
    user.balance -= amount;
    await user.save();

    // Create withdrawal record
    return this.withdrawalRepository.create({
      userId,
      amount,
      method,
      status: "pending",
    });
  }

  // 📌 Update withdrawal status (admin)
  public async updateWithdrawalStatus(
    withdrawalId: Types.ObjectId,
    status: "approved" | "rejected"
  ) {
    const withdrawal = await this.withdrawalRepository.findById(withdrawalId);
    if (!withdrawal) throw new Error("Withdrawal not found");

    withdrawal.status = status;
    await withdrawal.save();

    // Refund user if rejected
    if (status === "rejected") {
      await this.gameUserRepository.findByIdAndUpdate(withdrawal.userId, {
        $inc: { balance: withdrawal.amount },
      });
    }

    return withdrawal;
  }

  public async updateExp(userId: string, exp: number): Promise<number> {
    const objectId = new Types.ObjectId(userId);

    const user = await this.gameUserRepository.findByIdAndUpdate(
      objectId,
      { exp },
      { new: true, select: "exp" }
    );

    if (!user) {
      throw new Error("User not found");
    }

    return user.exp;
  }
}

export const gameService = new GameService();
