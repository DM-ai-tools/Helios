import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const redisClient = createClient({
  url: redisUrl
});

redisClient.on('error', (err) => console.error('[Redis Client] Error:', err));
redisClient.on('connect', () => console.log('[Redis Client] Connected to Redis.'));
redisClient.on('ready', () => console.log('[Redis Client] Ready to use.'));

// Automatically connect on module load (we await this where needed or let it connect in background)
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('[Redis Client] Failed to connect:', err);
  }
})();

export default redisClient;
