import { BaseProvider } from './base.js';
import type { ProviderModel, RateLimits } from './types.js';

export class ZhipuProvider extends BaseProvider {
  name = 'Zhipu AI';
  id = 'zhipu';
  baseURL = 'https://open.bigmodel.cn/api/paas/v4/';
  envVar = 'ZHIPU_API_KEY';
  rateLimits: RateLimits = {};
  models: ProviderModel[] = [
    { id: 'glm-4-flash', name: 'GLM-4 Flash' },
    { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash' },
    { id: 'glm-4.6v-flash', name: 'GLM-4.6V Flash' },
  ];
}
