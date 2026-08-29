import IORedis, { type Redis } from 'ioredis';

import { env } from './env.js';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  return client;
}
