import { create } from 'zustand';

type DeveloperState = {
  applicationId: string;
  workspaceId: string;
  selectApplication: (applicationId: string) => void;
  selectWorkspace: (workspaceId: string) => void;
};

export const useDeveloperStore = create<DeveloperState>()((set) => ({
  applicationId: '',
  workspaceId: '',
  selectApplication: (applicationId) => set({ applicationId }),
  selectWorkspace: (workspaceId) => set({ workspaceId, applicationId: '' }),
}));

export const selectDeveloperApplicationId = (state: DeveloperState) => state.applicationId;
export const selectDeveloperWorkspaceId = (state: DeveloperState) => state.workspaceId;
export const selectDeveloperApplication = (state: DeveloperState) => state.selectApplication;
export const selectDeveloperWorkspace = (state: DeveloperState) => state.selectWorkspace;
