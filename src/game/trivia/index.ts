import { Server } from "socket.io";
import { initTriviaSockets } from "./triviaGame";

export const initTriviaGame = (io: Server) => {
  console.log("🎮 Initializing Trivia Game...");
  initTriviaSockets(io);
};
