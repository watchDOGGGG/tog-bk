import { Types } from "mongoose";
import { GameUserRepository } from "../db/game..user.db";
import jwt from "jsonwebtoken";
import { QuestionRepository } from "../db/game.question.db";

class GameService {
  private readonly gameUserRepository = GameUserRepository;
  private readonly questionRepository = QuestionRepository;
  /**
   * Join or login existing user
   */
  public async joinGame(username: string, platform: string) {
    // 1. Try to find the user
    let user = await this.gameUserRepository.findOne({ username });

    // 2. If not found, create a new user
    if (!user) {
      user = new this.gameUserRepository({ username, platform });
      await user.save();
    }

    // 3. Generate JWT (expires in 7 days)
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
}

export const gameService = new GameService();
