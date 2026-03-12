import { Pool } from "pg";
import { LeaderboardData, LeaderboardEntry, PlayerSubmitTime } from "./types";

class LeaderboardDB {
  private pool: Pool;

  constructor() {
    // 1. Connect to PostgreSQL using the environment variable from Docker
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    // Fire off the initialization asynchronously
    this.initTables().catch((err) => console.error("Failed to init tables:", err));
  }

  private async initTables() {
    // 2. Use SERIAL for auto-increment and quote camelCase columns to preserve casing in PG
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS overall_times (
          id SERIAL PRIMARY KEY,
          level INTEGER,
          "playerId" TEXT,
          "playerName" TEXT,
          color TEXT,
          "bikeId" TEXT,
          time REAL,
          date_achieved TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(level, "playerId") 
      );

      CREATE TABLE IF NOT EXISTS weekly_times (
          id SERIAL PRIMARY KEY,
          level INTEGER,
          week_id TEXT,
          "playerId" TEXT,
          "playerName" TEXT,
          color TEXT,
          "bikeId" TEXT,
          time REAL,
          date_achieved TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(level, week_id, "playerId")
      );

      CREATE TABLE IF NOT EXISTS level_stats (
          level INTEGER PRIMARY KEY,
          total_completions INTEGER DEFAULT 0
      );
    `);

    console.log("PostgreSQL tables initialized.");
  }

  private getCurrentWeekId(): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${date.getUTCFullYear()}-W${weekNo.toString().padStart(2, "0")}`;
  }

  // --- PUBLIC API FOR SERVER.TS ---
  // Notice: These methods are now ASYNC because network DB calls return Promises

  public async saveTimeAndGetLeaderboards(data: PlayerSubmitTime): Promise<LeaderboardData | null> {
    if (data.time < 2) return null;

    const currentWeek = this.getCurrentWeekId();

    // We get a dedicated client from the pool to run our transactions
    const client = await this.pool.connect();

    try {
      // 1. Overall Upsert (Notice the use of $1, $2 instead of ? in Postgres)
      await client.query(
        `
        INSERT INTO overall_times (level, "playerId", "playerName", color, "bikeId", time) 
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (level, "playerId") DO UPDATE SET 
            time = EXCLUDED.time,
            "playerName" = EXCLUDED."playerName",
            color = EXCLUDED.color,
            "bikeId" = EXCLUDED."bikeId",
            date_achieved = CURRENT_TIMESTAMP
        WHERE EXCLUDED.time < overall_times.time;
      `,
        [data.level, data.playerId, data.name, data.color, data.bikeId, data.time],
      );

      // 2. Weekly Upsert
      await client.query(
        `
        INSERT INTO weekly_times (level, week_id, "playerId", "playerName", color, "bikeId", time) 
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (level, week_id, "playerId") DO UPDATE SET 
            time = EXCLUDED.time,
            "playerName" = EXCLUDED."playerName",
            color = EXCLUDED.color,
            "bikeId" = EXCLUDED."bikeId",
            date_achieved = CURRENT_TIMESTAMP
        WHERE EXCLUDED.time < weekly_times.time;
      `,
        [data.level, currentWeek, data.playerId, data.name, data.color, data.bikeId, data.time],
      );

      // 3. Add 1 to total completions!
      await client.query(
        `
        INSERT INTO level_stats (level, total_completions) 
        VALUES ($1, 1)
        ON CONFLICT (level) DO UPDATE SET 
        total_completions = level_stats.total_completions + 1;
      `,
        [data.level],
      );
    } finally {
      // Always release the client back to the pool!
      client.release();
    }

    // 4. Return the fresh data
    return await this.getLeaderboardsForLevel(data.level);
  }

  public async getLeaderboardsForLevel(level: number): Promise<LeaderboardData> {
    const currentWeek = this.getCurrentWeekId();

    // Use Promise.all to fetch all three queries concurrently for maximum speed
    const [statsResult, overallResult, weeklyResult] = await Promise.all([
      this.pool.query(`SELECT total_completions FROM level_stats WHERE level = $1;`, [level]),
      this.pool.query(
        `SELECT "playerName", color, "bikeId", time, date_achieved FROM overall_times WHERE level = $1 ORDER BY time ASC LIMIT 10;`,
        [level],
      ),
      this.pool.query(
        `SELECT "playerName", color, "bikeId", time, date_achieved FROM weekly_times WHERE level = $1 AND week_id = $2 ORDER BY time ASC LIMIT 10;`,
        [level, currentWeek],
      ),
    ]);

    const total = statsResult.rows.length > 0 ? statsResult.rows[0].total_completions : 0;

    return {
      levelId: level,
      overall: overallResult.rows as LeaderboardEntry[],
      weekly: weeklyResult.rows as LeaderboardEntry[],
      totalCompletions: total,
    };
  }

  public async getAllLeaderboards(): Promise<LeaderboardData[]> {
    const currentWeek = this.getCurrentWeekId();

    const [statsResult, overallResult, weeklyResult] = await Promise.all([
      this.pool.query(`SELECT level, total_completions FROM level_stats;`),
      this.pool.query(`
        SELECT level, "playerName", color, "bikeId", time, date_achieved
        FROM (
          SELECT level, "playerName", color, "bikeId", time, date_achieved,
                 ROW_NUMBER() OVER (PARTITION BY level ORDER BY time ASC) as rank
          FROM overall_times
        ) ranked
        WHERE rank <= 10
        ORDER BY level ASC, time ASC;
      `),
      this.pool.query(
        `
        SELECT level, "playerName", color, "bikeId", time, date_achieved
        FROM (
          SELECT level, "playerName", color, "bikeId", time, date_achieved,
                 ROW_NUMBER() OVER (PARTITION BY level ORDER BY time ASC) as rank
          FROM weekly_times
          WHERE week_id = $1
        ) ranked
        WHERE rank <= 10
        ORDER BY level ASC, time ASC;
      `,
        [currentWeek],
      ),
    ]);

    // 1. Create a Map to dynamically group our levels as we find them
    const leaderboardsMap = new Map<number, LeaderboardData>();

    // Helper function to grab an existing level or initialize a fresh one
    const getOrCreateLevel = (levelId: number) => {
      if (!leaderboardsMap.has(levelId)) {
        leaderboardsMap.set(levelId, {
          levelId,
          overall: [],
          weekly: [],
          totalCompletions: 0,
        });
      }
      return leaderboardsMap.get(levelId)!;
    };

    // 2. Map the stats (creates entries for any level that has been completed)
    for (const row of statsResult.rows) {
      getOrCreateLevel(row.level).totalCompletions = row.total_completions;
    }

    // 3. Map the overall Top 10s
    for (const row of overallResult.rows) {
      getOrCreateLevel(row.level).overall.push({
        playerName: row.playerName,
        color: row.color,
        bikeId: row.bikeId,
        time: row.time,
        date_achieved: row.date_achieved,
      });
    }

    // 4. Map the weekly Top 10s
    for (const row of weeklyResult.rows) {
      getOrCreateLevel(row.level).weekly.push({
        playerName: row.playerName,
        color: row.color,
        bikeId: row.bikeId,
        time: row.time,
        date_achieved: row.date_achieved,
      });
    }

    // 5. Convert the Map back to an Array and sort it so Level 1 comes first
    return Array.from(leaderboardsMap.values()).sort((a, b) => a.levelId - b.levelId);
  }
}

export const dbService = new LeaderboardDB();
