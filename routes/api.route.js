const express = require('express')
const router = express.Router()
const crypto = require('crypto')

const { db } = require("../handler")
const { authJwt } = require('../middlewares/authJwt')
const payoutValues = require('../storage/plinkoPayouts.json')

const User = db.user
const Game = db.game


function generateRandomId(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}
  
function generateServerSeed() {
    const seed = crypto.randomBytes(32).toString('hex');
    const seedHashRaw = crypto.createHash('sha256').update(seed);
    const seedHash = seedHashRaw.digest('hex');
  
    return {
        seed,
        seedHash,
    }
}
  
const generatePlinkoDir = (serverSeed, clientSeed, index, nonce) => {
    const gameSeed = `${serverSeed}${clientSeed}${index}${nonce}`
    const gameHash = crypto.createHash('sha512').update(gameSeed).digest('hex')
    const resultNumber = parseInt(gameHash.substring(0, 13), 16)
    const result = resultNumber % 2 === 0 ? 'R' : 'L'
    return { result, gameHash }
}

router.post('/drop-ball', authJwt, async (req, res) => {
    const userData = req.userData
    const {rows, risk, betAmount} = req.body
  
    const user = await User.findOne({userId: String(userData.id)}).select('balance')
    if(!user) return res.status( 400 ).json({error: 'Unauthorised access'})
  
    if( !['low', 'medium', 'high'].includes(risk) ) return res.status(400).json({error: 'Invalid parameters'})
    if( !rows || rows < 8 || rows > 16 ) return res.status(400).json({error: 'Invalid parameters'})
    if( !betAmount || Number(betAmount) < 0 || Number(betAmount) > user.balance ) return res.status(400).json({error: 'Invalid parameters'})
  
    const activeSeed = await db['activeSeed'].findOne({game: 'plinko', userId: String(userData.id)})
    
    let gameSettings
    if( activeSeed ) {
      gameSettings = {
        activeSeedId: activeSeed._id,
        serverSeed: activeSeed.serverSeed,
        serverSeedHashed: activeSeed.serverSeedHashed,
        clientSeed: activeSeed.clientSeed,
        nonce: activeSeed.nonce + 1
      }
    } else {
      const newClientSeed = crypto.randomBytes(16).toString('hex')
      const newServerSeed = generateServerSeed()
      const newNextServerSeed = generateServerSeed()
      const activeSeedObj = await db['activeSeed'].create({
        game: 'plinko',
        userId: String(userData.id),
        clientSeed: newClientSeed,
        serverSeed: newServerSeed.seed,
        serverSeedHashed: newServerSeed.seedHash,
        nextServerSeed: newNextServerSeed.seed,
        nextServerSeedHashed: newNextServerSeed.seedHash,
        nonce: 0
      })
  
      gameSettings = {
        activeSeedId: activeSeedObj._id,
        clientSeed: newClientSeed,
        serverSeed: newServerSeed.seed,
        serverSeedHashed: newServerSeed.seedHash,
        nonce: 0
      }
    }
  
    const path = []
    //const startPos = Math.floor(Math.random() * 3)
    const startPos = 1
  
    let currentBallPos = Math.round(rows / 2) + startPos
  
    for (let i = 0; i < rows; i++) {
      const dirRes = generatePlinkoDir(gameSettings.serverSeed, gameSettings.clientSeed, i, gameSettings.nonce)
      const dir = dirRes.result
      //const dir = Math.random() > 0.5 ? 'R' : 'L'
      path.push(dir)
  
      if( dir === 'R' ) currentBallPos += .5
      else currentBallPos -= .5
    }
    
    const finalPos = Math.floor(currentBallPos) - 1
    
    const multiplier = payoutValues?.[risk]?.[rows]?.[finalPos]
  
    if(multiplier === undefined) {
      await db['activeSeed'].updateOne({_id: gameSettings.activeSeedId}, {$inc: {nonce: 1}})
      return res.status(400).json({error: 'Something went wrong'})
    }
  
    const addedAmt = (betAmount * multiplier) - betAmount
  
    await db['activeSeed'].updateOne({_id: gameSettings.activeSeedId}, {$inc: {nonce: 1}})
  
    if( addedAmt !== 0 ) {
      await User.updateOne({userId: String(userData.id)}, {$inc: {balance: addedAmt}})
    }
  
    const gameId = generateRandomId(32)
    res.status(200).json({
      path,
      startPos,
      finalPos,
      gameInfo: {
        id: gameId,
        ownerId: String(userData.id),
        amount: Number(betAmount),
        multiplayer: multiplier,
        game: 'plinko',
        gameData: {
          rows: Number(rows),
          risk: risk,
          serverSeed: null,
          clientSeed: gameSettings.clientSeed,
          serverSeedHashed: gameSettings.serverSeedHashed,
          nonce: gameSettings.nonce
        }
      }
    })
  
    // game report ?????
    //await bot.sendMessage(userData.id, 'test message plinkoo')
  
    await Game.create({
      active: false,
      id: gameId,
      ownerId: String(userData.id),
      amount: Number(betAmount),
      multiplayer: multiplier,
      game: 'plinko',
      gameData: {
        rows: Number(rows),
        risk: risk,
        clientSeed: gameSettings.clientSeed,
        serverSeed: null,
        serverSeedHashed: gameSettings.serverSeedHashed,
        nonce: gameSettings.nonce
      }
    })
  
})
  
