import { useEffect, useState } from 'react';
import type { Player } from '../lib/game-store';
import { gameStore } from '../lib/game-store';
import './Leaderboard.css';

export function Leaderboard() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [activePlayers, setActivePlayers] = useState<Player[]>([]);
  const [progress, setProgress] = useState({ correct: 0, total: 0, percentage: 0 });

  useEffect(() => {
    const unsubscribe = gameStore.subscribe(() => {
      setPlayers(gameStore.getLeaderboard());
      setActivePlayers(gameStore.getActivePlayers());
      setProgress(gameStore.getProgress());
    });

    // Initial load
    setPlayers(gameStore.getLeaderboard());
    setActivePlayers(gameStore.getActivePlayers());
    setProgress(gameStore.getProgress());

    return unsubscribe;
  }, []);

  const currentPlayer = gameStore.getCurrentPlayer();

  return (
    <div className="leaderboard">
      <div className="leaderboard-section">
        <h3>Progress</h3>
        <div className="progress-container">
          <div
            className="progress-bar"
            style={{ width: `${progress.percentage}%` }}
          />
          <span className="progress-text">
            {progress.correct.toLocaleString()} / {progress.total.toLocaleString()} ({progress.percentage}%)
          </span>
        </div>
      </div>

      <div className="leaderboard-section">
        <h3>
          Active Players
          <span className="player-count">{activePlayers.length}</span>
        </h3>
        <div className="active-players">
          {activePlayers.map(player => (
            <div
              key={player.id}
              className={`active-player ${player.id === currentPlayer.id ? 'is-you' : ''}`}
            >
              <span
                className="player-dot"
                style={{ backgroundColor: player.color }}
              />
              <span className="player-name">
                {player.name}
                {player.id === currentPlayer.id && ' (you)'}
              </span>
              <span className="player-score">{player.score}</span>
            </div>
          ))}
          {activePlayers.length === 0 && (
            <div className="no-players">No active players</div>
          )}
        </div>
      </div>

      <div className="leaderboard-section">
        <h3>Top Scores</h3>
        <div className="leaderboard-list">
          {players.map((player, index) => (
            <div
              key={player.id}
              className={`leaderboard-item ${player.id === currentPlayer.id ? 'is-you' : ''}`}
            >
              <span className="leaderboard-rank">
                {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`}
              </span>
              <span
                className="player-color"
                style={{ backgroundColor: player.color }}
              />
              <span className="player-name">
                {player.name}
                {player.id === currentPlayer.id && ' (you)'}
              </span>
              <span className="player-score">{player.score}</span>
            </div>
          ))}
          {players.length === 0 && (
            <div className="no-players">No scores yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
