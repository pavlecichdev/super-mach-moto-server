import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { PlayerUpdateData } from "./types";

import Database from "better-sqlite3";

// 1. Initialize DB (creates leaderboard.db in your root folder)
const db = new Database("leaderboard.db");

// 2. Create the table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS times (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level INTEGER,
        playerName TEXT,
        time REAL,
        date_achieved DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// 3. Prepare our SQL statements for maximum performance
const insertTime = db.prepare("INSERT INTO times (level, playerName, time) VALUES (?, ?, ?)");
const getTopTimes = db.prepare("SELECT playerName, time FROM times WHERE level = ? ORDER BY time ASC LIMIT 10");

const app = express();
const server = http.createServer(app);

// Regex to match exact domain and any subdomains
const allowedOrigins = [
  // Production: matches gametje.com and any subdomains (http or https)
  /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*gametje\.com$/,

  // Local Dev: matches http://localhost and http://localhost:5173 (or any port)
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,

  // Local Network Dev: matches http://192.x.x.x (for testing on your physical phone)
  /^http:\/\/192\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
];

// Enable CORS so your Svelte frontend can connect
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // If there is no origin (e.g., server-to-server requests), block it.
      // If the origin matches our Regex, allow it.
      if (origin && allowedOrigins.find((reg) => reg.test(origin))) {
        callback(null, true);
      } else {
        console.warn(`Blocked connection from unauthorized origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  },
});

// Helper function to count players and broadcast to all connected clients
function broadcastCounts() {
  // Change the record type to string so we can pass 'total' along with '1', '2', etc.
  const counts: Record<string, number> = {};

  for (let i = 1; i <= 4; i++) {
    const roomName = `level_${i}`;
    counts[i.toString()] = io.sockets.adapter.rooms.get(roomName)?.size || 0;
  }

  // Add the total number of players currently connected to the server
  counts["total"] = io.engine.clientsCount;

  io.emit("room_counts", counts);
}

io.on("connection", (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Immediately tell the new player the current counts
  broadcastCounts();

  // Explicitly type the room variable
  let currentRoom: string | null = null;

  // 1. Join a specific level
  socket.on("join_level", (levelNumber: string | number) => {
    // Leave previous level if they were in one
    console.log(`${socket.id} ${currentRoom}`);
    if (currentRoom) {
      socket.leave(currentRoom);
      socket.to(currentRoom).emit("phantom_leave", socket.id);
    }

    if (levelNumber === "menu") {
      broadcastCounts();
      currentRoom = null;
      return;
    }

    currentRoom = `level_${levelNumber}`;
    socket.join(currentRoom);
    console.log(`${socket.id} joined ${currentRoom}`);
    // Immediately tell the new player the current counts
    broadcastCounts();
  });

  // 2. Receive position and broadcast to everyone ELSE in the same level
  socket.on("player_update", (data: PlayerUpdateData) => {
    if (!currentRoom) return;

    socket.to(currentRoom).emit("phantom_update", { ...data, id: socket.id });
  });

  socket.on("request_leaderboard", (levelNumber: number) => {
    const top10 = getTopTimes.all(levelNumber);
    socket.emit(`leaderboard_data_${levelNumber}`, top10);
  });

  // Player finishes a track and submits their time
  socket.on("submit_time", (data: { level: number; name: string; time: number }) => {
    // Basic anti-cheat: Don't accept impossible times (e.g., under 2 seconds)
    if (data.time < 2) return;

    // Save to SQLite
    insertTime.run(data.level, data.name, data.time);

    // Broadcast the updated Top 10 to everyone so the UI updates instantly
    const updatedTop10 = getTopTimes.all(data.level);
    io.emit(`leaderboard_data_${data.level}`, updatedTop10);
  });

  // 3. Handle disconnections
  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (currentRoom) {
      socket.to(currentRoom).emit("phantom_leave", socket.id);
    }
    // Immediately tell the new player the current counts
    broadcastCounts();
  });
});

const PORT: string | number = process.env.PORT || 3333;

server.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT}`);
});
