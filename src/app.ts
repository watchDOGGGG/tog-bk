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
app.get("/getTokenAndBalance/:user_id", controller.getTokenAndBalance);
app.post("/withdraw", controller.withdrawRequest);
app.post("/purchase-with-balance", controller.purchaseTokensWithBalance);
app.get("/fetchQuestion", controller.generateQuestions);

let onlineUsers: {
  userId: string;
  username: string;
  exp: number;
  socketId: string;
  isBot?: boolean;
}[] = [
  {
    userId: "650f2c5b9d1a4e12c4f1a01d",
    username: "William",
    exp: 97,
    socketId: "i3j4k5l6",
    isBot: true,
  },
  {
    userId: "650f2c5b9d1a4e12c4f1a01e",
    username: "Aria",
    exp: 31,
    socketId: "m7n8o9p0",
    isBot: true,
  },
];

let currentRound = 0;
let currentQuestion: any = null;
let winnerDeclared = false;
let questionStartTime: number | null = null;
let waitStartTime: number | null = null;

const QUESTION_DURATION = 30; // seconds
const WAIT_DURATION = 30; // seconds
let roundTimeout: NodeJS.Timeout | null = null;
let waitTimeout: NodeJS.Timeout | null = null;
let startingQuestion = false;

let submissions: { [userId: string]: string } = {};

/**
 * SOCKET HANDLERS
 */
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  // Send players list
  socket.emit("players:update", onlineUsers);

  /**
   * Player joins
   */
  socket.on("user:join", async ({ userId, username }) => {
    console.log(`👤 user:join received for ${username} (${userId})`);

    try {
      // Fetch exp
      let exp = 0;
      try {
        const userDoc = await gameService.getUserById(
          new Types.ObjectId(userId)
        );
        exp = userDoc?.exp ?? 0;
      } catch (e) {
        console.warn("Could not fetch user exp:", e);
      }

      // Add/update online user
      const exists = onlineUsers.find((u) => u.userId === userId);
      if (!exists) {
        console.log(`➕ Adding new user ${username}`);
        onlineUsers.push({ userId, username, exp, socketId: socket.id });
      } else {
        console.log(`🔄 Updating user ${username}`);
        onlineUsers = onlineUsers.map((u) =>
          u.userId === userId ? { ...u, socketId: socket.id, exp } : u
        );
      }

      console.log("✅ Current online users:", onlineUsers);

      io.emit("players:update", onlineUsers);

      // CASE 1: If question is active → sync question
      if (currentQuestion && questionStartTime) {
        const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
        const timeLeft = Math.max(0, QUESTION_DURATION - elapsed);

        socket.emit("quiz:question", {
          round: currentRound,
          questionId: currentQuestion._id,
          title: currentQuestion.question,
          category: currentQuestion.category,
          difficulty: currentQuestion.difficulty,
          reward_amount: currentQuestion.reward_amount,
          timeLeft,
        });
        return;
      }

      // CASE 2: If waiting → sync waiting
      if (waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(0, WAIT_DURATION - elapsed);
        if (timeLeft > 0) {
          socket.emit("quiz:waiting", { timeLeft });
          return;
        }
      }

      // CASE 3: If no game is running and this is the FIRST real user → start wait
      const realUsers = onlineUsers.filter((u) => !u.isBot);
      if (
        realUsers.length === 1 && // first real user joined
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        console.log("🚀 First real user joined. Starting waiting period...");
        startWaitingPeriod(true);
        return;
      }

      console.log("ℹ️ No active game state to sync for this join.");
    } catch (err) {
      console.error("❌ Error in user:join:", err);
      io.to(socket.id).emit("quiz:error", { message: "Failed to join game" });
    }
  });

  /**
   * Player answers
   */
  socket.on("quiz:answer", async ({ userId, username, round, answer }) => {
    try {
      if (round !== currentRound) return;
      if (winnerDeclared) return;
      if (!currentQuestion || !questionStartTime) return;

      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      if (elapsed >= QUESTION_DURATION) return;

      // consume token
      const updatedUser = await gameService.useToken(
        new Types.ObjectId(userId),
        1
      );
      if (!updatedUser) {
        io.to(socket.id).emit("quiz:error", {
          message: "User not found or insufficient tokens",
        });
        return;
      }

      io.to(socket.id).emit("quiz:userUpdate", {
        tokens: updatedUser.tokens,
        balance: updatedUser.balance,
        exp: updatedUser.exp,
      });

      submissions[userId] = answer.trim();

      // check if correct
      const correctAnswer = currentQuestion.answer;
      if (answer.trim().toLowerCase() === correctAnswer.toLowerCase()) {
        winnerDeclared = true;

        // reward
        const rewardedUser = await gameService.addBalance(
          new Types.ObjectId(userId),
          currentQuestion.reward_amount || 0
        );
        const newExp = await gameService.updateExp(
          userId,
          (rewardedUser!.exp ?? 0) + 1
        );

        onlineUsers = onlineUsers.map((u) =>
          u.userId === userId ? { ...u, exp: newExp } : u
        );

        await gameService.markAnswered(
          currentQuestion._id,
          new Types.ObjectId(userId)
        );

        io.emit("quiz:winner", {
          userId,
          username,
          round: currentRound,
          correctAnswer,
          reward: currentQuestion.reward_amount || 0,
          exp: newExp,
          waitTime: WAIT_DURATION,
          message: `${username} won Round ${currentRound}! 🎉`,
        });

        io.emit("players:update", onlineUsers);

        if (roundTimeout) {
          clearTimeout(roundTimeout);
          roundTimeout = null;
        }
        currentQuestion = null;
        submissions = {};

        startWaitingPeriod(false); // silent wait
      }
    } catch (err) {
      console.error("❌ Error in quiz:answer:", err);
      io.to(socket.id).emit("quiz:error", {
        message: "Failed to submit answer",
      });
    }
  });

  /**
   * Disconnect
   */
  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u.socketId !== socket.id);
    io.emit("players:update", onlineUsers);

    const realUsers = onlineUsers.filter((u) => !u.isBot);

    if (realUsers.length < 1) {
      if (roundTimeout) clearTimeout(roundTimeout);
      if (waitTimeout) clearTimeout(waitTimeout);
      roundTimeout = null;
      waitTimeout = null;
      currentQuestion = null;
      submissions = {};
      questionStartTime = null;
      waitStartTime = null;
      winnerDeclared = false;

      io.emit("quiz:stopped", {
        message: "Not enough real players. Waiting for more to join...",
      });
    }
  });
});

