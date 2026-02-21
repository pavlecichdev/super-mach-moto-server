export interface PlayerUpdateData {
  id?: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  lean: number;
  playerColor: string;
}

export interface PlayerSubmitTime {
  level: number;
  playerId: string;
  name: string;
  color: string;
  time: number;
}
