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

const QUESTION_DURATION = 30; // seconds to answer
const WAIT_DURATION = 30; // seconds before next round
let roundTimeout: NodeJS.Timeout | null = null;
let waitTimeout: NodeJS.Timeout | null = null;
let startingQuestion = false;

// track answers for the round
let submissions: { [userId: string]: string } = {};

/**
 * Socket handlers
 */
io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  // initial sync: send players list
  socket.emit("players:update", onlineUsers);

  // user joins
  socket.on("user:join", async ({ userId, username }) => {
    try {
      // fetch user exp (optional) — keep as you had it
      let exp = 0;
      try {
        const userDoc = await gameService.getUserById(
          new Types.ObjectId(userId)
        );
        exp = userDoc?.exp ?? 0;
      } catch (e) {
        // ignore failures to fetch exp — continue with 0
        console.warn("Could not fetch user exp:", e);
      }

      const exists = onlineUsers.find((u) => u.userId === userId);
      if (!exists) {
        onlineUsers.push({ userId, username, exp, socketId: socket.id });
      } else {
        onlineUsers = onlineUsers.map((u) =>
          u.userId === userId ? { ...u, socketId: socket.id, exp } : u
        );
      }

      console.log(
        "✅ Online users:",
        onlineUsers.map((u) => u.userId)
      );
      io.emit("players:update", onlineUsers);

      // SYNC LOGIC FOR LATE JOINERS / START
      // 1) If a question is active -> send the question with remaining time
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

      // 2) If a wait is currently running (started earlier and still counting) -> send remaining wait
      if (waitStartTime) {
        const elapsed = Math.floor((Date.now() - waitStartTime) / 1000);
        const timeLeft = Math.max(0, WAIT_DURATION - elapsed);

        // If timeLeft > 0, sync the late-joiner to the existing wait
        if (timeLeft > 0) {
          socket.emit("quiz:waiting", { timeLeft });
          return;
        }
        // if timeLeft <= 0, the wait has effectively expired; fall through to next checks
      }

      // 3) No question and no active wait -> if this join made players count exactly 2, start wait and EMIT it
      if (
        onlineUsers.length === 2 &&
        !waitTimeout &&
        !roundTimeout &&
        !currentQuestion
      ) {
        console.log(
          "⏳ Two players present after join; emitting quiz:waiting and starting wait."
        );
        startWaitingPeriod(true); // emitToAll = true
        return;
      }

      // else: nothing to emit; just updated players list
    } catch (err) {
      console.error("❌ Error in user:join:", err);
      io.to(socket.id).emit("quiz:error", { message: "Failed to join game" });
    }
  });

  // player submits answer
  socket.on("quiz:answer", async ({ userId, username, round, answer }) => {
    try {
      // basic guards
      if (round !== currentRound) return;
      if (winnerDeclared) return;
      if (!currentQuestion || !questionStartTime) return;

      const elapsed = Math.floor((Date.now() - questionStartTime) / 1000);
      if (elapsed >= QUESTION_DURATION) {
        // too late; ignore — final resolution will be sent on timeout
        return;
      }

      // deduct token etc (your gameService call)
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

      // store submission (do not reveal feedback now)
      submissions[userId] = answer.trim();

      // check if answer is correct -> immediate winner flow
      const correctAnswer = currentQuestion.answer;
      if (answer.trim().toLowerCase() === correctAnswer.toLowerCase()) {
        // winner found
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

        // update onlineUsers exp
        onlineUsers = onlineUsers.map((u) =>
          u.userId === userId ? { ...u, exp: newExp } : u
        );

        // mark answered in DB
        await gameService.markAnswered(
          currentQuestion._id,
          new Types.ObjectId(userId)
        );

        // emit to everyone winner payload including waitTime (BUT DO NOT emit quiz:waiting)
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

        // update players list
        io.emit("players:update", onlineUsers);

        // cleanup question timeout, reset currentQuestion, clear submissions
        if (roundTimeout) {
          clearTimeout(roundTimeout);
          roundTimeout = null;
        }
        currentQuestion = null;
        submissions = {};

        // start silent waiting in background (no quiz:waiting emit)
        startWaitingPeriod(false);
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
    console.log("❌ User disconnected:", socket.id);
    io.emit("players:update", onlineUsers);

    // 🚨 If only one player left, stop question/wait and notify
    if (onlineUsers.length < 2) {
      if (roundTimeout) {
        clearTimeout(roundTimeout);
        roundTimeout = null;
      }
      if (waitTimeout) {
        clearTimeout(waitTimeout);
        waitTimeout = null;
      }
      currentQuestion = null;
      submissions = {};
      questionStartTime = null;
      waitStartTime = null;
      winnerDeclared = false;

      io.emit("quiz:stopped", {
        message: "Not enough players. Waiting for more to join...",
      });
    }
  });
});

/**
 * Start waiting period before a question round
 */
function startWaitingPeriod(emitToAll = false) {
  if (waitTimeout) {
    clearTimeout(waitTimeout);
    waitTimeout = null;
  }

  waitStartTime = Date.now();

  if (emitToAll) {
    // when two players just became ready, let clients know the wait starts now
    io.emit("quiz:waiting", { timeLeft: WAIT_DURATION });
  }

  // run wait in background (no further emits required here if emitToAll=false)
  waitTimeout = setTimeout(() => {
    waitTimeout = null;
    waitStartTime = null;
    // start next question only when still enough players
    startNewQuestion().catch((err) => {
      console.error("startNewQuestion error after wait:", err);
    });
  }, WAIT_DURATION * 1000);
}
/**
 * Start new question round
 */
async function startNewQuestion() {
  if (startingQuestion) return;
  startingQuestion = true;

  try {
    if (onlineUsers.length < 2) {
      console.log("⏸️ Not enough players online. Waiting...");
      startingQuestion = false;
      return;
    }

    const q = await gameService.getAndUpdateQuestion();
    if (!q) {
      // no questions left -> broadcast end-of-game
      io.emit("quiz:end", { message: "No more questions available!" });
      startingQuestion = false;
      return;
    }

    winnerDeclared = false;
    currentRound++;
    currentQuestion = q;
    questionStartTime = Date.now();
    submissions = {};

    if (roundTimeout) {
      clearTimeout(roundTimeout);
      roundTimeout = null;
    }

    // emit the question to everyone once, with answer-time duration
    io.emit("quiz:question", {
      round: currentRound,
      questionId: q._id,
      title: q.question,
      category: q.category,
      difficulty: q.difficulty,
      reward_amount: q.reward_amount,
      timeLeft: QUESTION_DURATION,
    });

    console.log(`📢 Round ${currentRound} started (question id=${q._id})`);

    // set a single timeout for the question duration
    roundTimeout = setTimeout(() => {
      roundTimeout = null;

      // if nobody already won, evaluate submissions and emit per-user quiz:end with waitTime
      if (!winnerDeclared && currentQuestion) {
        onlineUsers.forEach((u) => {
          const submitted = submissions[u.userId];
          if (!submitted) {
            // user didn't submit
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
            // user submitted but wrong
            io.to(u.socketId).emit("quiz:end", {
              round: currentRound,
              correctAnswer: currentQuestion.answer,
              waitTime: WAIT_DURATION,
              message: "❌ Wrong answer!",
            });
          } else {
            // if someone submitted correct exactly on timeout edge (rare), treat as winner would have been handled earlier
            // But we've guarded winnerDeclared above.
          }
        });

        currentQuestion = null;
        submissions = {};

        // start wait in background WITHOUT emitting quiz:waiting to everyone
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