/**
 * HELPERS
 */
function startWaitingPeriod(emitToAll = false) {
  if (waitTimeout) clearTimeout(waitTimeout);

  waitStartTime = Date.now();

  if (emitToAll) {
    io.emit("quiz:waiting", { timeLeft: WAIT_DURATION });
  }

  waitTimeout = setTimeout(() => {
    waitTimeout = null;
    waitStartTime = null;
    startNewQuestion().catch((err) =>
      console.error("startNewQuestion error:", err)
    );
  }, WAIT_DURATION * 1000);
}

async function startNewQuestion() {
  if (startingQuestion) return;
  startingQuestion = true;

  try {
    const realUsers = onlineUsers.filter((u) => !u.isBot);
    if (realUsers.length < 1) {
      startingQuestion = false;
      return;
    }

    const q = await gameService.getAndUpdateQuestion();
    if (!q) {
      io.emit("quiz:end", { message: "No more questions available!" });
      startingQuestion = false;
      return;
    }

    winnerDeclared = false;
    currentRound++;
    currentQuestion = q;
    questionStartTime = Date.now();
    submissions = {};

    io.emit("quiz:question", {
      round: currentRound,
      questionId: q._id,
      title: q.question,
      category: q.category,
      difficulty: q.difficulty,
      reward_amount: q.reward_amount,
      timeLeft: QUESTION_DURATION,
    });

    if (roundTimeout) clearTimeout(roundTimeout);

    roundTimeout = setTimeout(() => {
      roundTimeout = null;

      if (!winnerDeclared && currentQuestion) {
        onlineUsers.forEach((u) => {
          const submitted = submissions[u.userId];
          if (!submitted) {
            io.to(u.socketId).emit("quiz:end", {
              round: currentRound,
              correctAnswer: currentQuestion.answer,
              waitTime: WAIT_DURATION,
              message: "⏰ No response submitted.",
            });
          } else if (
            submitted.trim().toLowerCase() !==
            currentQuestion.answer.toLowerCase()
          ) {
            io.to(u.socketId).emit("quiz:end", {
              round: currentRound,
              correctAnswer: currentQuestion.answer,
              waitTime: WAIT_DURATION,
              message: "❌ Wrong answer!",
            });
          }
        });

        currentQuestion = null;
        submissions = {};

        startWaitingPeriod(false);
      }
    }, QUESTION_DURATION * 1000);
  } catch (err) {
    console.error("❌ Error in startNewQuestion:", err);
    io.emit("quiz:error", { message: "Failed to fetch question" });
  } finally {
    startingQuestion = false;
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
