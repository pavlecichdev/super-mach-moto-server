import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { PlayerUpdateData } from "./types";

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
  const counts: Record<number, number> = {};
  // Assuming you have 4 levels total. Adjust if you have more!
  for (let i = 1; i <= 4; i++) {
    const roomName = `level_${i}`;
    // Socket.io stores room sizes in the adapter
    counts[i] = io.sockets.adapter.rooms.get(roomName)?.size || 0;
  }
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
