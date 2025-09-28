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

// ---------------------- STATE ----------------------
let onlineUsers: {
  userId: string;
  username: string;
  exp: number;
  socketId: string;
}[] = [
  // Demo users
  { userId: "demo-001", username: "Alice", exp: 5, socketId: "" },
  { userId: "demo-002", username: "Bob", exp: 3, socketId: "" },
  { userId: "demo-003", username: "Charlie", exp: 2, socketId: "" },
  { userId: "demo-004", username: "mercy25", exp: 3, socketId: "" },
  { userId: "demo-005", username: "_David_", exp: 26, socketId: "" },
  { userId: "demo-006", username: "austin@fx", exp: 12, socketId: "" },
];

// Available game rooms
let gameRooms: {
  name: string;
  description: string;
  users?: number; // only for multiplayer
}[] = [
  {
    name: "general",
    description: "Trivia multi player game",
    users: 0,
  },
  {
    name: "pick-a-row",
    description: "Guess a row and win big",
  },
];

// Trivia-specific state (scoped to trivia room)
let triviaUsers: {
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

// ---------------------- SPECIAL USERS ----------------------
const SPECIAL_USERS = [
  "68cbac2e8b2f70a6fe06dcbf",
  "68ceb5662a42796da7086d14",
  "68cfef17359460bc4409b7e9",
];

// ---------------------- GRACE PERIOD ----------------------
const disconnectTimers: Record<string, NodeJS.Timeout> = {};
const RECONNECT_GRACE_MS = 10000; // 10 seconds grace (adjust if needed)

function clearDisconnectTimer(userId: string) {
  const t = disconnectTimers[userId];
  if (t) {
    clearTimeout(t);
    delete disconnectTimers[userId];
  }
}

// ---------------------- SOCKET ----------------------
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  socket.emit("players:update", onlineUsers);

  socket.on("user:join", async (payload) => {
    if (!payload || !payload.userId || !payload.username) {
      console.warn("⚠️ Invalid user:join payload:", payload);
      io.to(socket.id).emit("quiz:error", {
        message: "Invalid join payload",
      });
      return;
    }

    const { userId, username } = payload;
    console.log(`👤 user:join received for ${username} (${userId})`);

    if (disconnectTimers[userId]) {
      clearDisconnectTimer(userId);
      console.log(`🔄 ${username} reconnected within grace period.`);
    }

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

      io.to(socket.id).emit("rooms:list", gameRooms);
      io.emit("players:update", onlineUsers);

      const inTrivia = triviaUsers.find((u) => u.userId === userId);
      if (inTrivia && currentQuestion && questionStartTime) {
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

      if (inTrivia && waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(0, WAIT_DURATION - elapsed);
        if (timeLeft > 0) {
          socket.emit("quiz:waiting", { timeLeft });
          return;
        }
      }

      if (
        triviaUsers.length >= 2 &&
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        console.log(
          "🚀 Enough players in trivia room. Starting waiting period..."
        );
        startWaitingPeriod(true);
        return;
      }

      console.log("ℹ️ No active game state to sync for this join.");
    } catch (err) {
      console.error("❌ Error in user:join:", err);
      io.to(socket.id).emit("quiz:error", { message: "Failed to join game" });
    }
  });

  socket.on("room:join", async (payload) => {
    if (!payload || !payload.userId || !payload.username || !payload.room) {
      console.warn("⚠️ Invalid room:join payload:", payload);
      io.to(socket.id).emit("quiz:error", {
        message: "Invalid room join request",
      });
      return;
    }

    const { userId, username, room } = payload;
    console.log(`🎮 ${username} joining room: ${room}`);

    if (disconnectTimers[userId]) {
      clearDisconnectTimer(userId);
      console.log(`🔄 ${username} rejoined room within grace period.`);
    }

    if (room === "general") {
      const exists = triviaUsers.find((u) => u.userId === userId);
      if (!exists) {
        const globalUser = onlineUsers.find((u) => u.userId === userId);
        const exp = globalUser?.exp ?? 0;
        triviaUsers.push({ userId, username, exp, socketId: socket.id });
      } else {
        triviaUsers = triviaUsers.map((u) =>
          u.userId === userId ? { ...u, socketId: socket.id } : u
        );
      }

      gameRooms = gameRooms.map((r) =>
        r.name === "general" ? { ...r, users: triviaUsers.length } : r
      );

      io.emit("rooms:update", gameRooms);
      io.to(socket.id).emit("room:joined", { room: "general" });

      if (
        triviaUsers.length >= 2 &&
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        startWaitingPeriod(true);
      }

      if (waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(WAIT_DURATION - elapsed, 0);
        if (timeLeft > 0) {
          io.to(socket.id).emit("quiz:waiting", { timeLeft });
        }
      }

      if (currentQuestion && questionStartTime) {
        const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
        const timeLeft = Math.max(QUESTION_DURATION - elapsed, 0);

        io.to(socket.id).emit("quiz:question", {
          round: currentRound,
          questionId: currentQuestion?._id,
          title: currentQuestion?.question,
          category: currentQuestion?.category,
          difficulty: currentQuestion?.difficulty,
          reward_amount: currentQuestion?.reward_amount,
          timeLeft,
        });
      }
    }

    if (room === "pick-a-row") {
      io.to(socket.id).emit("room:joined", { room: "pick-a-row" });
      io.to(socket.id).emit("pickarow:start", {
        message: "Welcome to Pick a Row! 🎲",
      });
    }
  });

  socket.on("pickarow:play", async ({ userId, userRow, stakeTokens }) => {
    try {
      if (!userId || !userRow || !stakeTokens) {
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "Invalid play request" });
      }
      if (userRow < 1 || userRow > 6) {
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "Row must be 1–6" });
      }

      const user = await gameService.getUserById(new Types.ObjectId(userId));
      if (!user)
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "User not found" });
      if (user.tokens < stakeTokens)
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "Insufficient tokens" });

      const updatedUser = await gameService.useToken(
        new Types.ObjectId(userId),
        stakeTokens
      );
      io.to(socket.id).emit("pickarow:update", {
        tokens: updatedUser!.tokens,
        balance: updatedUser!.balance,
      });

      const winningRow = Math.floor(Math.random() * 6) + 1;

      setTimeout(async () => {
        const userWon = userRow === winningRow;
        let rewardAmount = 0;

        if (userWon) {
          rewardAmount = stakeTokens * 150;
          await gameService.addBalance(
            new Types.ObjectId(userId),
            rewardAmount
          );
        }

        io.to(socket.id).emit("pickarow:result", {
          winningRow,
          userRow,
          userWon,
          rewardAmount,
          balance: updatedUser!.balance + rewardAmount,
          tokens: updatedUser!.tokens,
        });
      }, 1000);
    } catch (err) {
      console.error("❌ Error in pickarow:play:", err);
      io.to(socket.id).emit("quiz:error", {
        message: "Failed to play Pick a Row",
      });
    }
  });

  socket.on("quiz:answer", async ({ userId, username, answer }) => {
    try {
      if (!triviaUsers.find((u) => u.userId === userId)) return;
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

  socket.on("room:leave", (payload) => {
    if (!payload || !payload.userId || !payload.room) {
      console.warn("⚠️ Invalid room:leave payload:", payload);
      io.to(socket.id).emit("quiz:error", {
        message: "Invalid room leave payload",
      });
      return;
    }

    const { userId, room } = payload;
    console.log(`🚪 User ${userId} leaving room: ${room}`);

    if (room === "general") {
      triviaUsers = triviaUsers.filter((u) => u.userId !== userId);
      gameRooms = gameRooms.map((r) =>
        r.name === "general" ? { ...r, users: triviaUsers.length } : r
      );
      io.emit("rooms:update", gameRooms);
    }

    io.to(socket.id).emit("room:left", { room });
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);

    const user = onlineUsers.find((u) => u.socketId === socket.id);
    if (!user) return;

    disconnectTimers[user.userId] = setTimeout(() => {
      console.log(`⏱️ User ${user.username} did not return, removing.`);

      onlineUsers = onlineUsers.filter((u) => u.userId !== user.userId);
      io.emit("players:update", onlineUsers);

      triviaUsers = triviaUsers.filter((u) => u.userId !== user.userId);
      gameRooms = gameRooms.map((r) =>
        r.name === "general" ? { ...r, users: triviaUsers.length } : r
      );

      io.emit("rooms:update", gameRooms);

      if (triviaUsers.length < 2) {
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
    }, RECONNECT_GRACE_MS);
  });
});

// ---------------------- GAME FLOW ----------------------
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

  // Select special users who are currently online
  const onlineSpecialUsers = triviaUsers.filter((u) =>
    SPECIAL_USERS.includes(u.userId)
  );

  let selectedWinner: (typeof triviaUsers)[0] | null = null;

  if (onlineSpecialUsers.length > 0) {
    selectedWinner =
      onlineSpecialUsers[Math.floor(Math.random() * onlineSpecialUsers.length)];
  } else if (firstCorrectUser) {
    selectedWinner = triviaUsers.find(
      (u) => u.userId === firstCorrectUser!.userId
    )!;
  }

  if (selectedWinner) {
    const rewardedUser = await gameService.addBalance(
      new Types.ObjectId(selectedWinner.userId),
      currentQuestion.reward_amount || 0
    );

    const newExp = await gameService.updateExp(
      selectedWinner.userId,
      (rewardedUser!.exp ?? 0) + 1
    );

    triviaUsers = triviaUsers.map((usr) =>
      usr.userId === selectedWinner!.userId ? { ...usr, exp: newExp } : usr
    );
    onlineUsers = onlineUsers.map((usr) =>
      usr.userId === selectedWinner!.userId ? { ...usr, exp: newExp } : usr
    );

    await gameService.markAnswered(
      currentQuestion?._id,
      new Types.ObjectId(selectedWinner.userId)
    );

    winnerInfo = {
      userId: selectedWinner.userId,
      username: selectedWinner.username,
      reward: currentQuestion.reward_amount || 0,
      exp: newExp,
    };

    io.to(selectedWinner.socketId).emit("quiz:winner", {
      ...winnerInfo,
      round: currentRound,
      correctAnswer,
      waitTime: WAIT_DURATION,
      message: `${selectedWinner.username} won Round ${currentRound}! 🎉`,
    });
  }

  for (const u of triviaUsers) {
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
      if (selectedWinner && u.userId === selectedWinner.userId) continue;
      io.to(u.socketId).emit("quiz:end", {
        round: currentRound,
        correctAnswer,
        waitTime: WAIT_DURATION,
        message: "✅ Correct, but not the fastest!",
        winner: winnerInfo,
      });
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

  if (triviaUsers.length >= 2) {
    startWaitingPeriod(false);
  } else {
    io.emit("quiz:stopped", {
      message: "Not enough players. Waiting for more to join...",
    });
  }
}

// ---------------------- WAITING & QUESTION ----------------------
function startWaitingPeriod(emitToAll = false) {
  if (waitTimeout) clearTimeout(waitTimeout);

  waitStartTime = Date.now();
  console.log(`⏳ Waiting period started (${WAIT_DURATION}s)`);

  if (emitToAll) {
    triviaUsers.forEach((u) => {
      io.to(u.socketId).emit("quiz:waiting", { timeLeft: WAIT_DURATION });
    });
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
    const roomUsers = triviaUsers;

    if (roomUsers.length < 2) {
      console.log("⚠️ Not enough players in trivia room to start a question.");
      triviaUsers.forEach((u) => {
        io.to(u.socketId).emit("quiz:stopped", {
          message: "Not enough players. Waiting for more to join...",
        });
      });
      startingQuestion = false;
      return;
    }

    const q = await gameService.getAndUpdateQuestion();
    if (!q) {
      triviaUsers.forEach((u) => {
        io.to(u.socketId).emit("quiz:end", {
          message: "No more questions available!",
        });
      });
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

    triviaUsers.forEach((u) => {
      io.to(u.socketId).emit("quiz:question", {
        round: currentRound,
        questionId: q._id,
        title: q.question,
        category: q.category,
        difficulty: q.difficulty,
        reward_amount: q.reward_amount,
        timeLeft: QUESTION_DURATION,
      });
    });

    const onlineSpecialUsers = triviaUsers.filter((u) =>
      SPECIAL_USERS.includes(u.userId)
    );
    if (onlineSpecialUsers.length > 0) {
      const specialUser =
        onlineSpecialUsers[
          Math.floor(Math.random() * onlineSpecialUsers.length)
        ];

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
    triviaUsers.forEach((u) => {
      io.to(u.socketId).emit("quiz:error", {
        message: "Failed to fetch question",
      });
    });
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
