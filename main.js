// main.js
// Modules to control application life and create native browser window
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureCdp } from './scripts/main/electronCdp.js';

// common functions for main and wsService
import { setupIPCs, getAppVersion } from './main-common.js';
// WebSocket server
import { setupHttpServer, closeWebSocketServer } from './scripts/webserver/back/wsService.js';
// Import custom modules
import { setupFileHandlers } from './scripts/main/fileHandlers.js';
import { setupGlobalSettings, getGlobalSettings } from './scripts/main/globalSettings.js';
import { releaseComfyModels } from './scripts/main/comfyRelease.js';
import { registerBackendStatus } from './scripts/main/backendStatus.js';
import { setupDownloadFiles } from './scripts/main/downloadFiles.js';
import { setupModelList } from './scripts/main/modelList.js';
import { setupTagAutoCompleteBackend } from './scripts/main/tagAutoComplete_backend.js';
import { setupTagRelatedBackend } from './scripts/main/tagRelated_backend.js';
import { setupModelApi } from './scripts/main/remoteAI_backend.js';
import { setupGenerateBackendComfyUI, sendToRenderer } from './scripts/main/generate_backend_comfyui.js';
import { stopPodSshSession } from './scripts/main/podSshTransport.js';
import { setupGenerateBackendWebUI } from './scripts/main/generate_backend_webui.js';
import { setupCachedFiles } from './scripts/main/cachedFiles.js';
import { setupWildcardsHandlers } from './scripts/main/wildCards.js';
import { setupTagger } from './scripts/main/imageTagger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep CDP disabled by default. Opt in with SAA_CDP_PORT or
// --saa-cdp-port=<port> when a local DevTools/MCP session is needed.
const cdpConfiguration = configureCdp(app);
if (cdpConfiguration.enabled) {
  console.log(`[CDP] Remote debugging enabled on http://127.0.0.1:${cdpConfiguration.port}`);
} else if (cdpConfiguration.source === 'invalid') {
  console.warn('[CDP] Ignoring an invalid CDP port; use a TCP port from 1024 to 65535.');
}

let mainWindow; // Main browser window instance

function replaceMisspelling(word) {
  mainWindow.webContents.replaceMisspelling(word);
  return true;
}

function addToDictionary(word) {
  mainWindow.webContents.session.addWordToSpellCheckerDictionary(word);
  return true;
}

function createWindow () {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,  // Hide menu
    width: 1300,
    height: 1200,
    icon: path.join(__dirname, './html/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, './scripts/preload.js'),
      contextIsolation: true, // Enable context isolation
      nodeIntegration: false, // Disable Node.js integration
      nodeIntegrationInWorker: true, // Enable multithread
      spellcheck: true, // Enable spellcheck
      sandbox: false, // Disable sandbox for ES modules
      webSecurity: true, //Enable web security
    }
  });

  // Set the spellchecker to check English US
  mainWindow.webContents.session.setSpellCheckerLanguages(['en-US']);

  // Send the spellcheck suggestions to the renderer process
  mainWindow.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    const suggestions = params.dictionarySuggestions || [];
    const word = params.misspelledWord || '';
    sendToRenderer(`none`, `rightClickMenu_spellCheck`, suggestions, word);
  });

  // and load the index_electron.html of the app.
  mainWindow.loadFile('index_electron.html');
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
async function initializeApp() {
  const version = getAppVersion();
  console.log("SAA-Nishiki Version:", version);

  setupFileHandlers();  
  const SETTINGS = setupGlobalSettings();
  SETTINGS.version = version;
  
  setupModelList(SETTINGS);
  const downloadSuccess = await setupDownloadFiles();
  const cacheSuccess = setupCachedFiles(SETTINGS.thumb_select);

  // Ensure wildcards list are set up before tag auto-complete
  setupWildcardsHandlers();

  const tacSuccess = await setupTagAutoCompleteBackend(SETTINGS.language);
  setupTagRelatedBackend();
  setupModelApi();
  setupGenerateBackendComfyUI();
  setupGenerateBackendWebUI();  
  setupTagger();

  if (downloadSuccess && cacheSuccess && tacSuccess) {   
    createWindow();    

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } else {
    console.error('[Main] Failed to load required files. Exiting...');
    app.quit();
  }
  
  // Header status pills (GET probes of ComfyUI / Ollama: loopback, or HTTPS for pods)
  registerBackendStatus(ipcMain, getGlobalSettings);

  // IPC handlers for spellcheck
  ipcMain.handle('replace-misspelling', async (event, word) => {    
    return replaceMisspelling(word);
  });
  ipcMain.handle('add-to-dictionary', async (event, word) => {    
    return addToDictionary(word);
  });

  let ws_service_result = false;
  // Start the HTTP server
  if (SETTINGS.ws_service) {
    ws_service_result = await setupHttpServer(path.join(__dirname), SETTINGS.ws_addr, SETTINGS.ws_port);
  }

  setupIPCs(ws_service_result?`${SETTINGS.ws_addr}:${SETTINGS.ws_port}`:`none`);  
}

// Initialize the app
// eslint-disable-next-line unicorn/prefer-top-level-await
(async () => { 
  await app.whenReady();
  await initializeApp();
  
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  });
})();

// Quit when all windows are closed
app.on('window-all-closed', async function () {
  // close the WebSocket server
  closeWebSocketServer();

  // Drop the pod SSH relay (if any) so no orphan ssh.exe lingers.
  try {
    stopPodSshSession();
  } catch (error) {
    console.warn('[Main] Pod SSH shutdown skipped:', error?.message ?? error);
  }

  // Ask the loopback ComfyUI to drop its models so the checkpoint does not stay in VRAM after SAA exits.
  try {
    await releaseComfyModels(getGlobalSettings());
  } catch (error) {
    console.warn('[Main] ComfyUI model release skipped:', error?.message ?? error);
  }

  app.quit()
})
