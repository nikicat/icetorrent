const {Logged} = require('log');
const {Cc, Ci} = require('chrome');
const threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
const transportSevice = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
const querystring = require('querystring');
const timers = require('timers');
const {Unknown} = require('xpcom');

const UdpTracker = Logged.compose({
    tag: null,
    constructor: function(url) {
        this._key = querystring.parse(url.query).key;
        this._transport = transportSevice.createTransport(['udp'], 1, url.host, url.port, null);
        this._input = this._transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
        var output = this._transport.openOutputStream(0, 0, 0);
        this._boutput = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        this._boutput.setOutputStream(output);
        this._binput = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
        this._binput.setInputStream(this._input);
        this.tag = 'UdpTracker<'+url.host+'>';
        this._timeout = this._initialTimeout = 15;
    },
    ping: function(params, callback) {
        this._params = params;
        this._callback = callback;
        this._requestConnect();
        this._receive(16, 0, this._onConnectResponse.bind(this), this._requestConnect.bind(this));
    },
    _newTransactionId: function() {
        return Math.floor(Math.random() * 4294967296);
    },
    _receive: function(count, expectedAction, callback, timeoutCallback) {
        var timeoutHelper = (function() {
            this._timeout *= 2;
            timeoutCallback();
            this._timer = timers.setTimeout(timeoutHelper, this._timeout * 1000);
        }).bind(this);
        this._timer = timers.setTimeout(timeoutHelper, this._timeout * 1000);
        this._input.asyncWait(Unknown.extend({
            interfaces: [Ci.nsIInputStreamCallback],
            onInputStreamReady: (function(stream) {
                timers.clearTimeout(this._timer);
                this._timeout = this._initialTimeout;
                var action = this._binput.read32();
                var transactionId = this._binput.read32();
                this.debug('received response: action='+action+' transaction_id='+transactionId);
                if (action != expectedAction) {
                    this.error('unexpected action in response: '+action+' (expecting '+expectedAction+', closing channel');
                    this._callback(new Error('unexpected action in response: '+action));
                } else if (transactionId != this._transactionId) {
                    this.error('transaction_id != '+this._transactionId+', closing channel');
                    this._callback(new Error('unexpected transaction_id in response: '+transactionId));
                } else {
                    try {
                        callback();
                    } catch (e) {
                        this.error('exception while handling response: '+e);
                        console.exception(e);
                    }
                }
            }).bind(this)
        }), 0, count, threadManager.currentThread);
    },
    _requestConnect: function() {
        this._transactionId = this._newTransactionId();
        this._boutput.write64(0x41727101980);
        this._boutput.write32(0);
        this._boutput.write32(this._transactionId);
        this._boutput.flush();
        this.debug('sending connect request');
    },
    _onConnectResponse: function() {
        this._connectionId = this._binput.read64();
        this._requestAnnounce();
        this._receive(20, 1, this._onAnnounceResponse.bind(this), this._requestAnnounce.bind(this));
    },
    _requestAnnounce: function() {
        this._transactionId = this._newTransactionId();
        var o = this._boutput;
        var p = this._params;
        o.write64(this._connectionId);
        o.write32(1);
        o.write32(this._transactionId);
        o.writeBytes(p.info_hash, 20);
        o.writeBytes(p.peer_id, 20);
        o.write64(p.downloaded);
        o.write64(p.left);
        o.write64(p.uploaded);
        o.write32({'null': 0, 'completed': 1, 'started': 2, 'stopped': 3}[p.event]);
        o.write32(0); // ip address
        o.write32(this._key);
        o.write32(p.numwant);
        o.write16(p.port);
        o.flush();
        this.debug('sending announce request');
    },
    _onAnnounceResponse: function() {
        var i = this._binput;
        var interval = i.read32();
        var leechers = i.read32();
        var seeders = i.read32();
        var peers = i.readBytes(i.available());
        this._callback(null, {interval: interval, peers: peers});
    }
});

exports.UdpTracker = UdpTracker;