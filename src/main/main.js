const { app, BrowserWindow, ipcMain,
  Menu, dialog, powerMonitor,
  shell, powerSaveBlocker, Tray,
  globalShortcut, session,
  utilityProcess, protocol,
} = require('electron')

const { isMacOS, isWinOS, useCustomTrafficLight, isDevEnv,
  USER_AGENTS, AUDIO_EXTS, IMAGE_EXTS, APP_ICON,
  AUDIO_PLAYLIST_EXTS, BACKUP_FILE_EXTS
} = require('./env')

const { scanDirTracks, parseTracks,
  readText, writeText, FILE_PREFIX,
  randomTextWithinAlphabetNums, nextInt,
  getDownloadDir, removePath, listFiles,
  parsePlsFile, parseM3uFile,
  writePlsFile, writeM3uFile,
  IMAGE_PROTOCAL, parseImageDataFromFile,
  statPathSync, walkSync
} = require('./common')

const path = require('path')
const { dir } = require('console')



const DEFAULT_LAYOUT = 'default', SIMPLE_LAYOUT = 'simple'
const appLayoutConfig = {
  'default': {
    appWidth: 1080,
    appHeight: 720
  },
  'simple': {
    appWidth: 500,
    appHeight: 588
  }
}
let mainWin = null, appLayout = DEFAULT_LAYOUT
let powerSaveBlockerId = -1, appTray = null
const proxyAuthRealms = []
//TODO 下载队列
let downloadingItem = null

/* 自定义函数 */
const startup = () => {
  init()
  registryGlobalListeners()
}

const init = () => {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    //全局快捷键
    //registryGlobalShortcuts()
    //全局UserAgent
    app.userAgentFallback = USER_AGENTS[nextInt(USER_AGENTS.length)]
    mainWin = createMainWindow()

    session.defaultSession.on('will-download', (event, item, webContents) => {
      //event.preventDefault()
      downloadingItem = item
      const filename = item.getFilename()
      const savePath = getDownloadDir() + filename
      removePath(savePath)
      item.setSavePath(savePath)
      item.on('updated', (event, state) => {
        if (state == 'progressing') {
          const received = item.getReceivedBytes()
          const total = item.getTotalBytes()
          sendToRenderer('download-progressing', {
            url: item.getURL(),
            savePath,
            received,
            total
          })
        }
      })

      item.on('done', (event, state) => {
        downloadingItem = null
        sendToRenderer('download-done', {
          url: item.getURL(),
          savePath
        })
        //console.log("[ Download - Done ]")
      })
    })

    //自定义协议
    const EMPTY_BUFFER = Buffer.from('')
    protocol.registerBufferProtocol(IMAGE_PROTOCAL.scheme, async (request, callback) => {
      const file = decodeURI(request.url.slice(IMAGE_PROTOCAL.prefix.length))
      parseImageDataFromFile(file).then(result => {
        let response = { data: EMPTY_BUFFER }
        if (result) {
          const { format, data } = result
          response = { mimeType: format, data }
        }
        callback(response)
      })
    })
  })

  app.on('activate', (event) => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWin = createMainWindow()
    }
    sendToRenderer('app-active')
  })

  app.on('did-become-active', (event) => {
    sendToRenderer('app-active')
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', (event) => {
    if (!isDevEnv || !isMacOS) app.quit()
  })

  app.on('before-quit', (event) => {
    cleanupBeforeQuit()
    sendToRenderer('app-quit')
  })

  app.on('login', (event, webContents, details, authInfo, callback) => {
    const { isProxy, scheme, host, port } = authInfo
    if (isProxy) {
      event.preventDefault()
      const { username, secret } = getProxyAuthRealm(scheme, host, port)
      callback(username, secret)
    }
  })

}

