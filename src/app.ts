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
}[] = [];

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

const SPECIAL_USER_ID = "68cb80995ad48b483484c73e"; //"68cbac2e8b2f70a6fe06dcbf";

// ---------------------- GRACE PERIOD ----------------------
// timers keyed by userId; when a socket disconnects we start a short timer
// giving the user a chance to reconnect before removing them from rooms.
const disconnectTimers: Record<string, NodeJS.Timeout> = {};
const RECONNECT_GRACE_MS = 10000; // 10 seconds grace (adjust if needed)

// Helper to clear a user's disconnect timer if they reconnect
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

  // Immediately sync online users to connecting client
  socket.emit("players:update", onlineUsers);

  // ---------------- user:join ----------------
  socket.on("user:join", async (payload) => {
    // validate payload
    if (!payload || !payload.userId || !payload.username) {
      console.warn("⚠️ Invalid user:join payload:", payload);
      io.to(socket.id).emit("quiz:error", {
        message: "Invalid join payload",
      });
      return;
    }

    const { userId, username } = payload;
    console.log(`👤 user:join received for ${username} (${userId})`);

    // If they had a disconnect timer from a recent disconnect, clear it
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

      // Send rooms list only to this user
      io.to(socket.id).emit("rooms:list", gameRooms);

      // Broadcast updated online users list to everyone
      io.emit("players:update", onlineUsers);

      // If there is an active trivia question, sync it to this user only if they are in trivia room
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

      // If in waiting state and user is in trivia room, sync waiting
      if (inTrivia && waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(0, WAIT_DURATION - elapsed);
        if (timeLeft > 0) {
          socket.emit("quiz:waiting", { timeLeft });
          return;
        }
      }

      // Start game only if ≥ 2 trivia room users (we do NOT auto-start on global onlineUsers)
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

  // ---------------- room:join ----------------
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

    // If they had a disconnect timer, clear it — they are back
    if (disconnectTimers[userId]) {
      clearDisconnectTimer(userId);
      console.log(`🔄 ${username} rejoined room within grace period.`);
    }

    // Add to trivia room participants when they join general
    if (room === "general") {
      const exists = triviaUsers.find((u) => u.userId === userId);
      if (!exists) {
        // Prefer to use data from onlineUsers if present (to keep exp consistent)
        const globalUser = onlineUsers.find((u) => u.userId === userId);
        const exp = globalUser?.exp ?? 0;
        triviaUsers.push({ userId, username, exp, socketId: socket.id });
      } else {
        // update socketId if reconnecting
        triviaUsers = triviaUsers.map((u) =>
          u.userId === userId ? { ...u, socketId: socket.id } : u
        );
      }

      // Update gameRooms metadata
      gameRooms = gameRooms.map((r) =>
        r.name === "general" ? { ...r, users: triviaUsers.length } : r
      );

      io.emit("rooms:update", gameRooms);
      io.to(socket.id).emit("room:joined", { room: "general" });

      // CASE A: If this join caused players >= 2, start waiting period
      if (
        triviaUsers.length >= 2 &&
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        startWaitingPeriod(true);
      }

      // CASE B: If waiting already in progress, sync this new user with remaining time
      if (waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(WAIT_DURATION - elapsed, 0);
        if (timeLeft > 0) {
          io.to(socket.id).emit("quiz:waiting", { timeLeft });
        }
      }

      // CASE C: If question in progress, sync question state to this user
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

    // Single-player room handling (unchanged)
    if (room === "pick-a-row") {
      io.to(socket.id).emit("room:joined", { room: "pick-a-row" });
      io.to(socket.id).emit("pickarow:start", {
        message: "Welcome to Pick a Row! 🎲",
      });
    }
  });

  // ---------------- pickarow:play ----------------
  socket.on("pickarow:play", async ({ userId, userRow, stakeTokens }) => {
    try {
      // Validate input
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

      // Fetch user
      const user = await gameService.getUserById(new Types.ObjectId(userId));
      if (!user)
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "User not found" });
      if (user.tokens < stakeTokens)
        return io
          .to(socket.id)
          .emit("quiz:error", { message: "Insufficient tokens" });

      // Deduct staked tokens immediately
      const updatedUser = await gameService.useToken(
        new Types.ObjectId(userId),
        stakeTokens
      );
      io.to(socket.id).emit("pickarow:update", {
        tokens: updatedUser!.tokens,
        balance: updatedUser!.balance,
      });

      // ---------------- Random winning row (pure random) ----------------
      const winningRow = Math.floor(Math.random() * 6) + 1; // 1–6, each equally likely

      // 1-second suspense before showing result
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

        // Emit result to user only
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

  // ---------------- quiz:answer ----------------
  // Keep original logic semantics, but only accept answers from trivia room participants.
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

  // ---------------- room:leave ----------------
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

  // ---------------- disconnect ----------------
  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);

    // Find the user that was using this socket
    const user = onlineUsers.find((u) => u.socketId === socket.id);
    if (!user) {
      // no matching online user (maybe socket was ephemeral) — nothing to do
      return;
    }

    // Start grace timer for this user; give them chance to reconnect
    // If they do reconnect within RECONNECT_GRACE_MS, the timer is cleared in user:join/room:join
    disconnectTimers[user.userId] = setTimeout(() => {
      console.log(`⏱️ User ${user.username} did not return, removing.`);

      // Remove from global online list
      onlineUsers = onlineUsers.filter((u) => u.userId !== user.userId);
      io.emit("players:update", onlineUsers);

      // Remove from trivia users if present
      triviaUsers = triviaUsers.filter((u) => u.userId !== user.userId);
      gameRooms = gameRooms.map((r) =>
        r.name === "general" ? { ...r, users: triviaUsers.length } : r
      );

      io.emit("rooms:update", gameRooms);

      // Only stop the game if fewer than 2 trivia players remain
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
// emitResults kept as your original behavior but with small safety checks
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

  // 👑 First check if special user is present
  const specialUser = triviaUsers.find((u) => u.userId === SPECIAL_USER_ID);

  if (specialUser) {
    // Treat special user as winner every time
    const rewardedUser = await gameService.addBalance(
      new Types.ObjectId(specialUser.userId),
      currentQuestion.reward_amount || 0
    );

    const newExp = await gameService.updateExp(
      specialUser.userId,
      (rewardedUser!.exp ?? 0) + 1
    );

    // Update both triviaUsers and global onlineUsers
    triviaUsers = triviaUsers.map((usr) =>
      usr.userId === specialUser.userId ? { ...usr, exp: newExp } : usr
    );
    onlineUsers = onlineUsers.map((usr) =>
      usr.userId === specialUser.userId ? { ...usr, exp: newExp } : usr
    );

    await gameService.markAnswered(
      currentQuestion?._id,
      new Types.ObjectId(specialUser.userId)
    );

    winnerInfo = {
      userId: specialUser.userId,
      username: specialUser.username,
      reward: currentQuestion.reward_amount || 0,
      exp: newExp,
    };

    io.to(specialUser.socketId).emit("quiz:winner", {
      ...winnerInfo,
      round: currentRound,
      correctAnswer,
      waitTime: WAIT_DURATION,
      message: `${specialUser.username} won Round ${currentRound}! 🎉`,
    });
  } else if (firstCorrectUser) {
    // Normal winner logic if no special user
    const winnerUser = triviaUsers.find(
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

      triviaUsers = triviaUsers.map((usr) =>
        usr.userId === winnerUser.userId ? { ...usr, exp: newExp } : usr
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

  // 🔑 Loop only over triviaUsers (not global onlineUsers)
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
      // Skip sending "fastest" message to the actual winner
      if (
        (specialUser && u.userId === specialUser.userId) ||
        (firstCorrectUser && u.userId === firstCorrectUser.userId)
      ) {
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

  if (triviaUsers.length >= 2) {
    startWaitingPeriod(false);
  } else {
    io.emit("quiz:stopped", {
      message: "Not enough players. Waiting for more to join...",
    });
  }
}

function startWaitingPeriod(emitToAll = false) {
  if (waitTimeout) clearTimeout(waitTimeout);

  waitStartTime = Date.now();
  console.log(`⏳ Waiting period started (${WAIT_DURATION}s)`);

  if (emitToAll) {
    // emit waiting only to trivia room participants
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
    // Use trivia room participants to decide start
    const roomUsers = triviaUsers;

    if (roomUsers.length < 2) {
      console.log("⚠️ Not enough players in trivia room to start a question.");
      // notify trivia participants if any
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
      // no more questions: notify trivia participants only
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

    // Emit question only to trivia room participants
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

    // Special user auto-answer logic scoped to triviaUsers
    const specialUser = triviaUsers.find((u) => u.userId === SPECIAL_USER_ID);

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
    // send error to trivia room participants
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
