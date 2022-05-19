const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client')

const socket = io('/mediasoup')

socket.on('connection-success', ({ socketId, existsProducer }) => {
  console.log(socketId, existsProducer)
})

// 2. 創建 client 端的device
let device
let rtpCapabilities
let producerTransport
let consumerTransport
let producer
let consumer
let isProducer = false

let params = {
  // mediasoup params
  encodings: [
    {
      rid: 'r0',
      maxBitrate: 100000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r1',
      maxBitrate: 300000,
      scalabilityMode: 'S1T3',
    },
    {
      rid: 'r2',
      maxBitrate: 900000,
      scalabilityMode: 'S1T3',
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000
  }
}

const streamSuccess = stream => {
  localVideo.srcObject = stream
  const track = stream.getVideoTracks()[0]
  params = {
    track,
    ...params
  }
}

// 1. 獲取本機端媒體來源
const getLocalStream = () => {
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: {
        min: 640,
        max: 1920,
      },
      height: {
        min: 400,
        max: 1080,
      }
    }
  })
    .then(streamSuccess)
    .then(() => goConnect(true))
    .catch(err => {
      console.log(err.message)
  })
}

const goConsume = () => {
  goConnect(false)
}

const goConnect = producerOrConsumer => {
  isProducer = producerOrConsumer
  device === undefined ? getRtpCapabilities() : goCreateTransport()
}

const goCreateTransport = () => {
  isProducer ? createSendTransport() : createRecvTransport() 
}

const createDevice = async () => {
  try {
    device = new mediasoupClient.Device()

    await device.load({
      routerRtpCapabilities: rtpCapabilities
    })

    console.log('Device RTP Capabilities', device.rtpCapabilities)

    goCreateTransport()

  } catch (error) {
    console.log(error)
    if (error.name === 'UnsupportedError')
      console.warn('browser not supported')
  }
}


// The RTP capabilities define what mediasoup or an endpoint can receive at media level.
const getRtpCapabilities = () => {
  socket.emit('createRoom', data => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);

    rtpCapabilities = data.rtpCapabilities

    createDevice()
  })
}

const createSendTransport = () => {
  socket.emit('createWebRtcTransport', { sender: true }, ({ params }) => {
    if (params.error) {
      console.log(params.error)
      return
    }

    console.log(params)

    producerTransport = device.createSendTransport(params)

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-connect', ...)
        await socket.emit('transport-connect', {
          dtlsParameters,
        })

        // Tell the transport that parameters were transmitted.
        callback()

      } catch (error) {
        errback(error)
      }
    })

    producerTransport.on('produce', async (parameters, callback, errback) => {
      console.log(parameters)

      try {
        // tell the server to create a Producer
        // with the following parameters and produce
        // and expect back a server side producer id
        // see server's socket.on('transport-produce', ...)
        await socket.emit('transport-produce', {
          kind: parameters.kind,
          rtpParameters: parameters.rtpParameters,
          appData: parameters.appData,
        }, ({ id }) => {
          // Tell the transport that parameters were transmitted and provide it with the
          // server side producer's id.
          callback({ id })
        })
      } catch (error) {
        errback(error)
      }
    })

    connectSendTransport()
  })
}

const connectSendTransport = async () => {
  // producer = await producerTransport.produce(params)
  producer = await producerTransport.produce(params)

  producer.on('trackended', () => {
    console.log('track ended')

    // close video track
  })

  producer.on('transportclose', () => {
    console.log('transport ended')

    // close video track
  })
}

const createRecvTransport = async () => {
  await socket.emit('createWebRtcTransport', { sender: false }, ({ params }) => {
    // The server sends back params needed 
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error)
      return
    }

    console.log(params)

    // create the recv transport
    consumerTransport = device.createRecvTransport(params)

    consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        // Signal local DTLS parameters to the server side transport
        // see server's socket.on('transport-recv-connect', ...)
        await socket.emit('transport-recv-connect', {
          dtlsParameters,
        })

        // Tell the transport that parameters were transmitted.
        callback()
      } catch (error) {
        errback(error)
      }
    })

    connectRecvTransport()
  })
}

const connectRecvTransport = async () => {
  await socket.emit('consume', {
    rtpCapabilities: device.rtpCapabilities,
  }, async ({ params }) => {
    if (params.error) {
      console.log('Cannot Consume')
      return
    }

    console.log(params)
    // then consume with the local consumer transport
    // which creates a consumer
    consumer = await consumerTransport.consume({
      id: params.id,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters
    })

    const { track } = consumer

    remoteVideo.srcObject = new MediaStream([track])

    // the server consumer started with media paused
    // so we need to inform the server to resume
    socket.emit('consumer-resume')
  })
}

btnLocalVideo.addEventListener('click', getLocalStream)
btnRecvSendTransport.addEventListener('click', goConsume)