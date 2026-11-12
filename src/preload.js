const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => { const h = (_e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld('scuttle', {
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  config: { get: inv('config:get'), setClientId: inv('config:setClientId') },
  app: { confirmClose: inv('app:confirmClose'), openExternal: inv('app:openExternal'), reveal: inv('app:reveal'),
    onMenu: on('menu'), onFocus: on('app:focus'), onBeforeClose: on('app:before-close') },
  fs: { pickFolder: inv('fs:pickFolder'), readDir: inv('fs:readDir'), readFile: inv('fs:readFile'), writeFile: inv('fs:writeFile'),
    exists: inv('fs:exists'), mkdir: inv('fs:mkdir'), createFile: inv('fs:createFile'), rename: inv('fs:rename'), trash: inv('fs:trash'),
    listFiles: inv('fs:listFiles'), search: inv('fs:search') },
  term: { create: inv('term:create'), kill: inv('term:kill'),
    write: (id, d) => ipcRenderer.send('term:write', id, d), resize: (id, c, r) => ipcRenderer.send('term:resize', id, c, r),
    onData: on('term:data'), onExit: on('term:exit') },
  git: { status: inv('git:status'), init: inv('git:init'), commit: inv('git:commit'), push: inv('git:push'), pull: inv('git:pull'),
    headVersion: inv('git:diffFile'), clone: inv('git:clone'), publish: inv('git:publish') },
  gh: { state: inv('gh:state'), startLogin: inv('gh:startLogin'), waitLogin: inv('gh:waitLogin'), cancelLogin: inv('gh:cancelLogin'),
    logout: inv('gh:logout'), repos: inv('gh:repos'), pickCloneParent: inv('gh:pickCloneParent') },
  pet: { popout: inv('pet:popout'), event: (ev) => ipcRenderer.send('pet:event', ev), mouse: (inside) => ipcRenderer.send('pet:mouse', inside),
    goHome: () => ipcRenderer.send('pet:popoutHome'), onEvent: on('pet:event'), onPopoutClosed: on('pet:popout-closed') },
});
