import { Queue } from 'bullmq';

const redisUrlStr = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const url = new URL(redisUrlStr);
export const connection = {
  host: url.hostname,
  port: parseInt(url.port, 10) || 6379,
  username: url.username || undefined,
  password: url.password || undefined,
  tls: url.protocol === 'rediss:' ? {} : undefined
};

export const deploymentQueue = new Queue('deployments', { connection });

/**
 * Adds a new deployment job to the queue
 */
export async function addDeploymentJob(jobData) {
  return await deploymentQueue.add('deploy', jobData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
}