//全局快捷键
const registryGlobalShortcuts = () => {
  const config = {
    // 播放或暂停
    'Alt+Shift+Space': 'togglePlay',
    // 播放模式切换
    'Shift+M': 'switchPlayMode',
    // 上 / 下一曲
    'Shift+Left': 'playPrev',
    'Shift+Right': 'playNext',
    // 增 / 减音量
    'Shift+Up': 'volumeUp',
    'Shift+Down': 'volumeDown',
    // 最大音量 / 静音
    'Shift+O': 'toggleVolumeMute',
    // 打开设置
    'Shift+P': 'visitSetting',
    // 打开 / 关闭当前播放
    'Shift+Q': 'togglePlaybackQueue',
    // 打开 / 关闭歌词设置
    'Shift+L': 'toggleLyricToolbar',
    // 打开 开发者工具
    'Control+Alt+Shift+I': openDevTools,
    'Command+Alt+Shift+I': openDevTools
  }

  const activeWindowValues = ['visitSetting', 'togglePlaybackQueue', 'toggleLyricToolbar']
  for (const [key, value] of Object.entries(config)) {
    globalShortcut.register(key, () => {
      const valueType = typeof (value)
      if (valueType === 'function') {
        value()
      } else if (valueType === 'string') {
        sendToRenderer('globalShortcut-' + value)
        if (activeWindowValues.includes(value)) mainWin.show()
      }
    })
  }
}

//在菜单栏显示
const setupTray = (isShow) => {
  if (isShow) {
    if (appTray) appTray.destroy()
    appTray = new Tray(path.join(__dirname, APP_ICON))
    appTray.setContextMenu(Menu.buildFromTemplate(initTrayMenuTemplate()))
  } else if (appTray) {
    appTray.destroy()
    appTray = null
  }
}

