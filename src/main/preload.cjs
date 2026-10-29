const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('circuitDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getAiStatus: () => ipcRenderer.invoke('ai:status'),
  analyzeImage: (payload) => ipcRenderer.invoke('ai:analyze-image', payload),
  enhancePlan: (payload) => ipcRenderer.invoke('ai:enhance-plan', payload),
  solveProblem: (payload) => ipcRenderer.invoke('ai:solve-problem', payload),
  loadKnowledge: () => ipcRenderer.invoke('knowledge:load'),
  importKnowledge: () => ipcRenderer.invoke('knowledge:import'),
  importKnowledgeFolder: () => ipcRenderer.invoke('knowledge:import-folder'),
  searchKnowledge: (query, options) => ipcRenderer.invoke('knowledge:search', query, options),
  searchKnowledgeDebug: (query, options) => ipcRenderer.invoke('knowledge:search-debug', query, options),
  saveKnowledge: (entries) => ipcRenderer.invoke('knowledge:save', entries),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  saveProject: (project) => ipcRenderer.invoke('projects:save', project),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  getAgentSession: () => ipcRenderer.invoke('agent-session:get'),
  saveAgentSession: (session) => ipcRenderer.invoke('agent-session:save', session),
  saveExport: (payload) => ipcRenderer.invoke('export:save', payload),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  platform: process.platform,
});
