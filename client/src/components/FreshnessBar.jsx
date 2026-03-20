import { useState, useEffect } from 'react';
import { api } from '../api';

function timeAgo(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isStale(isoString, thresholdHours = 24) {
  if (!isoString) return true;
  return Date.now() - new Date(isoString).getTime() > thresholdHours * 3600000;
}

const SOURCES = [
  { key: 'fangraphs', label: 'FG' },
  { key: 'espn', label: 'ESPN' },
  { key: 'savant', label: 'Savant' },
  { key: 'injuries', label: 'Injuries' },
];

export default function FreshnessBar() {
  const [freshness, setFreshness] = useState({});

  useEffect(() => {
    api.getFreshness().then(setFreshness);
    const interval = setInterval(() => api.getFreshness().then(setFreshness), 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-3 text-xs">
      {SOURCES.map(({ key, label }) => {
        const ts = freshness[key];
        const ago = timeAgo(ts);
        const stale = isStale(ts);
        return (
          <span key={key} className={stale ? 'text-orange-500' : 'text-gray-400'}>
            {label}: {ago || 'never'}
          </span>
        );
      })}
    </div>
  );
}
