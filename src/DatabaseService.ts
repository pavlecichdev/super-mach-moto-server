import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { LeaderboardData, LeaderboardEntry, PlayerSubmitTime } from "./types";

class LeaderboardDB {
  private db: Database.Database;

  // Prepared Statements
  private upsertOverall!: Database.Statement;
  private upsertWeekly!: Database.Statement;
  private getTopOverall!: Database.Statement;
  private getTopWeekly!: Database.Statement;
  private incrementCompletions!: Database.Statement;
  private getCompletions!: Database.Statement;

  constructor() {
    // 1. Ensure the data directory exists
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // 2. Connect to the database
    const dbPath = path.join(dataDir, "leaderboard.db");
    this.db = new Database(dbPath);

    this.initTables();
    this.prepareStatements();
  }

  private initTables() {
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS overall_times (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level INTEGER,
                playerId TEXT,
                playerName TEXT,
                color TEXT,
                bikeId TEXT,
                time REAL,
                date_achieved DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(level, playerId) 
            );

            CREATE TABLE IF NOT EXISTS weekly_times (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level INTEGER,
                week_id TEXT,
                playerId TEXT,
                playerName TEXT,
                color TEXT,
                bikeId TEXT,
                time REAL,
                date_achieved DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(level, week_id, playerId)
            );
            CREATE TABLE IF NOT EXISTS level_stats (
                level INTEGER PRIMARY KEY,
                total_completions INTEGER DEFAULT 0
            );
        `);
  }

  private prepareStatements() {
    // We compile these once on startup for maximum performance
    this.upsertOverall = this.db.prepare(`
            INSERT INTO overall_times (level, playerId, playerName, color, bikeId, time) 
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(level, playerId) DO UPDATE SET 
                time = excluded.time,
                playerName = excluded.playerName,
                color = excluded.color,
                bikeId = excluded.bikeId,
                date_achieved = CURRENT_TIMESTAMP
            WHERE excluded.time < overall_times.time;
        `);

    this.upsertWeekly = this.db.prepare(`
            INSERT INTO weekly_times (level, week_id, playerId, playerName, color, bikeId, time) 
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(level, week_id, playerId) DO UPDATE SET 
                time = excluded.time,
                playerName = excluded.playerName,
                color = excluded.color,
                bikeId = excluded.bikeId,
                date_achieved = CURRENT_TIMESTAMP
            WHERE excluded.time < weekly_times.time;
        `);

    this.getTopOverall = this.db.prepare(`
            SELECT playerName, color, bikeId, time, date_achieved 
            FROM overall_times WHERE level = ? ORDER BY time ASC LIMIT 10;
        `);

    this.getTopWeekly = this.db.prepare(`
            SELECT playerName, color, bikeId, time, date_achieved 
            FROM weekly_times WHERE level = ? AND week_id = ? ORDER BY time ASC LIMIT 10;
        `);
    this.incrementCompletions = this.db.prepare(`
            INSERT INTO level_stats (level, total_completions) 
            VALUES (?, 1)
            ON CONFLICT(level) DO UPDATE SET 
            total_completions = total_completions + 1;
        `);

    this.getCompletions = this.db.prepare(`
            SELECT total_completions FROM level_stats WHERE level = ?;
        `);
  }

  private getCurrentWeekId(): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
  }

  // --- PUBLIC API FOR SERVER.TS ---

  public saveTimeAndGetLeaderboards(data: PlayerSubmitTime): LeaderboardData | null {
    if (data.time < 2) return null;

    const currentWeek = this.getCurrentWeekId();

    // 1. Run all our database updates
    this.upsertOverall.run(data.level, data.playerId, data.name, data.color, data.bikeId, data.time);
    this.upsertWeekly.run(data.level, currentWeek, data.playerId, data.name, data.color, data.bikeId, data.time);

    // BOOM: Add 1 to the total completions!
    this.incrementCompletions.run(data.level);

    // 2. Return the fresh data
    return this.getLeaderboardsForLevel(data.level);
  }

  public getLeaderboardsForLevel(level: number): LeaderboardData {
    const currentWeek = this.getCurrentWeekId();

    // Fetch the stats safely (it might be undefined if no one has beaten the level yet)
    const stats = this.getCompletions.get(level) as { total_completions: number } | undefined;
    const total = stats ? stats.total_completions : 0;

    return {
      overall: this.getTopOverall.all(level) as LeaderboardEntry[],
      weekly: this.getTopWeekly.all(level, currentWeek) as LeaderboardEntry[],
      totalCompletions: total,
    };
  }
}

// Export a single, shared instance
export const dbService = new LeaderboardDB();
