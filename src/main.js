require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')

const electronApp = require('electron').app
const WindowPool = require('./pool')

electronApp.commandLine.appendSwitch('disable-http-cache')
electronApp.commandLine.appendSwitch('disable-gpu')

const HOSTNAME = process.env.HOSTNAME || '0.0.0.0'
const PORT = process.env.PORT || 3000

const app = express()
app.use(bodyParser.json())

app.post('/html', (req, res) => {
  const task = { type: 'html', ...req.body }
  req.app.pool.enqueue(task, (err, buffer) => {
    if (err) {
      res.json({ error: err.toString() })
      return
    }
    res.type('html').send(buffer)
  })
})

app.post('/png', (req, res) => {
  const task = { type: 'png', ...req.body }
  req.app.pool.enqueue(task, (err, buffer) => {
    if (err) {
      res.json({ error: err.toString() })
      return
    }
    res.type('png').send(buffer)
  })
})

electronApp.once('ready', () => {
  app.pool = new WindowPool()
  app.listen(PORT, HOSTNAME, () => {
    console.log(`running on http://${HOSTNAME}:${PORT}`)
  })
})

// Stop Electron on SIG*
process.on('exit', (code) => {
  console.log('exit with code', code)
  electronApp.exit(code)
})

// Passthrough error handler to silence Electron GUI prompt
process.on('uncaughtException', (err) => {
  console.error(err)
  throw err
})