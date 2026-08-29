import IORedis, { type Redis } from 'ioredis';

import { env } from './env.js';

let connection: Redis | null = null;

export function getConnection(): Redis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}
