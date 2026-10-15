// One shape for the two homes of an AI provider config (#47): a workspace's
// shared provider and the signed-in user's personal one. The settings form
// talks to this, so the same form, rules and connection test serve both.

import type { AiConfigInput, AiConfigView, AiImageConfigInput, AiImageConfigView, AiModelList } from "@hc/sdk";
import { oc } from "@/lib/sdk";

export interface AiConfigApi {
  setConfig(input: AiConfigInput): Promise<AiConfigView>;
  deleteConfig(): Promise<void>;
  testConfig(candidate?: AiConfigInput): Promise<void>;
  listModels(candidate?: Omit<AiConfigInput, "model" | "imageModel">, purpose?: "text" | "image"): Promise<AiModelList>;
  getImageConfig(): Promise<AiImageConfigView | null>;
  setImageConfig(input: AiImageConfigInput): Promise<AiImageConfigView | null>;
  deleteImageConfig(): Promise<void>;
  testImageConfig(candidate?: AiImageConfigInput): Promise<{ verified: boolean }>;
  listImageModels(candidate: Omit<AiImageConfigInput, "model">): Promise<AiModelList>;
}

export function workspaceAiApi(workspaceId: string): AiConfigApi {
  return {
    setConfig: (input) => oc.setAiConfig(workspaceId, input),
    deleteConfig: () => oc.deleteAiConfig(workspaceId),
    testConfig: (candidate) => oc.testAiConfig(workspaceId, candidate),
    listModels: (candidate, purpose) => oc.listAiModels(workspaceId, candidate, purpose),
    getImageConfig: () => oc.getAiImageConfig(workspaceId),
    setImageConfig: (input) => oc.setAiImageConfig(workspaceId, input),
    deleteImageConfig: () => oc.deleteAiImageConfig(workspaceId),
    testImageConfig: (candidate) => oc.testAiImageConfig(workspaceId, candidate),
    listImageModels: (candidate) => oc.listAiImageModels(workspaceId, candidate),
  };
}

export const personalAiApi: AiConfigApi = {
  setConfig: (input) => oc.setMyAiConfig(input),
  deleteConfig: () => oc.deleteMyAiConfig(),
  testConfig: (candidate) => oc.testMyAiConfig(candidate),
  listModels: (candidate, purpose) => oc.listMyAiModels(candidate, purpose),
  getImageConfig: () => oc.getMyAiImageConfig(),
  setImageConfig: (input) => oc.setMyAiImageConfig(input),
  deleteImageConfig: () => oc.deleteMyAiImageConfig(),
  testImageConfig: (candidate) => oc.testMyAiImageConfig(candidate),
  listImageModels: (candidate) => oc.listMyAiImageModels(candidate),
};
