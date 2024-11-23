const express = require('express')
const app = express()
const PORT = 5000
const http = require('http')
const cors = require('cors')
const path = require('path')
require('dotenv').config()

globalThis.usersHashCache = {}
globalThis.plinkoCache = {}

const { connectMongoose } = require("./handler")

const corsOptions = {
  "origin": ["http://localhost:3000"],
  "methods": ['POST', 'PATCH', 'PUT', 'GET', 'OPTIONS', 'HEAD', 'DELETE'],
  "credentials": true,
  "preflightContinue": false,
  "optionsSuccessStatus": 204,
  "exposedHeaders": ["set-cookie", "x-token"]
}

app.use( cors(corsOptions) )
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const apiRoute = require('./routes/api.route')
const plinkoRoute = require('./routes/plinko.route')
const minesRoute = require('./routes/mines.route')
const blackjackRoute = require('./routes/blackjack.route')


const maintenance = (req, res) => {
  return res.status(400).json({error: 'This route is under maintenance'})
}

app.use( '/api', apiRoute )
app.use( '/api/plinko', plinkoRoute )
app.use( '/api/mines', maintenance, minesRoute )
app.use( '/api/blackjack', blackjackRoute )


app.use(express.static(path.join(__dirname, 'build')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'))
})

;(async () => {
  await connectMongoose()

  const httpsServer = http.createServer(app)
  httpsServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
  })
})()