//全局事件监听
const registryGlobalListeners = () => {
  //主进程事件监听
  ipcMain.on('app-quit', () => {
    if (isDevEnv || isMacOS) {
      mainWin.close()
      return
    }
    cleanupBeforeQuit()
    app.quit()
  }).on('app-min', (event, isHideToTray) => {
    if (isHideToTray) {
      if (isMacOS) app.hide()
      else mainWin.hide()
      setupTray(true)
      return
    }
    if (mainWin.isFullScreen()) mainWin.setFullScreen(false)
    if (mainWin.isMaximized() || mainWin.isNormal()) mainWin.minimize()
  }).on('app-max', () => {
    let isFullScreen = false
    if (isWinOS) {
      isFullScreen = toggleWinOSFullScreen()
    } else {
      isFullScreen = !mainWin.isFullScreen()
      mainWin.setFullScreen(isFullScreen)
    }
    sendToRenderer('app-max', isFullScreen)
  }).on('app-suspension', (e, data) => {
    if (data === true) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (powerSaveBlockerId != -1) {
      powerSaveBlocker.stop(powerSaveBlockerId)
      powerSaveBlockerId = -1
    }
  }).on('app-tray', (e, isShow) => {
    setupTray(isShow)
  }).on('app-zoom', (e, { zoom, noResize }) => {
    setupAppWindowZoom(zoom, noResize)
  }).on('app-winBtn', (e, value) => {
    setWindowButtonVisibility(value === true)
  }).on('app-layout-default', (e, { zoom, isInit }) => {
    setupAppLayout(DEFAULT_LAYOUT, zoom, isInit)
  }).on('app-layout-simple', (e, { zoom, isInit }) => {
    setupAppLayout(SIMPLE_LAYOUT, zoom, isInit)
  }).on('app-globalShortcut', (e, data) => {
    if (data === true) {
      globalShortcut.unregisterAll()
      registryGlobalShortcuts()
    } else {
      globalShortcut.unregisterAll()
    }
  }).on('app-setGlobalProxy', (e, data) => {
    setupAppGlobalProxy(data)
  }).on('visit-link', (e, data) => {
    shell.openExternal(data)
  }).on('download-item', (e, { url }) => {
    mainWin.webContents.downloadURL(url)
  }).on('download-cancel', (e, data) => {
    cancelDownload()
  }).on('path-showInFolder', (e, path) => {
    if (path) shell.showItemInFolder(path)
  })

  ipcMain.handle('open-audio-playlist', async (event, ...args) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '请选择Audio Playlist文件',
      filters: [{ name: 'Playlist文件', extensions: AUDIO_PLAYLIST_EXTS }],
      properties: ['openFile']
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle('parse-audio-playlist', async (event, ...args) => {
    const file = args[0].trim()
    let result = null
    if (file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[2]}`)) {
      result = await parsePlsFile(file)
    } else if (file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[0]}`)
      || file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[1]}`)) {
      result = await parseM3uFile(file)
    }
    return result
  })

  ipcMain.handle('dnd-open-audio-playlist', async (event, ...args) => {
    const file = args[0].trim()
    const deep = args.length > 1 ? args[1] : false
    let result = null
    if (file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[2]}`)) {
      result = await parsePlsFile(file)
    } else if (file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[0]}`)
      || file.toLowerCase().endsWith(`.${AUDIO_PLAYLIST_EXTS[1]}`)) {
      result = await parseM3uFile(file)
    } else {
      result = await scanDirTracks(file, null, deep)
    }
    return result
  })

  ipcMain.handle('dnd-open-audios', async (event, ...args) => {
    const path = args[0]
    const deep = args.length > 1 ? args[1] : false
    const statResult = statPathSync(path)
    if (!statResult) return null
    const result = []
    if (statResult.isFile()) {
      const tracks = await parseTracks([path])
      result.push({ path, data: tracks })
    } else if (statResult.isDirectory()) {
      const tracks = await scanDirTracks(path, null, deep)
      result.push(tracks)
    }
    return result
  })

  ipcMain.handle('export-playlists', async (event, ...args) => {
    const { path, format, data: playlists } = args[0]
    let result = false
    if (playlists && playlists.length > 0) {
      for (var i = 0; i < playlists.length; i++) {
        const { title, data } = playlists[i]
        let file = `${path}/${title}.${format}`
        if (format === AUDIO_PLAYLIST_EXTS[1]) {
          result = result || await writePlsFile(file, data)
        } else if (format === AUDIO_PLAYLIST_EXTS[0]) {
          result = result || await writeM3uFile(file, data)
        }
      }
    }
    return result
  })

  ipcMain.handle('open-dirs', async (event, ...args) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '请选择文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths
  })

  ipcMain.handle('open-audio-dirs', async (event, ...args) => {
    const dirs = args[0]
    const deep = args.length > 1 ? args[1] : false
    const result = []
    for (var i = 0; i < dirs.length; i++) {
      const tracks = await scanDirTracks(dirs[i], null, deep)
      result.push(tracks)
    }
    return result
  })

  ipcMain.handle('open-audios', async (event, ...args) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '请选择文件',
      filters: [
        { name: 'Audios', extensions: AUDIO_EXTS }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return null
    return parseTracks(result.filePaths)
  })

  ipcMain.handle('open-image', async (event, ...args) => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '请选择文件',
      filters: [
        { name: 'Image', extensions: IMAGE_EXTS }
      ],
      properties: ['openFile']
    })
    return result.filePaths.map(item => (FILE_PREFIX + item))
  })

  ipcMain.handle('open-image-base64', async (event, ...args) => {
    const file = args[0].trim().slice(IMAGE_PROTOCAL.prefix.length)
    const imageResult = await parseImageDataFromFile(file)
    return imageResult ? imageResult.text : null
  })

  ipcMain.handle('load-lyric-file', async (event, ...args) => {
    const arg = args[0].trim()
    const index = arg.lastIndexOf('.')
    const lyricFile = arg.substring(0, index) + ".lrc"
    return readText(lyricFile)
  })

  ipcMain.handle('invoke-vendor', async (event, ...args) => {
    return invokeVender(args[0], args[1], args[2])
  })

  ipcMain.handle('save-file', async (event, ...args) => {
    const { title, name, data } = args[0]
    const result = await dialog.showSaveDialog(mainWin, {
      title: (title || '文件保存'),
      defaultPath: (name ? name : null),
    })
    if (result.canceled) return false
    return writeText(result.filePath, data)
  })

  ipcMain.handle('open-json-file', async (event, ...args) => {
    const title = args[0] || '请选JSON文件'
    const result = await dialog.showOpenDialog(mainWin, {
      title,
      filters: [{ name: 'JSON文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (result.canceled) return null
    const filePath = result.filePaths[0]
    const data = readText(filePath, 'utf8')
    return { filePath, data }
  })

  ipcMain.handle('show-confirm', async (event, ...args) => {
    const { title, msg } = args[0]
    const result = await dialog.showMessageBox(mainWin, {
      message: msg,
      type: "warning",
      title: (title || '确认'),
      buttons: ["确定", "取消"],
      cancelId: 1
    })
    return result.response == 0
  })

  ipcMain.handle('download-checkExists', async (event, ...args) => {
    //TODO 实现有些奇怪，目前仅支持and逻辑
    const { nameContains } = args[0]
    const downloadDir = getDownloadDir()
    const dlFiles = await listFiles(downloadDir)
    const result = dlFiles.filter(name => {
      if (!nameContains || nameContains.length < 1) return false
      let needFilter = true
      for (var i = 0; i < nameContains.length; i++) {
        needFilter = needFilter && name.includes(nameContains[i])
        if (!needFilter) break
      }
      return needFilter
    })
    return (result && result.length > 0) ? (downloadDir + result[0]) : null
  })

  setupDnd()
}

//创建浏览窗口
const createMainWindow = () => {
  const { appWidth: width, appHeight: height } = appLayoutConfig[appLayout]
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    titleBarStyle: 'hidden',
    //trafficLightPosition: { x: 20, y: 18 },
    transparent: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      //nodeIntegrationInWorker: true,
      webSecurity: false  //TODO 有风险，暂时保留此方案，留待后期调整
    }
  })
  if (isDevEnv) {
    mainWindow.loadURL("http://localhost:5173/")
    //打开DevTools
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile('dist/index.html')
  }
  //菜单
  Menu.setApplicationMenu(Menu.buildFromTemplate(initAppMenuTemplate()))

  mainWindow.once('ready-to-show', () => {
    setWindowButtonVisibility(!useCustomTrafficLight)
    mainWindow.show()
  })

  mainWindow.on('show', () => {
    sendToRenderer('app-active')
  })

  //配置请求过滤
  const filter = {
    urls: [
      "*://*.qq.com/*",
      "*://music.163.com/*",
      "*://*.126.net/*",
      "*://*.kuwo.cn/*",
      "*://*.kugou.com/*",
      "*://*.douban.com/*",
      "*://*.doubanio.com/*",
      "*://*.ridio.cn/*",
      "*://*.cnr.cn/*",
      "*://*.qingting.fm/*",
      "*://*.qtfm.cn/*"
    ]
  }
  const { webRequest } = mainWindow.webContents.session
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const { requestHeaders } = overrideRequest(details)
    callback({ requestHeaders })
  })

  return mainWindow
}

const setupAppLayout = (layout, zoom, isInit) => {
  appLayout = layout

  zoom = Number(zoom) || 100
  const zoomFactor = parseFloat(zoom / 100)
  if (zoomFactor < 0.5 || zoomFactor > 3) zoomFactor = 1
  mainWin.webContents.setZoomFactor(zoomFactor)

  const { appWidth, appHeight } = appLayoutConfig[appLayout]
  const width = parseInt(appWidth * zoomFactor), height = parseInt(appHeight * zoomFactor)
  const isSimpleLayout = (appLayout === SIMPLE_LAYOUT)
  const maxWidth = (isSimpleLayout ? width : 102400)
  const maxHeight = (isSimpleLayout ? height : 102400)
  mainWin.setMaximumSize(maxWidth, maxHeight)
  if (isInit || isSimpleLayout) {
    mainWin.setMinimumSize(width, height)
    mainWin.setSize(width, height)
  }
  mainWin.center()
}

//菜单模板
const initAppMenuTemplate = () => {
  const locale = app.getLocale()
  const TEXT_CONFIG = {
    'en-US': {
      about: 'About',
      devTools: 'Developer Tools',
      quit: 'Quit',
      edit: 'Edit'
    },
    'zh-CN': {
      about: '关于',
      devTools: '开发者工具',
      quit: '退出',
      edit: '编辑'
    }
  }
  const menuText = TEXT_CONFIG[locale] || TEXT_CONFIG['zh-CN']
  let menuItems = [{ role: 'about', label: menuText.about },
  { role: 'toggleDevTools', label: menuText.devTools },
  { role: 'quit', label: menuText.quit },]
  if (!isDevEnv) menuItems.splice(1, 1)
  const appName = app.name.replace('-', '')
  const template = [
    ...[{
      label: appName,
      submenu: menuItems,
    }, {
      label: menuText.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    }]
  ]
  return template
}

const sendToRenderer = (channel, args) => {
  try {
    if (mainWin && mainWin.webContents) mainWin.webContents.send(channel, args)
  } catch (error) {
    if (isDevEnv) console.log(error)
  }
}

//TODO 
const sendTrayAction = (action, showWin) => {
  if (mainWin && showWin) mainWin.show()
  sendToRenderer('tray-action', action)
}

const initTrayMenuTemplate = () => {
  const template = [{
    label: '听你想听，爱你所爱',
    click: () => {
      sendTrayAction(-1, true)
    }
  }, {
    type: 'separator'
  }, {
    label: '播放 / 暂停',
    click: () => sendTrayAction(1)
  }, {
    label: '上一曲',
    click: () => sendTrayAction(2)
  }, {
    label: '下一曲',
    click: () => sendTrayAction(3)
  }, {
    type: 'separator'
  }, /*{
    label: '首页',
    click: () => {
      sendTrayAction(4, true)
    }
  },*/ {
    label: '我的主页',
    click: () => {
      sendTrayAction(5, true)
    }
  }, {
    label: '设置',
    click: () => {
      sendTrayAction(6, true)
    }
  }, {
    type: 'separator'
  }, {
    label: "退出",
    role: "quit"
  }]
  return template
}

//设置系统交通灯按钮可见性
const setWindowButtonVisibility = (visible) => {
  if (!isMacOS) return
  try {
    if (mainWin) mainWin.setWindowButtonVisibility(visible)
  } catch (error) {
    if (isDevEnv) console.log(error)
  }
}

const toggleWinOSFullScreen = () => {
  if (!mainWin || !isWinOS) return null
  const isMax = mainWin.isMaximized()
  if (isMax) {
    mainWin.unmaximize()
  } else {
    mainWin.maximize()
  }
  return !isMax
}

const setupAppWindowZoom = (zoom, noResize) => {
  if (!mainWin || !zoom) return
  zoom = Number(zoom) || 85
  const zoomFactor = parseFloat(zoom / 100)
  if (zoomFactor < 0.5 || zoomFactor > 3) return
  mainWin.webContents.setZoomFactor(zoomFactor)
  const { appWidth, appHeight } = appLayoutConfig[appLayout]
  const width = parseInt(appWidth * zoomFactor)
  const height = parseInt(appHeight * zoomFactor)
  mainWin.setMinimumSize(width, height)
  if (noResize) return
  if (mainWin.isNormal()) {
    mainWin.setSize(width, height)
    mainWin.center()
  }
}

const cancelDownload = () => {
  if (downloadingItem) {
    downloadingItem.cancel()
    downloadingItem = null
  }
}

const setupAppGlobalProxy = (data) => {
  const config = {}
  proxyAuthRealms.length = 0
  if (!data) {
    session.defaultSession.setProxy(config)
    return
  }
  const { http, socks } = data
  const proxyRules = []
  if (http) {
    proxyRules.push(`${http.host}:${http.port}`)

    if (http.username && http.password) {
      proxyAuthRealms.push({
        scheme: 'http',
        ...http
      })
    }
  }
  if (socks) {
    proxyRules.push(`socks5://${socks.host}:${socks.port}`)
    proxyRules.push(`socks://${socks.host}:${socks.port}`)

    if (socks.username && socks.password) {
      proxyAuthRealms.push({
        scheme: 'socks',
        ...socks
      })
    }
  }

  if (proxyRules.length > 0) {
    Object.assign(config, {
      proxyRules: proxyRules.join(";"),
      proxyBypassRules: 'localhost'
    })
  }
  if (isDevEnv) console.log('ProxyConfig: ', config)
  session.defaultSession.setProxy(config)
}

