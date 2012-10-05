"use strict";

const { Cc, Ci, CC } = require("chrome")
const { ByteReader, ByteWriter } = require('byte-streams')
const { TextReader, TextWriter } = require('text-streams')
const { Trait } = require('traits')
const { Class } = require('heritage');
const { Unknown } = require('xpcom');
const { EventTarget } = require('event/target');
const { emit } = require('event/core');
const {Logged} = require('log');
  
const SocketServer = CC("@mozilla.org/network/server-socket;1", "nsIServerSocket");
const TransportSevice = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
const SocketTransport = Ci.nsISocketTransport;
const threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
const ErrorService = Cc['@mozilla.org/xpcom/error-service;1'].getService(Ci.nsIErrorService);

const BACKLOG = -1
  ,   CONNECTING = 'opening'
  ,   OPEN  = 'open'
  ,   CLOSED = 'closed'
  ,   READ = 'readOnly'
  ,   WRITE = 'writeOnly'
  ,   ENCODING_UTF8 = 'utf-8'
  ,   ENCODING_BINARY = 'binary'

  , servers = {}
  , streams = {}

let GUID = 0

function isPort(x) parseInt(x) >= 0

var status2str = [];
status2str[SocketTransport.STATUS_RESOLVING] = 'resolving';
status2str[SocketTransport.STATUS_RESOLVED] = 'resolved';
status2str[SocketTransport.STATUS_CONNECTING_TO] = 'connecting';
status2str[SocketTransport.STATUS_CONNECTED_TO] = 'connected';
status2str[SocketTransport.STATUS_SENDING_TO] = 'sending';
status2str[SocketTransport.STATUS_WAITING_FOR] = 'waiting';
status2str[SocketTransport.STATUS_RECEIVING_FROM] = 'receiving';

function status2key(status) {
    return status2str[status];
    return ErrorService.getErrorStringBundleKey(status);
}

require('unload').when(function unload() {
  for each(let server in servers) server.close()
  for each(let stream in streams) stream.destroy()
})


