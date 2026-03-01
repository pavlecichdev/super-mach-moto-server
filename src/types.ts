export interface PlayerUpdateData {
  id?: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  lean: number;
  playerColor: string;
  bikeId: string;
}

export interface PlayerSubmitTime {
  level: number;
  playerId: string;
  name: string;
  color: string;
  time: number;
  bikeId: string;
}

export interface LeaderboardEntry {
  playerName: string;
  color: string;
  bikeId: string;
  time: number;
  date_achieved: string; // SQLite returns DATETIME as a string by default
}

export interface LeaderboardData {
  overall: LeaderboardEntry[];
  weekly: LeaderboardEntry[];
  totalCompletions: number;
}
