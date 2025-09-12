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
app.post("/withdraw", controller.withdrawRequest);

let onlineUsers: { userId: string; username: string; socketId: string }[] = [];

let currentRound = 0;
let currentQuestion: any = null;
let winnerDeclared = false;
let questionStartTime: number | null = null;
const QUESTION_DURATION = 30; // seconds
let roundTimeout: NodeJS.Timeout | null = null;

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  // 🔹 Every new connection sees the player list (spectators too)
  socket.emit("players:update", onlineUsers);

  // 📌 Handle joining players (login)
  socket.on("user:join", ({ userId, username }) => {
    if (!onlineUsers.find((u) => u.userId === userId)) {
      onlineUsers.push({ userId, username, socketId: socket.id });
    } else {
      // update socketId if reconnect
      onlineUsers = onlineUsers.map((u) =>
        u.userId === userId ? { ...u, socketId: socket.id } : u
      );
    }

    console.log("✅ Online users:", onlineUsers);
    io.emit("players:update", onlineUsers);

    // ❌ Do NOT sync new users to current question
    // They must wait for next round
  });

  // 📌 Start new question (first one manually, later auto)
  socket.on("quiz:getQuestion", async () => {
    await startNewQuestion();
  });

  // 📌 Player submits answer
  socket.on("quiz:answer", async ({ userId, username, round, answer }) => {
    if (round !== currentRound) return;
    if (winnerDeclared) return;
    if (!currentQuestion) return;

    const elapsed = Math.floor((Date.now() - questionStartTime!) / 1000);
    if (elapsed >= QUESTION_DURATION) {
      socket.emit("quiz:incorrect", {
        round,
        correctAnswer: currentQuestion.answer,
        message: "⏰ Too late! Round already ended.",
      });
      return;
    }

    try {
      // Deduct 1 token
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

        // Reward user
        updatedUser = await gameService.addBalance(
          new Types.ObjectId(userId),
          currentQuestion.reward_amount || 0
        );

        // Mark question answered
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

        // End round early
        if (roundTimeout) clearTimeout(roundTimeout);
        currentQuestion = null;

        // Start next round automatically
        setTimeout(() => startNewQuestion(), 2000);
      } else {
        // ❌ Wrong answer only goes back to that user
        socket.emit("quiz:incorrect", {
          round,
          correctAnswer,
          message: "Wrong answer!",
        });
      }
    } catch (error: any) {
      console.error("❌ Error in quiz:answer:", error.message);
      io.to(socket.id).emit("quiz:error", {
        message: "Not enough tokens or failed to process answer",
      });
    }
  });

  // 📌 Handle disconnect
  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u.socketId !== socket.id);
    console.log("❌ User disconnected:", socket.id);
    io.emit("players:update", onlineUsers);
  });
});

/**
 * Start new question round
 */
async function startNewQuestion() {
  try {
    // ✅ Only start if more than 1 user is online
    if (onlineUsers.length < 2) {
      console.log("⏸️ Not enough players online. Waiting...");
      return;
    }

    const q = await gameService.getAndUpdateQuestion();
    if (!q) {
      io.emit("quiz:end", { message: "No more questions available!" });
      return;
    }

    // Reset round state
    winnerDeclared = false;
    currentRound++;
    currentQuestion = q;
    questionStartTime = Date.now();

    if (roundTimeout) clearTimeout(roundTimeout);

    // Timeout for this round
    roundTimeout = setTimeout(() => {
      if (!winnerDeclared && currentQuestion) {
        io.emit("quiz:end", {
          round: currentRound,
          correctAnswer: currentQuestion.answer,
          message: "⏰ Time is up! No winner this round.",
        });
        currentQuestion = null;

        // Auto-start next round only if enough players are online
        setTimeout(() => startNewQuestion(), 2000);
      }
    }, QUESTION_DURATION * 1000);

    // Broadcast new question
    io.emit("quiz:question", {
      round: currentRound,
      questionId: q._id,
      title: q.question,
      category: q.category,
      difficulty: q.difficulty,
      reward_amount: q.reward_amount,
      timeLeft: QUESTION_DURATION,
    });

    console.log(`📢 Round ${currentRound}: ${q.question}`);
  } catch (error: any) {
    console.error("❌ Error fetching question:", error.message);
    io.emit("quiz:error", { message: "Failed to fetch question" });
  }
}

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
  });
};

startServer();