router.post('/user-state', authJwt, async(req, res) => {
    const userData = req.userData

    const user = await User.findOne({userId: String(userData.id)})
    if(!user) return res.status( 400 ).json({error: 'Unauthorised access'})

    res.status(200).json({
        balance: user.balance
    })
})
  
router.get('/active-seed', authJwt, async(req, res) => {
    const userData = req.userData
  
    let activeSeed = await db['activeSeed'].findOne({game: 'plinko', userId: String(userData.id)}).select('clientSeed serverSeedHashed nonce')
    if( !activeSeed ) {
      const newClientSeed = crypto.randomBytes(16).toString('hex')
      const newServerSeed = generateServerSeed()
      const newNextServerSeed = generateServerSeed()
      const activeSeedObj = await db['activeSeed'].create({
        game: 'plinko',
        userId: String(userData.id),
        clientSeed: newClientSeed,
        serverSeed: newServerSeed.seed,
        serverSeedHashed: newServerSeed.seedHash,
        nextServerSeed: newNextServerSeed.seed,
        nextServerSeedHashed: newNextServerSeed.seedHash,
        nonce: 0
      })
  
      activeSeed = activeSeedObj
    }
  
    res.status(200).json({
      clientSeed: activeSeed.clientSeed,
      serverSeedHashed: activeSeed.serverSeedHashed,
      nonce: activeSeed.nonce
    })
  })
  
router.post('/game-seed', authJwt, async(req, res) => {
    const {gameId, gameName} = req.body
    const userData = req.userData
  
    const foundGame = await db['game'].findOne({game: gameName, id: gameId, ownerId: String(userData.id)}).select('gameData')
    if( !foundGame ) return res.status(400).json({error: 'Game not found'})
  
    res.status(200).json({game: foundGame})
})
  
router.post('/rotate-seed', authJwt, async(req, res) => {
    const userData = req.userData
  
    const activeSeed = await db['activeSeed'].findOne({game: 'plinko', userId: String(userData.id)})
    if( !activeSeed ) return res.status(400).json({error: 'Active seed not found.'})
  
    const newClientSeed = crypto.randomBytes(16).toString('hex')
  
    const newServerSeed = generateServerSeed()
  
    const oldServerSeed = activeSeed.serverSeed
    const oldHashedServerSeed = activeSeed.serverSeedHashed
  
    activeSeed.serverSeed = activeSeed.nextServerSeed
    activeSeed.serverSeedHashed = activeSeed.nextServerSeedHashed
  
    activeSeed.nextServerSeed = newServerSeed.seed
    activeSeed.nextServerSeedHashed = newServerSeed.seedHash
    activeSeed.clientSeed = newClientSeed
    activeSeed.nonce = 0
    await activeSeed.save()
  
    await db['game'].updateMany({game: 'plinko', ownerId: String(userData.id), 'gameData.serverSeedHashed': oldHashedServerSeed}, {'gameData.serverSeed': oldServerSeed})
  
    res.status(200).json({
      clientSeed: activeSeed.clientSeed,
      serverSeedHashed: activeSeed.serverSeedHashed,
      nonce: 0
    })
})
  
  
router.post('/history/:gameName', authJwt, async(req, res) => {
    const gameName = req.params.gameName

    res.status(200).json({games: []})
})
  
  

module.exports = router