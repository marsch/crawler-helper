require('dotenv').config()
const queue = require('async/queue')
const { BrowserWindow } = require('electron')

const DEVELOPMENT = process.env.NODE_ENV === 'development'
const WINDOW_WIDTH = parseInt(process.env.WINDOW_WIDTH, 10) || 1024
const WINDOW_HEIGHT = parseInt(process.env.WINDOW_HEIGHT, 10) || 768
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.110 Safari/537.36'
const DEFAULT_HEADERS = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
const chromiumNetErrors = require('chromium-net-errors')


const createWindow = (userWebPreferences = {}) => {
  const defaultWebPreferences = {
    blinkFeatures: 'OverlayScrollbars', // Slimmer scrollbars
    allowDisplayingInsecureContent: true, // Show http content on https site
    allowRunningInsecureContent: true, // Run JS, CSS from http urls
    webSecurity: false
  }

  const webPreferences = { ...defaultWebPreferences, ...userWebPreferences }
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frame: DEVELOPMENT,
    show: DEVELOPMENT,
    transparent: true,
    enableLargerThanScreen: true,
    offscreen: true,
    webPreferences,
  })

  const { webContents } = window

  webContents.debugger.attach('1.1')
  webContents.setUserAgent(USER_AGENT);

  // Emit end events to an aggregate for worker to listen on once
  ['did-fail-load', 'crashed', 'did-finish-load', 'timeout', 'dom-ready'].forEach(e => {
    webContents.on(e, (...args) => webContents.emit('finished', e, ...args))
  })

  return window
}

const handleLoadingError = (currentUrl, event, code, desc, url) => {
  const ErrorClass = chromiumNetErrors.getErrorByCode(code)
  return Promise.reject(new ErrorClass())
}

const validateResult = (originalUrl, eventType, ...args) => {
  switch (eventType) {
  // Loading failures
  case 'did-fail-load': return handleLoadingError(originalUrl, ...args)
    // Renderer process has crashed
  case 'crashed':
    return Promise.reject(new Error('RENDERER_CRASH', 'Render process crashed.'))
    // Page loading timed out
  case 'timeout':
    return Promise.reject(new Error('RENDERER_TIMEOUT', 'Renderer timed out.', 524))
    // Page loaded successfully
  case 'did-finish-load': return Promise.resolve()
  case 'dom-ready': return Promise.resolve()

    // Unhandled event
  default: return Promise.reject(new Error('UNHANDLED_EVENT', eventType))
  }
}

const renderHtml = (window, params, done) => {
  window.webContents.executeJavaScript(`
            document.getElementsByTagName('html')[0].innerHTML
        `).then((result) => {
    window.unlock()
    done(null, result)
  }).catch((e) => {
    window.unlock()
    done(e)
  })
}

const renderImage = (window, params, done) => {
  const handleCapture = (image) => {
    done(null, image.resize({ width: WINDOW_WIDTH }).toPNG())
  }
  window.webContents.executeJavaScript(`
  var body = document.body,
    html = document.documentElement
    Math.max( body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight )
`).then((height) => {
    window.setSize(WINDOW_WIDTH, height)
    setTimeout(() => window.capturePage(handleCapture), 50)
  }).catch((e) => {
    done(e)
  })
}


class WindowPool {
  windowPool = {}

  constructor() {
    const concurrency = parseInt(process.env.CONCURRENCY, 10) || 10
    this.windowPool = {}
    this.createPool(concurrency)
    this.queue = queue(this.queueWorker, concurrency)
  }

  enqueue(...args) {
    this.queue.push(...args)
  }

  setBusy = (id, value) => {
    this.windowPool[id].busy = value
  }

  getAvailableWindow(task) {
    const availableId = Object.keys(this.windowPool)
      .filter(id => this.windowPool[id].busy === false)[0]

    if (!availableId) return null
    let window = this.windowPool[availableId]
    if (!task.webPreferences) {
      return window
    }

    // if webpreferences, spawn a new one
    window.destroy()
    delete this.windowPool[availableId]

    window = createWindow(task.webPreferences)
    // Basic locking
    window.busy = false
    window.unlock = () => { this.setBusy(window.id, false) }
    window.lock = () => { this.setBusy(window.id, true) }

    this.windowPool[window.id] = window
    return this.windowPool[window.id]
  }

  createPool(concurrency) {
    let n = concurrency

    while (n-- > 0) {
      const window = createWindow({})

      // Basic locking
      window.busy = false
      window.unlock = () => { this.setBusy(window.id, false) }
      window.lock = () => { this.setBusy(window.id, true) }

      // Add to pool
      this.windowPool[window.id] = window
    }
  }

  queueWorker = (task, done) => {
    const window = this.getAvailableWindow(task)
    if (!window) throw new Error('Pool is empty while queue is not saturated!?')
    window.lock()

    const { webContents } = window


    const TIMEOUT = task.timeout || process.env.TIMEOUT || 5000
    const timeoutTimer = setTimeout(() => webContents.emit('timeout'), TIMEOUT)

    webContents.once('finished', (type, ...args) => {
      clearTimeout(timeoutTimer)
      validateResult(task.url, type, ...args)
        .then(() => {
          switch (task.type) {
          case 'html':
            renderHtml(window, task, done)
            break
          case 'png':
            renderImage(window, task, done)
            break
          }
        })
        .catch((e) => {
          window.unlock()
          done(e)
        })
    })

    const headers = { ...DEFAULT_HEADERS, ...task.headers }
    const extraHeaders = Object.keys(headers).map((n) => {
      return `${n}: ${headers[n]}`
    }).join('\n')



    let proxyRules = task.proxyRules || process.env.PROXY_RULES
    if (task.proxyRules == '') {
      proxyRules = false
    }
    if (proxyRules) {
      console.log(`setting proxy:${proxyRules}`)
      webContents.session.setProxy({ proxyRules: proxyRules }, () => {
        console.log('proxy was sat')
        console.log(`loading ....${task.url}`)
        webContents.loadURL(task.url, { extraHeaders })
      })
    } else {
      console.log(`loading ....${task.url}`)
      webContents.loadURL(task.url, { extraHeaders })
    }

  }
}

module.exports = WindowPool