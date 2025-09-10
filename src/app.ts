import express, { Application } from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import connectDB from "./db/db";
import { controller } from "./controller/controller";
import { gameService } from "./service/service";
import { Types } from "mongoose";

const app: Application = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(cors());
app.use(express.json());

// REST routes
app.post("/join", controller.joinGame);
app.get("/users", controller.getAllUsers);
app.post("/buyToken", controller.buyToken);
app.get("/countTokens/:user_id", controller.getTokenCount);

let onlineUsers: { userId: string; username: string; socketId: string }[] = [];

// 📌 Quiz questions array
const questions = [
  { round: 1, title: "What is 2 + 2?", answer: "4" },
  { round: 2, title: "Capital of France?", answer: "Paris" },
  { round: 3, title: "What color is the sky?", answer: "Blue" },
];

let currentRound = 0;
let currentQuestion: any = null;
let winnerDeclared = false;
let questionStartTime: number | null = null;
const QUESTION_DURATION = 30; // seconds

// SOCKET
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  // Handle joining players
  socket.on("user:join", ({ userId, username }) => {
    if (!onlineUsers.find((u) => u.userId === userId)) {
      onlineUsers.push({ userId, username, socketId: socket.id });
    }

    console.log("✅ Online users:", onlineUsers);
    io.emit("players:update", onlineUsers);
  });

  // 📌 Frontend asks for next question
  socket.on("quiz:getQuestion", async () => {
    try {
      const q = await gameService.getAndUpdateQuestion();

      if (!q) {
        io.emit("quiz:end", { message: "No more questions available!" });
        return;
      }

      winnerDeclared = false;
      currentRound++;
      currentQuestion = q;
      questionStartTime = Date.now(); // ⏱️ record start time

      io.emit("quiz:question", {
        round: currentRound,
        questionId: q._id,
        title: q.question,
        category: q.category,
        difficulty: q.difficulty,
        reward_amount: q.reward_amount,
        timeLeft: QUESTION_DURATION, // everyone starts with same countdown
      });

      console.log(`📢 Round ${currentRound}: ${q.question}`);
    } catch (error: any) {
      console.error("❌ Error fetching question:", error.message);
      io.emit("quiz:error", { message: "Failed to fetch question" });
    }
  });

  // 📌 New users can sync with the ongoing question
  socket.on("quiz:syncQuestion", () => {
    if (currentQuestion && questionStartTime) {
      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      const remaining = Math.max(0, QUESTION_DURATION - elapsed);

      socket.emit("quiz:question", {
        round: currentRound,
        questionId: currentQuestion._id,
        title: currentQuestion.question,
        category: currentQuestion.category,
        difficulty: currentQuestion.difficulty,
        reward_amount: currentQuestion.reward_amount,
        timeLeft: remaining, // ✅ synced countdown
      });
    }
  });

  // 📌 Player submits answer
  socket.on("quiz:answer", async ({ userId, username, round, answer }) => {
    if (round !== currentRound) return;
    if (winnerDeclared) return;
    if (!currentQuestion) return;

    try {
      // ✅ Deduct 1 token
      let updatedUser = await gameService.useToken(
        new Types.ObjectId(userId),
        1
      );

      if (!updatedUser) {
        io.to(socket.id).emit("quiz:error", {
          message: "User not found or insufficient tokens",
        });
        return;
      }

      // Always send updated tokens after deduction
      io.to(socket.id).emit("quiz:userUpdate", {
        tokens: updatedUser.tokens,
        balance: updatedUser.balance,
      });

      const correctAnswer = currentQuestion.answer;
      if (answer.trim().toLowerCase() === correctAnswer.toLowerCase()) {
        winnerDeclared = true;

        // ✅ Reward user (get fresh doc back)
        updatedUser = await gameService.addBalance(
          new Types.ObjectId(userId),
          currentQuestion.reward_amount || 0
        );

        // ✅ Mark question answered
        await gameService.markAnswered(
          currentQuestion._id,
          new Types.ObjectId(userId)
        );

        // Broadcast winner
        io.emit("quiz:winner", {
          userId,
          username,
          round,
          correctAnswer,
          reward: currentQuestion.reward_amount || 0,
          message: `${username} won Round ${round}! 🎉`,
        });

        // Send winner updated balance/tokens
        io.to(socket.id).emit("quiz:userUpdate", {
          tokens: updatedUser!.tokens,
          balance: updatedUser!.balance,
        });

        console.log(`🏆 Winner: ${username} for round ${round}`);
      }
    } catch (error: any) {
      console.error("❌ Error in quiz:answer:", error.message);
      io.to(socket.id).emit("quiz:error", {
        message: "Not enough tokens or failed to process answer",
      });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u.socketId !== socket.id);
    console.log("❌ User disconnected:", socket.id);
    io.emit("players:update", onlineUsers);
  });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
  });
};

startServer();
