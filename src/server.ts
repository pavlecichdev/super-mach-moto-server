import * as dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import { PlayerSubmitTime, PlayerUpdateData } from "./types";
import { dbService } from "./DatabaseService";

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === "production";

const allowedOrigins: RegExp[] = [
  // Your main domain and any subdomains
  /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*gametje\.com$/,

  // NEW: Any subdomain of crazygames.com (covers game-files.crazygames.com, etc.)
  /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*crazygames\.com$/,
];

// 3. Conditionally push local testing origins ONLY if we are not in production
if (!isProduction) {
  allowedOrigins.push(
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
    /^http:\/\/192\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/,
  );
  console.log("CORS: Running in Dev mode. Localhost origins allowed.");
} else {
  console.log("CORS: Running in STRICT Production mode.");
}

// --- NEW: HTTP Middleware ---
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.find((reg) => reg.test(origin))) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);
app.use(express.json()); // Allows Express to parse JSON bodies in POST requests

// --- NEW: HTTP REST Routes ---

// 1. Get Leaderboard (GET Request)
app.get("/api/v1/leaderboard/:level", async (req, res) => {
  try {
    const level = parseInt(req.params.level, 10);
    const leaderboards = await dbService.getLeaderboardsForLevel(level);
    res.json(leaderboards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

app.get("/api/v1/leaderboards", async (req, res) => {
  try {
    const allLeaderboards = await dbService.getAllLeaderboards();
    res.json(allLeaderboards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch all leaderboards" });
  }
});

// 2. Submit Time (POST Request)
app.post("/api/v1/submitTime", async (req, res) => {
  try {
    const data: PlayerSubmitTime = req.body;

    // Save to Postgres
    const leaderboards = await dbService.saveTimeAndGetLeaderboards(data);

    // Grab the new Top 10
    //const leaderboards = await dbService.getLeaderboardsForLevel(data.level);

    // MAGIC: We can STILL use Socket.io to broadcast the new leaderboard instantly
    // to everyone currently looking at that level's screen!
    io.emit(`leaderboard_data_${data.level}`, leaderboards);

    res.status(200).json(leaderboards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save time" });
  }
});

// --- WebSockets (Real-time Ghosts & Rooms) ---
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (origin && allowedOrigins.find((reg) => reg.test(origin))) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
  },
});

function broadcastCounts() {
  const counts: Record<string, number> = {};

  // Iterate over every active room currently tracked by Socket.IO
  for (const [roomName, room] of io.sockets.adapter.rooms.entries()) {
    // We only care about our game rooms, not socket ID rooms
    if (roomName.startsWith("level_")) {
      const levelId = roomName.replace("level_", "");
      counts[levelId] = room.size;
    }
  }

  // Add the total number of connected clients
  counts["total"] = io.engine.clientsCount;

  io.emit("room_counts", counts);
}

io.on("connection", (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);
  broadcastCounts();

  let currentRoom: string | null = null;

  socket.on("join_level", (levelNumber: string | number) => {
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
    broadcastCounts();
  });

  socket.on("player_update", (data: PlayerUpdateData) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("phantom_update", { ...data, id: socket.id });
  });

  socket.on("request_leaderboard", async (levelNumber: number) => {
    const leaderboards = await dbService.getLeaderboardsForLevel(levelNumber);
    socket.emit(`leaderboard_data_${levelNumber}`, leaderboards);
  });

  socket.on("disconnect", () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (currentRoom) {
      socket.to(currentRoom).emit("phantom_leave", socket.id);
    }
    broadcastCounts();
  });
});

const PORT = process.env.PORT || 3333;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
