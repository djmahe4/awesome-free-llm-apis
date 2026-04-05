import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class ZhipuProvider extends BaseProvider {
  name = 'Zhipu AI';
  id = 'zhipu';
  baseURL = 'https://open.bigmodel.cn/api/paas/v4/';
  envVar = 'ZHIPU_API_KEY';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: 'glm-5.1', name: 'GLM-5.1' },
    { id: 'glm-5-turbo', name: 'GLM-5-Turbo' },
    { id: 'glm-4.7', name: 'GLM-4.7' },
    { id: 'glm-4.6', name: 'GLM-4.6' },
    { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
  ];
}
