const express = require('express')
const app = express()
const PORT = 5000
const http = require('http')
const cors = require('cors')
const path = require('path')
require('dotenv').config()

const { connectMongoose } = require("./handler")

const corsOptions = {
  "origin": ["http://localhost:3000"],
  "methods": ['POST', 'PATCH', 'PUT', 'GET', 'OPTIONS', 'HEAD', 'DELETE'],
  "credentials": true,
  "preflightContinue": false,
  "optionsSuccessStatus": 204,
  "exposedHeaders": ["set-cookie"]
}

app.use( cors(corsOptions) )
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const apiRoute = require('./routes/api.route')
app.use( '/api', apiRoute )

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