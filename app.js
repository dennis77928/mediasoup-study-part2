import express from 'express'
const app = express()

import https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
const __dirname = path.resolve()

import { Server } from 'socket.io'
import mediasoup from 'mediasoup'

app.get('/', (req, res) => {
  res.send('Hello from mediasoup app!')
})

app.use('/sfu', express.static(path.join(__dirname, 'public')))

// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
}

const httpsServer = https.createServer(options, app)

httpsServer.listen(3000, () => {
  console.log('listening on port: ' + 3000)
})


const io = new Server(httpsServer)

const peers = io.of('/mediasoup')

let worker
let router
let producerTransport
let consumerTransport
let producer
let consumer


const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020
  })

  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    console.error('mediasoup worker ha died')
    setTimeout(() => process.exit(1), 2000)
  })

  return worker
}

worker = createWorker()

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
]

peers.on('connection', async socket => {
  console.log(socket.id)
  socket.emit('connection-success', {
    socketId: socket.id,
    existsProducer: producer ? true : false
  })

  socket.on('disconnect', () => {
    // do some clean up
  })

  socket.on('createRoom', async callback => {
    if (router === undefined) {
      router = await worker.createRouter({ mediaCodecs })
      console.log(`Router ID: ${router.id}`)
    }

    getRtpCapabilities(callback)
  })

  const getRtpCapabilities = callback => {
    const rtpCapabilities = router.rtpCapabilities
    console.log('RTP Capabilities : ', rtpCapabilities)

    callback({ rtpCapabilities })
  }

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`)
    // The client indicates if it is a producer or a consumer
    // if sender is true, indicates a producer else a consumer
    if (sender)
      producerTransport = await createWebRtcTransport(callback)
    else
      consumerTransport = await createWebRtcTransport(callback)
  })

  socket.on('transport-connect', async ({ dtlsParameters}) => {
    console.log('DTLS PARAMS...', { dtlsParameters })
    await producerTransport.connect({ dtlsParameters })
  })

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    producer = await producerTransport.produce({
      kind,
      rtpParameters
    })

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    callback({
      id: producer.id
    })
  })

  socket.on('transport-recv-connect', async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities }, callback) => {
    try {
      if (router.canConsume({
        producerId: producer.id,
        rtpCapabilities
      })) {
        console.log('success')
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
        })

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })


  socket.on('consumer-resume', async () => {
    console.log('consumer resume')
    await consumer.resume()
  })

  socket.on('consumer-pause', async () => {
    console.log('consumer pause')
    await consumer.pause()
  })

  socket.on('consumer-close', async () => {
    console.log('consumer close')
    await consumer.close()
  })

})

const createWebRtcTransport = async (callback) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    const webRtcTransport_options = {
      listenIps: [
        {
          ip: '192.168.0.101',
          // ip: '0.0.0.0', // replace with relevant IP address
          // announcedIp: '127.0.0.1',
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    }

    // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
    let transport = await router.createWebRtcTransport(webRtcTransport_options)
    console.log(`transport id: ${transport.id}`)

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') {
        transport.close()
      }
    })

    transport.on('close', () => {
      console.log('transport closed')
    })

    // send back to the client the following prameters
    callback({
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      }
    })

    return transport

  } catch (error) {
    console.log(error)
    callback({
      params: {
        error: error
      }
    })
  }
}