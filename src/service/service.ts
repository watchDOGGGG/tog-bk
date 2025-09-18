import { Types } from "mongoose";
import { GameUserRepository } from "../db/game..user.db";
import jwt from "jsonwebtoken";
import { QuestionRepository } from "../db/game.question.db";
import { WithdrawalRepository } from "../db/game.withdrawal.db";
import bcrypt from "bcryptjs";
import axios from "axios";

class GameService {
  private readonly gameUserRepository = GameUserRepository;
  private readonly questionRepository = QuestionRepository;
  private readonly withdrawalRepository = WithdrawalRepository;
  private MAX_RETRIES = 5;
  private RETRY_DELAY = 2000;
  private TOGETHER_API_URL = "https://api.together.xyz/v1/chat/completions";
  private TOGETHER_API_KEY =
    "f398a150ced62dcb5cea881ecac0d9315bbdb6e9d431b65fdae83766becbd9c1";

  /**
   * Join or login existing user
   */

  public async generateReferralCode(username: string): Promise<string> {
    const uniquePart = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${username.slice(0, 3).toUpperCase()}-${uniquePart}`;
  }

  public async joinGame(
    username: string,
    platform: string,
    passkey: string,
    referralCode?: string
  ) {
    let user = await this.gameUserRepository.findOne({ username });

    if (user) {
      if (!user.passkey) {
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
      const hashedPasskey = await bcrypt.hash(passkey, 10);

      let referredBy = null;

      if (referralCode) {
        const referrer = await this.gameUserRepository.findOne({
          referral_code: referralCode,
        });
        if (referrer) {
          referrer.no_of_referrals += 1;
          await referrer.save();
          referredBy = referrer._id;
        }
      }

      user = new this.gameUserRepository({
        username,
        platform,
        passkey: hashedPasskey,
        referral_code: await this.generateReferralCode(username),
        no_of_referrals: 0,
        referred_by: referredBy,
      });

      await user.save();
    }

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

    // Add tokens to buyer
    user.tokens += no_of_token;
    await user.save();

    // ✅ Referral reward
    if (user.referred_by) {
      const referrer = await this.gameUserRepository.findById(user.referred_by);
      if (referrer) {
        referrer.tokens += 1; // bonus token for referrer
        await referrer.save();
        console.log(
          `🎉 Referral reward: ${referrer.username} earned +1 token (from ${user.username}'s purchase)`
        );
      }
    }

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

  public async getTokenAndBalance(user_id: Types.ObjectId) {
    const user = await this.gameUserRepository
      .findById(user_id)
      .select("tokens balance");

    if (!user) {
      throw new Error("User not found");
    }

    return {
      tokens: user.tokens,
      balance: user.balance,
    };
  }

  public async getAndUpdateQuestion() {
    // Step 1: Try to get a random unanswered + unused question
    let question = await this.questionRepository.aggregate([
      {
        $match: {
          $or: [
            { used: false }, // brand new question
            { answered_by: null }, // used but not answered yet
          ],
        },
      },
      { $sample: { size: 1 } }, // pick random
    ]);

    // Step 2: If no question found, trigger AI to generate more
    if (!question || question.length === 0) {
      console.warn("⚠️ No questions left. Generating new ones...");
      const newQuestions = await this.generateQuestionsFromAI(50);

      if (newQuestions.length === 0) {
        console.error("❌ Failed to generate new questions.");
        return null;
      }

      // Retry fetch with new batch
      question = await this.questionRepository.aggregate([
        {
          $match: {
            $or: [{ used: false }, { answered_by: null }],
          },
        },
        { $sample: { size: 1 } },
      ]);

      if (!question || question.length === 0) {
        console.error("❌ Even after generation, no questions available.");
        return null;
      }
    }

    // Step 3: Mark it as "used" immediately (reserve it)
    const picked = await this.questionRepository.findByIdAndUpdate(
      question[0]._id,
      { $set: { used: true } },
      { new: true }
    );

    return picked;
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

  public async purchaseTokensWithBalance(
    userId: Types.ObjectId,
    tokensToBuy: number
  ) {
    const objectId = new Types.ObjectId(userId);
    const user = await this.gameUserRepository.findById(objectId);

    if (!user) {
      throw new Error("User not found");
    }

    const cost = tokensToBuy * 100; // 1 token = 100 balance units

    if (user.balance < cost) {
      throw new Error("Insufficient balance to purchase tokens");
    }

    // Deduct balance & add tokens
    user.balance -= cost;
    user.tokens += tokensToBuy;

    await user.save();

    return {
      message: `✅ Successfully purchased ${tokensToBuy} tokens`,
      user,
    };
  }

  public async generateQuestionsFromAI(count: number = 50) {
    let attempts = 0;

    while (attempts < this.MAX_RETRIES) {
      try {
        const response = await axios.post(
          this.TOGETHER_API_URL,
          {
            model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            messages: [
              {
                role: "user",
                content: `
Generate ${count} unique multiple-choice trivia questions across categories 
(sports, science, history, geography, technology, general knowledge).  

Return as a valid JSON array, each item like:
{
  "question": "string",
  "answer": "string",
  "category": "string",
  "difficulty": "easy|medium|hard"
}
NO explanations, only JSON array.
              `,
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${this.TOGETHER_API_KEY}`,
            },
          }
        );

        const raw =
          (response.data as any)?.choices?.[0]?.message?.content || "[]";

        // 🧹 Clean possible markdown or prefix
        let cleaned = raw
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .replace(/^questions\s*=\s*/, "") // remove "questions ="
          .trim();

        let questions: any[] = [];

        try {
          // Try direct parse first
          questions = JSON.parse(cleaned);
        } catch {
          console.warn(
            "⚠️ Direct JSON parse failed. Falling back to regex parsing..."
          );

          // ✅ Regex fallback: extract only complete { ... } blocks
          const matches = cleaned.match(/\{[^}]+\}/g) || [];

          questions = matches
            .map((obj: any) => {
              try {
                return JSON.parse(obj);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          console.log(
            `✅ Extracted ${questions.length} valid questions from partial AI response`
          );
        }

        const enriched = questions.map((q) => ({
          question: q.question.trim(),
          answer: q.answer.trim(),
          category: q.category || "general",
          difficulty: q.difficulty || "medium",
          reward_amount:
            q.difficulty === "hard"
              ? 250
              : q.difficulty === "medium"
              ? 150
              : 100,
          used: false,
          answered_by: null as Types.ObjectId | null,
        }));

        // ✅ Filter duplicates before inserting
        const newQuestions: any[] = [];
        for (const q of enriched) {
          const exists = await this.questionRepository.findOne({
            question: q.question,
          });
          if (!exists) {
            newQuestions.push(q);
          }
        }

        if (newQuestions.length > 0) {
          await this.questionRepository.insertMany(newQuestions);
          console.log(
            `🎉 Inserted ${newQuestions.length} new questions into DB`
          );
        } else {
          console.log("ℹ️ No new unique questions to insert.");
        }

        return newQuestions;
      } catch (error: any) {
        attempts++;

        if (error.response?.status === 429) {
          console.warn(`Rate limit reached. Retrying attempt ${attempts}...`);
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY));
        } else {
          console.error("❌ Error from Together API:", error.message);
          return [];
        }
      }
    }

    console.error("⚠️ Max retries reached. Returning empty set.");
    return [];
  }
}

export const gameService = new GameService();
