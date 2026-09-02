import { create } from 'zustand';

export type ProjectStatus = 'blocked' | 'healthy' | 'watch';

export type Project = {
  completedTasks: number;
  dueDate: string;
  id: string;
  name: string;
  openTasks: number;
  owner: string;
  progress: number;
  status: ProjectStatus;
};

type WorkspaceState = {
  activeProjectId: string;
  projects: Project[];
  renameWorkspace: (name: string) => void;
  setActiveProjectId: (projectId: string) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  workspaceName: string;
};

const initialProjects: Project[] = [
  {
    completedTasks: 34,
    dueDate: 'Jul 18',
    id: 'northstar',
    name: 'Northstar rollout',
    openTasks: 7,
    owner: 'Maya Chen',
    progress: 82,
    status: 'healthy',
  },
  {
    completedTasks: 18,
    dueDate: 'Jul 22',
    id: 'atlas',
    name: 'Atlas reporting',
    openTasks: 12,
    owner: 'Jon Bell',
    progress: 61,
    status: 'watch',
  },
  {
    completedTasks: 9,
    dueDate: 'Jul 25',
    id: 'signal',
    name: 'Signal quality pass',
    openTasks: 15,
    owner: 'Priya Shah',
    progress: 38,
    status: 'blocked',
  },
];

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  activeProjectId: initialProjects[0].id,
  projects: initialProjects,
  renameWorkspace: (name) => {
    const nextName = name.trim();
    if (!nextName) {
      return;
    }

    set({ workspaceName: nextName });
  },
  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  workspaceName: 'Awesome Workflow Desktop',
}));

export const selectActiveProjectId = (state: WorkspaceState) => state.activeProjectId;
export const selectProjects = (state: WorkspaceState) => state.projects;
export const selectRenameWorkspace = (state: WorkspaceState) => state.renameWorkspace;
export const selectSetActiveProjectId = (state: WorkspaceState) => state.setActiveProjectId;
export const selectSidebarCollapsed = (state: WorkspaceState) => state.sidebarCollapsed;
export const selectToggleSidebar = (state: WorkspaceState) => state.toggleSidebar;
export const selectWorkspaceName = (state: WorkspaceState) => state.workspaceName;
