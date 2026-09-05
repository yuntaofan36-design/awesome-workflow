import { useOutletContext } from 'react-router-dom';

import type { DeveloperApplication } from '@/services/developerApi';

export type DeveloperOutletContext = {
  applications: DeveloperApplication[];
  loading: boolean;
  refreshApplications: () => Promise<void>;
  selectedApplication: DeveloperApplication | null;
  workspaceId: string;
};

export function useDeveloperContext() {
  return useOutletContext<DeveloperOutletContext>();
}
