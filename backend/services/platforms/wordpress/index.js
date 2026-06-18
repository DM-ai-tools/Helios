import { DeploymentManager } from './DeploymentManager.js';

export async function deployToWordPress(payload, integration) {
  const manager = new DeploymentManager();
  return await manager.deploy(payload, integration);
}
