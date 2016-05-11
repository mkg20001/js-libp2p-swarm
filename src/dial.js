'use strict'

const multistream = require('multistream-select')
const DuplexPassThrough = require('duplex-passthrough')

const connHandler = require('./default-handler')

module.exports = function dial (swarm) {
  return (pi, protocol, callback) => {
    if (typeof protocol === 'function') {
      callback = protocol
      protocol = null
    }

    if (!callback) {
      callback = function noop () {}
    }

    const pt = new DuplexPassThrough()

    const b58Id = pi.id.toB58String()

    if (!swarm.muxedConns[b58Id]) {
      if (!swarm.conns[b58Id]) {
        attemptDial(pi, (err, conn) => {
          if (err) {
            return callback(err)
          }
          gotWarmedUpConn(conn)
        })
      } else {
        const conn = swarm.conns[b58Id]
        swarm.conns[b58Id] = undefined
        gotWarmedUpConn(conn)
      }
    } else {
      if (!protocol) {
        return callback()
      }
      gotMuxer(swarm.muxedConns[b58Id].muxer)
    }

    return pt

    function gotWarmedUpConn (conn) {
      attemptMuxerUpgrade(conn, (err, muxer) => {
        if (!protocol) {
          if (err) {
            swarm.conns[b58Id] = conn
          }
          return callback()
        }

        if (err) {
          // couldn't upgrade to Muxer, it is ok
          protocolHandshake(conn, protocol, callback)
        } else {
          gotMuxer(muxer)
        }
      })
    }

    function gotMuxer (muxer) {
      openConnInMuxedConn(muxer, (conn) => {
        protocolHandshake(conn, protocol, callback)
      })
    }

    function attemptDial (pi, cb) {
      const tKeys = swarm.availableTransports(pi)

      if (tKeys.length === 0) {
        return cb(new Error('No available tranport to dial to'))
      }

      nextTransport(tKeys.shift())

      function nextTransport (key) {
        const multiaddrs = pi.multiaddrs.slice()
        swarm.transport.dial(key, multiaddrs, (err, conn) => {
          if (err) {
            if (tKeys.length === 0) {
              return cb(new Error('Could not dial in any of the transports'))
            }
            return nextTransport(tKeys.shift())
          }
          cb(null, conn)
        })
      }
    }

    function attemptMuxerUpgrade (conn, cb) {
      const muxers = Object.keys(swarm.muxers)
      if (muxers.length === 0) {
        return cb(new Error('no muxers available'))
      }

      // 1. try to handshake in one of the muxers available
      // 2. if succeeds
      //  - add the muxedConn to the list of muxedConns
      //  - add incomming new streams to connHandler

      nextMuxer(muxers.shift())

      function nextMuxer (key) {
        var msI = new multistream.Interactive()
        msI.handle(conn, function () {
          msI.select(key, (err, conn) => {
            if (err) {
              if (muxers.length === 0) {
                cb(new Error('could not upgrade to stream muxing'))
              } else {
                nextMuxer(muxers.shift())
              }
              return
            }

            const muxedConn = swarm.muxers[key](conn, false)
            swarm.muxedConns[b58Id] = {}
            swarm.muxedConns[b58Id].muxer = muxedConn
            swarm.muxedConns[b58Id].conn = conn

            swarm.emit('peer-mux-established', pi)

            muxedConn.on('close', () => {
              delete swarm.muxedConns[pi.id.toB58String()]
              swarm.emit('peer-mux-closed', pi)
            })

            // in case identify is on
            muxedConn.on('stream', (conn) => {
              conn.peerId = pi.id
              connHandler(swarm.protocols, conn)
            })

            cb(null, muxedConn)
          })
        })
      }
    }

    function openConnInMuxedConn (muxer, cb) {
      cb(muxer.newStream())
    }

    function protocolHandshake (conn, protocol, cb) {
      var msI = new multistream.Interactive()
      msI.handle(conn, function () {
        msI.select(protocol, (err, conn) => {
          if (err) {
            return callback(err)
          }

          pt.wrapStream(conn)
          pt.peerId = pi.id
          callback(null, pt)
        })
      })
    }
  }
}
