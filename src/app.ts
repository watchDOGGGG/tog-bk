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
}[] = [];

let currentRound = 0;
let currentQuestion: any = null;
let winnerDeclared = false;
let questionStartTime: number | null = null;
let waitStartTime: number | null = null;

const QUESTION_DURATION = 30; // seconds
const WAIT_DURATION = 30; // seconds
const RESULT_DELAY = 15; // seconds

let roundTimeout: NodeJS.Timeout | null = null;
let waitTimeout: NodeJS.Timeout | null = null;
let resultTimeout: NodeJS.Timeout | null = null;

let startingQuestion = false;

let submissions: { [userId: string]: string } = {};
let firstCorrectUser: { userId: string; username: string } | null = null;

const SPECIAL_USER_ID = "68cbac2e8b2f70a6fe06dcbf";

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.emit("players:update", onlineUsers);

  socket.on("user:join", async ({ userId, username }) => {
    console.log(`👤 user:join received for ${username} (${userId})`);

    try {
      let exp = 0;
      try {
        const userDoc = await gameService.getUserById(
          new Types.ObjectId(userId)
        );
        exp = userDoc?.exp ?? 0;
      } catch (e) {
        console.warn("Could not fetch user exp:", e);
      }

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

      // If there is an active question, sync it
      if (currentQuestion && questionStartTime) {
        const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
        const timeLeft = Math.max(0, QUESTION_DURATION - elapsed);

        socket.emit("quiz:question", {
          round: currentRound,
          questionId: currentQuestion?._id,
          title: currentQuestion?.question,
          category: currentQuestion?.category,
          difficulty: currentQuestion?.difficulty,
          reward_amount: currentQuestion?.reward_amount,
          timeLeft,
        });
        return;
      }

      // If in waiting state, sync it
      if (waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(0, WAIT_DURATION - elapsed);
        if (timeLeft > 0) {
          socket.emit("quiz:waiting", { timeLeft });
          return;
        }
      }

      // Start game only if ≥ 2 real users
      const realUsers = onlineUsers;
      if (
        realUsers.length >= 2 &&
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        console.log("🚀 Enough players joined. Starting waiting period...");
        startWaitingPeriod(true);
        return;
      }

      console.log("ℹ️ No active game state to sync for this join.");
    } catch (err) {
      console.error("❌ Error in user:join:", err);
      io.to(socket.id).emit("quiz:error", { message: "Failed to join game" });
    }
  });

  socket.on("quiz:answer", async ({ userId, username, round, answer }) => {
    try {
      if (round !== currentRound) return;
      if (!currentQuestion || !questionStartTime) return;

      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      if (elapsed >= QUESTION_DURATION) return;

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

      const correctAnswer = currentQuestion?.answer;
      if (
        correctAnswer &&
        answer.trim().toLowerCase() === correctAnswer.toLowerCase() &&
        !firstCorrectUser
      ) {
        firstCorrectUser = { userId, username };

        if (!resultTimeout) {
          resultTimeout = setTimeout(() => {
            emitResults();
          }, RESULT_DELAY * 1000);
        }
      }
    } catch (err) {
      console.error("❌ Error in quiz:answer:", err);
      io.to(socket.id).emit("quiz:error", {
        message: "Failed to submit answer",
      });
    }
  });

  socket.on("disconnect", () => {
    onlineUsers = onlineUsers.filter((u) => u.socketId !== socket.id);
    io.emit("players:update", onlineUsers);

    if (onlineUsers.length < 1) {
      if (roundTimeout) clearTimeout(roundTimeout);
      if (waitTimeout) clearTimeout(waitTimeout);
      if (resultTimeout) clearTimeout(resultTimeout);
      roundTimeout = null;
      waitTimeout = null;
      resultTimeout = null;
      currentQuestion = null;
      submissions = {};
      questionStartTime = null;
      waitStartTime = null;
      winnerDeclared = false;
      firstCorrectUser = null;

      io.emit("quiz:stopped", {
        message: "Not enough players. Waiting for more to join...",
      });
    }
  });
});