const getProxyAuthRealm = (scheme, host, port) => {
  for (var i = 0; i < proxyAuthRealms.length; i++) {
    const realm = proxyAuthRealms[i]
    if (realm.scheme.includes(scheme)
      && realm.host == host && realm.port == port) {
      const { username, password } = realm
      return { username, secret: password }
    }
  }
  return { username: null, secret: null }
}

const openDevTools = () => {
  if (mainWin) mainWin.webContents.openDevTools()
}

const cleanupBeforeQuit = () => {
  cancelDownload()
}

const setupDnd = () => {

}

//覆盖(包装)请求
const overrideRequest = (details) => {
  let origin = null
  let referer = null
  let cookie = null
  let userAgent = null
  let xrouter = null
  let csrf = null

  const { url } = details
  if (url.includes("qq.com")) {
    origin = "https://y.qq.com/"
    referer = origin
  } else if (url.includes("163.com") || url.includes("126.net")) {
    origin = "https://music.163.com/"
    referer = origin
    //if(url.includes("/dj/program/listen")) referer = null
  } else if (url.includes("u6.kuwo.cn")) {
    userAgent = 'fm 7010001}(android 7.1.2)'
    cookie = ''
  } else if (url.includes("kuwo")) {
    csrf = randomTextWithinAlphabetNums(11).toUpperCase()
    origin = "https://www.kuwo.cn/"
    referer = origin
    cookie = "Hm_lvt_cdb524f42f0ce19b169a8071123a4797=1651222601; "
      + "_ga=GA1.2.1036906485.1647595722; "
      + "kw_token=" + csrf
  } else if (url.includes("kugou")) {
    origin = "https://www.kugou.com/"
    referer = origin
    if (url.includes("mac.kugou.com")) userAgent = USER_AGENTS[0]
    if (url.includes("&cmd=123&ext=mp4&hash=")) xrouter = 'trackermv.kugou.com'
  } else if (url.includes("douban")) {
    const bid = randomTextWithinAlphabetNums(11)
    origin = "https://fm.douban.com/"
    referer = origin
    cookie = "bid=" + bid
    //cookie = 'bid=' + bid + '; __utma=30149280.1685369897.1647928743.1648005141.1648614477.3; __utmz=30149280.1648005141.2.2.utmcsr=cn.bing.com|utmccn=(referral)|utmcmd=referral|utmcct=/; _pk_ref.100001.f71f=%5B%22%22%2C%22%22%2C1650723346%2C%22https%3A%2F%2Fmusic.douban.com%2Ftag%2F%22%5D; _pk_id.100001.f71f=5c371c0960a75aeb.1647928769.4.1650723346.1648618102.; ll="118306"; _ga=GA1.2.1685369897.1647928743; douban-fav-remind=1; viewed="2995812"; ap_v=0,6.0'
  } else if (url.includes("radio.cn") || url.includes("cnr.cn")) {
    origin = "http://www.radio.cn/"
    referer = origin
  } else if (url.includes("qingting") || url.includes("qtfm.cn")) {
    origin = "https://www.qingting.fm/"
    referer = origin
  } else if (url.includes("ximalaya")) {
    origin = " https://www.ximalaya.com"
    referer = origin
  }

  /*
  details.requestHeaders['Access-Control-Allow-Headers'] = "Origin, X-Requested-With, Content-Type, Accept"
  details.requestHeaders['Access-Control-Allow-Origin'] = "*"
  */

  //if(origin) details.requestHeaders['Origin'] = origin
  if (userAgent) details.requestHeaders['UserAgent'] = userAgent
  if (referer) details.requestHeaders['Referer'] = referer
  if (cookie) details.requestHeaders['Cookie'] = cookie
  if (xrouter) details.requestHeaders['x-router'] = xrouter
  if (csrf) details.requestHeaders['CSRF'] = csrf

  return details
}

//启动应用
startup()