import mongoose from "mongoose";
import connectDB from "./db/db";
import { QuestionRepository } from "./db/game.question.db";
import { questions } from "./questions";

const seedQuestions = async () => {
  try {
    await connectDB();

    for (const q of questions) {
      const exists = await QuestionRepository.findOne({ question: q.question });
      if (!exists) {
        await QuestionRepository.create(q);
        console.log(`✅ Inserted: "${q.question}"`);
      } else {
        console.log(`⏭️ Skipped (already exists): "${q.question}"`);
      }
    }

    console.log("🎉 All trivia questions seeded successfully.");
    mongoose.connection.close();
  } catch (error) {
    console.error("❌ Error seeding trivia questions:", error);
    mongoose.connection.close();
  }
};

seedQuestions();