let Socket = Class({
    //extends: Unknown,
    implements: [Logged, EventTarget],
    //interfaces: [Ci.nsITransportEventSink, Ci.nsIInputStreamCallback],
    interfaces: [Ci.nsIInputStreamCallback],
    initialize: function () {
        this.debug('creating');
        this._guid = ++ GUID;
        streams[this._guid] = this;
        this._currentThread = threadManager.currentThread;
    },
    toString: function() {
        return 'Socket<'+(this._transport ? (this.host+':'+this.port) : 'not connected')+'>';
    },
    _encoding: ENCODING_BINARY,

    get tag() this._transport ? this.remoteAddress : 'not connected',
    get host() this._transport.host,
    get port() this._transport.port,
    get remoteAddress() this.host + ':' + this.port,
    get encoding() this._encoding,
    setEncoding: function (value) this._encoding = value,
    open: function open() {
        throw new Error('Not yet implemented')
    },
      /**
       *  Called to signify the beginning of an asynchronous request
       */
    _onConnect: function () {
        emit(this, 'connect');
    },
    connect: function (port, host, socketType=null) {
        try {
            this._transport = TransportSevice.createTransport(socketType, 0, host, port, null)
            this._transport.setTimeout(SocketTransport.TIMEOUT_CONNECT, 3)
            this._connect()
        } catch(e) {
            console.exception(e);
            emit(this, 'error', e);
        }
    },
    attach: function(server, transport) {
        this._transport = transport;
        this.server = server;
        this._connect();
    },
    _connect: function () {
        this.debug('connecting');
        //this._transport.setEventSink(this, this._currentThread);
        //this._transport.setEventSink(this, null);
        this._transport.setEventSink({
            onTransportStatus: (function(transport, status, progress, total) {
                this.onTransportStatus(transport, status, progress, total);
            }).bind(this)
        }, this._currentThread);

        this._rawOutput = this._transport.openOutputStream(0, 0, 0);
        this._rawInput = this._transport.openInputStream(0, 0, 0);
        this._asyncOutput = this._rawOutput.QueryInterface(Ci.nsIAsyncOutputStream);
        this._asyncInput = this._rawInput.QueryInterface(Ci.nsIAsyncInputStream);
        this._waitInput();
    },
    _waitInput: function() {
        this._asyncInput.asyncWait(this, 0, 0, this._currentThread);
    },
    onTransportStatus: function (transport, status, progress, total) {
        try {
            this.trace('status '+status2key(this._status)+' -> '+status2key(status));
            this._status = status
            switch (status) {
              case SocketTransport.STATUS_RESOLVING:
                break
              case SocketTransport.STATUS_CONNECTING_TO:
                break
              case SocketTransport.STATUS_CONNECTED_TO:
                this.debug('connected');
                emit(this, 'connect');
                break
              case SocketTransport.STATUS_SENDING_TO:
                break
              case SocketTransport.STATUS_WAITING_FOR:
                break
              case SocketTransport.STATUS_RECEIVING_FROM:
                break
            }
        } catch (e) {
            console.exception(e);
        }
    },
      /**
       * Called when the next chunk of data (corresponding to the
       * request) may be read without blocking the calling thread.
       */
    onInputStreamReady: function (stream) {
        try {
            var available = this._rawInput.available();
            let encoding = this._encoding
            let readers = this._readers || (this._readers = {})
            let reader = readers[encoding] || (readers[encoding] = 
                new (ENCODING_BINARY === encoding ? ByteReader : TextReader)
                (this._rawInput, encoding)
            )
            let data = reader.read(available);
            this.debug('received '+data.length+' bytes');
            emit(this, 'data', data);
            this._waitInput();
        } catch(e) {
            this.debug('data receive error '+e.message);
            emit(this, 'error', e)
            this.end()
        }
    },
    write: function (buffer, encoding) {
        this.trace('queuing write for '+buffer.length+' bytes');
        var self = this;
        this._asyncOutput.asyncWait({
            QueryInterface: function (aIID) {
                if (aIID.equals(Ci.nsIOutputStreamCallback) ||
                    aIID.equals(Ci.nsISupportsWeakReference) ||
                    aIID.equals(Ci.nsISupports))
                    return this;
                throw Cr.NS_NOINTERFACE;
            },
            onOutputStreamReady: self._write.bind(self, buffer, encoding)
        }, 0, buffer.length, this._currentThread);
    },
    _write: function (buffer, encoding) {
        this.debug('writing '+buffer.length+' bytes');
        encoding = encoding || this._encoding
        try {
            let writers = this._writers || (this._writers = {})
            let writer = writers[encoding] || (writers[encoding] = 
                new (ENCODING_BINARY === encoding ? ByteWriter : TextWriter)
                (this._rawOutput, encoding)
            )
            writer.write(buffer);
            this._rawOutput.flush();
        } catch(e) {
            emit(this, 'error', e)
        }
    },
    end: function () {
        try {
          let readers = this._readers
          for (let key in readers) {
            readers[key].close()
            delete readers[key]
          }

          this._writable = false
          let writers = this._writers
          for (let key in writers) {
            writers[key].close()
            delete writers[key]
          }

          this._transport.close(0)
          emit(this, 'close');
        } catch(e) {
          emit(this, 'error', e)
        }
    },
    destroy: function () {
        this.end()
        delete this._rawInput
        delete this._rawOutput
        delete this._transport
        delete streams[this._guid]
      }
});

exports.Socket = Socket;

function createConnection(port, host) {
    let stream = Socket(); 
    stream.connect(port, host);
    return stream;
}
exports.createConnection = createConnection;

const Server = Class({
    implements: [Logged, EventTarget],
 
    initialize: function(listener) {
        var guid = ++GUID;
        servers[guid] = this;
        this._guid = guid;
        if (listener) {
            this.on('connection', listener);
        }
    },
    type: null,
    loopbackOnly: false,
  /**
   * Stops the server from accepting new connections. This function is
   * asynchronous, the server is finally closed when the server emits a
   * 'close' event.
   */
    close: function() {
      if (this._server) {
          this._server.close()
      }
      delete servers[this._guid]
    },
    listen: function(port, host, callback) {
        try {
            if (this._server) throw new Error('Server already opened');
            if (!callback) [callback, host] = [host, callback]
            if (callback) this.on('listening', callback)
            if (isPort(port)) {
                this.type = 'tcp';
                this._server = new SocketServer(port, this.loopbackOnly, BACKLOG);
                this._server.asyncListen({
                    onSocketAccepted: this._onConnection.bind(this),
                    onStopListening: this._onClose.bind(this)
                });
                emit(this, 'listening')
            }
        } catch(e) {
            emit(this, 'error', e)
        }
  },
  _onConnection: function _onConnection(server, transport) {
      try {
          var stream = new exports.Stream()
          stream.attach(this, transport)
          emit(this, 'connection', stream)
      } catch(e) {
          emit(this, 'error', e)
      }
  },
  _onClose: function _onClose(server, socket) {
      try {
          emit(this, 'close')
      } catch(e) {
          emit(this, 'error', e)
      }
  }
});
exports.Server = Server;
