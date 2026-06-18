import { Queue } from 'bullmq';
import { connection } from './deploymentQueue.js';
export { connection };

export const pageQueue = new Queue('generate-page-content', { connection });

/**
 * Enqueue a page content generation job
 */
export async function addPageGenerationJob(jobData) {
  return await pageQueue.add('generate', jobData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    }
  });
}