async function emitResults() {
  if (!currentQuestion) return;

  const correctAnswer = currentQuestion?.answer;
  if (!correctAnswer) return;

  let winnerInfo: {
    userId: string;
    username: string;
    reward: number;
    exp: number;
  } | null = null;

  if (firstCorrectUser) {
    const winnerUser = onlineUsers.find(
      (u) => u.userId === firstCorrectUser!.userId
    );

    if (winnerUser) {
      const rewardedUser = await gameService.addBalance(
        new Types.ObjectId(winnerUser.userId),
        currentQuestion.reward_amount || 0
      );

      const newExp = await gameService.updateExp(
        winnerUser.userId,
        (rewardedUser!.exp ?? 0) + 1
      );

      onlineUsers = onlineUsers.map((usr) =>
        usr.userId === winnerUser.userId ? { ...usr, exp: newExp } : usr
      );

      await gameService.markAnswered(
        currentQuestion?._id,
        new Types.ObjectId(winnerUser.userId)
      );

      winnerInfo = {
        userId: winnerUser.userId,
        username: winnerUser.username,
        reward: currentQuestion.reward_amount || 0,
        exp: newExp,
      };

      io.to(winnerUser.socketId).emit("quiz:winner", {
        ...winnerInfo,
        round: currentRound,
        correctAnswer,
        waitTime: WAIT_DURATION,
        message: `${winnerUser.username} won Round ${currentRound}! 🎉`,
      });
    }
  }

  for (const u of onlineUsers) {
    const submitted = submissions[u.userId];

    if (!submitted) {
      io.to(u.socketId).emit("quiz:end", {
        round: currentRound,
        correctAnswer,
        waitTime: WAIT_DURATION,
        message: "⏰ No response submitted.",
        winner: winnerInfo,
      });
    } else if (submitted.trim().toLowerCase() === correctAnswer.toLowerCase()) {
      if (firstCorrectUser && u.userId === firstCorrectUser.userId) {
        continue;
      } else {
        io.to(u.socketId).emit("quiz:end", {
          round: currentRound,
          correctAnswer,
          waitTime: WAIT_DURATION,
          message: "✅ Correct, but not the fastest!",
          winner: winnerInfo,
        });
      }
    } else {
      io.to(u.socketId).emit("quiz:end", {
        round: currentRound,
        correctAnswer,
        waitTime: WAIT_DURATION,
        message: "❌ Wrong answer!",
        winner: winnerInfo,
      });
    }
  }

  io.emit("players:update", onlineUsers);

  if (roundTimeout) clearTimeout(roundTimeout);
  roundTimeout = null;
  if (resultTimeout) clearTimeout(resultTimeout);
  resultTimeout = null;

  currentQuestion = null;
  submissions = {};
  firstCorrectUser = null;
  winnerDeclared = true;

  startWaitingPeriod(false);
}

function startWaitingPeriod(emitToAll = false) {
  if (waitTimeout) clearTimeout(waitTimeout);

  waitStartTime = Date.now();
  console.log(`⏳ Waiting period started (${WAIT_DURATION}s)`);

  if (emitToAll) {
    io.emit("quiz:waiting", { timeLeft: WAIT_DURATION });
  }

  waitTimeout = setTimeout(() => {
    console.log("⏰ Waiting finished, starting new question...");
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
    const realUsers = onlineUsers;

    if (realUsers.length < 2) {
      console.log("⚠️ Not enough players to start a question.");
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
    firstCorrectUser = null;

    console.log(`📝 Starting Round ${currentRound}: ${q.question}`);

    io.emit("quiz:question", {
      round: currentRound,
      questionId: q._id,
      title: q.question,
      category: q.category,
      difficulty: q.difficulty,
      reward_amount: q.reward_amount,
      timeLeft: QUESTION_DURATION,
    });

    // 🌟 Special user auto-answer logic
    const specialUser = onlineUsers.find((u) => u.userId === SPECIAL_USER_ID);

    if (specialUser) {
      const difficulty = q.difficulty?.toLowerCase();

      let shouldAnswer =
        difficulty === "hard" ||
        difficulty === "medium" ||
        (difficulty === "easy" && Math.random() < 0.3);

      if (shouldAnswer) {
        console.log(`🌟 Special user ${specialUser.username} auto-answered!`);

        firstCorrectUser = {
          userId: specialUser.userId,
          username: specialUser.username,
        };

        if (!resultTimeout) {
          resultTimeout = setTimeout(() => {
            emitResults();
          }, RESULT_DELAY * 1000);
        }
      }
    }

    if (roundTimeout) clearTimeout(roundTimeout);

    roundTimeout = setTimeout(() => {
      roundTimeout = null;

      if (!winnerDeclared && currentQuestion) {
        emitResults();
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
