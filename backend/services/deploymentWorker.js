import { Worker } from 'bullmq';
import { connection } from './deploymentQueue.js';
import { deployToWordPress } from './platforms/wordpress/index.js';
import { 
  updateDbDeploymentJob,
  getIntegrationByPlatform,
  getLatestDeployment,
  createDeployment,
  createAuditTrailEntry
} from '../db/queries.js';

/**
 * The BullMQ worker that processes deployment jobs
 */
export const deploymentWorker = new Worker('deployments', async (job) => {
  const { businessId, auditId, changeId, platform, assetType, payload, deployedBy, isRollback, originalDeploymentId } = job.data;
  
  console.log(`[Job Worker] Job ${job.id} started. Deploying to ${platform}...`);
  await updateDbDeploymentJob(job.data.jobDbId, 'deploying');

  try {
    // 1. Fetch Integration
    const integration = await getIntegrationByPlatform(businessId, platform);
    if (!integration) {
      throw new Error(`Integration for ${platform} not found.`);
    }
    if (integration.status === 'error' || integration.status === 'reauth') {
      throw new Error(`Integration is in ${integration.status} state. Please reconnect.`);
    }

    // 2. Fetch Previous Content (for Rollbacks)
    let previousContent = null;
    if (!isRollback) {
      const lastDeployment = await getLatestDeployment(businessId, platform, changeId);
      if (lastDeployment) {
        previousContent = lastDeployment.content_payload;
      } else {
        previousContent = {
          title: payload.title,
          content: payload.currentState || ''
        };
      }
    } else {
      const lastDeployment = await getLatestDeployment(businessId, platform, changeId);
      if (lastDeployment) {
        previousContent = lastDeployment.content_payload;
      }
    }

    // 3. Dispatch to Platform Service
    let result = null;
    if (platform === 'wordpress') {
      result = await deployToWordPress(payload, integration);
    } else {
      throw new Error(`Platform ${platform} is not fully implemented yet.`);
    }

    // 4. Record Success
    console.log(`[Job Worker] Job ${job.id} status: completed`);
    await updateDbDeploymentJob(job.data.jobDbId, 'completed');

    const deployment = await createDeployment({
      businessId,
      auditId,
      changeId,
      platform,
      assetType,
      contentPayload: payload,
      previousContent: result.previousContent || previousContent,
      builderType: result.builderType || 'wordpress',
      deploymentMethod: result.deploymentMethod || 'native_wordpress',
      status: 'completed',
      deployedBy,
      response: result.updatedObject || result
    });

    const actionDetails = isRollback
      ? `Rolled back ${platform} deployment for "${payload.title}"`
      : `Deployed changes to ${platform} for "${payload.title}"`;

    await createAuditTrailEntry({
      businessId,
      eventType: isRollback ? 'rollback_deployment' : 'deploy_change',
      auditId,
      pluginId: null,
      changeId,
      actionDetails,
      performedBy: deployedBy,
      metadata: {
        jobId: job.data.jobDbId,
        bullmqJobId: job.id,
        deploymentId: deployment.id,
        platform,
        title: payload.title,
        isRollback,
        originalDeploymentId,
        liveUrl: result.live_url
      }
    });

    return result;

  } catch (error) {
    console.error(`[Job Worker] Job ${job.id} failed:`, error.message);
    await updateDbDeploymentJob(job.data.jobDbId, 'failed');

    await createDeployment({
      businessId,
      auditId,
      changeId,
      platform,
      assetType,
      contentPayload: payload,
      previousContent: null,
      status: 'failed',
      deployedBy,
      response: { error: error.message, api_response: null }
    });

    await createAuditTrailEntry({
      businessId,
      eventType: 'deployment_failed',
      auditId,
      pluginId: null,
      changeId,
      actionDetails: `Failed to deploy to ${platform}: ${error.message}`,
      performedBy: deployedBy,
      metadata: { jobId: job.data.jobDbId, platform, error: error.message }
    });

    throw error; // Let BullMQ handle retries
  }
}, { connection });

deploymentWorker.on('completed', job => {
  console.log(`[Job Worker] Job ${job.id} successfully completed`);
});

deploymentWorker.on('failed', (job, err) => {
  console.log(`[Job Worker] Job ${job.id} failed with error ${err.message}`);
});
