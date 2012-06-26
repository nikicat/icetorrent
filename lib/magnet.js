// udpproto.js - FireTorrent's module
// author: nikicat

const {Cc, Ci, Cr} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const net = require('net');
const { Torrent } = require('torrent');

const Protocol = Unknown.extend({
  interfaces: [Ci.nsIProtocolHandler],
  scheme: 'magnet',
  protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE,

  allowPort: function(port, scheme) {
    return false;
  },

  newURI: function(spec, charset, baseURI) {
    var uri = Cc["@mozilla.org/network/standard-url;1"].createInstance(Ci.nsIStandardURL);
    console.debug('creating url from '+spec+' and '+baseURI);
    uri.init(1, -1, spec, null, baseURI);
    return uri.QueryInterface(Ci.nsIURI);
  },

  newChannel: function(uri) {
      var channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
      channel.contentStream = new MagnetStream(uri);
      return channel;
  }
});

const MagnetStream = Unknown.extend({
    interfaces: [Ci.nsIAsyncInputStream],
    constructor: function(uri) {
        this._uri = uri;
    },
    _notifyListener: function(e) {
        this._error = e;
        if (this._callback) {
            var callback = this._callback;
            this._callback = null;
            callback.onInputStreamReady();
        }
    },
    _start: function() {
        this._torrent = new Torrent();
        this._torrent.loadFromMagnet(this._uri, (function(error) {
            if (!error) {
                this._torrent.checkFiles((function(error) {
                    if (!error) {
                        this._torrent.start();
                    }
                }).bind(this));
            }
        }).bind(this));
    },
    asyncWait: function(callback, flags, requested, target) {
        this.debug('asyncWait');
        this._callback = callback;
    },
    closeWithStatus: function(status) {
        this.warning('closeWithStatus');
    },
    available: function() {
        this.debug('available');
        if (this._error) {
            var error = this._error;
            this._error = null;
            throw error;
        } else {
            return 0;
        }
    },
    close: function() {
        this.warning('close');
    },
    isNonBlocking: function() {
        return true;
    }
});

// Create and register factory
console.debug('registering udpprotocol factory');
Factory.new({
    component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=magnet',
});
