// udpproto.js - FireTorrent's module
// author: nikicat

'use strict';

const {Cc, Ci, Cr, Cu} = require('chrome');
const {Unknown, Factory} = require('xpcom');
const {Class} = require('heritage');
const {Logged} = require('./log');
const {MagnetLoader} = require('./magnet');
const {NetUtil} = Cu.import("resource://gre/modules/NetUtil.jsm");
const bencode = require('./bencode')

const Protocol = Class({
    extends: Unknown,
    implements: [Logged],
    interfaces: [Ci.nsIProtocolHandler],
    scheme: 'magnet',
    protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE,

    allowPort: function(port, scheme) {
        return false;
    },
    tag: 'magnet',
    name: 'Protocol',

    newURI: function(spec, charset, baseURI) { 
        try {
            let uri = Cc['@mozilla.org/network/standard-url;1'].createInstance(Ci.nsIStandardURL);
            this.debug('creating url from '+spec);
            uri.init(1, 0, spec, null, null);
            return uri.QueryInterface(Ci.nsIURI);
        } catch (e) {
            console.exception(e);
            throw e;
        }
    },

    newChannel: function(uri) {
        try {
            this.debug('creating channel from uri '+uri.spec);
            return new Channel(uri.QueryInterface(Ci.nsIURL));
        } catch (e) {
            console.exception(e);
            throw e;
        }
     }
});

let Channel = Class({
    name: 'MagnetChannel',
    extends: Unknown,
    interfaces: [Ci.nsIChannel],
    implements: [Logged],
    initialize: function(uri) {
        this.loader = new MagnetLoader(uri);
        this.tag = uri.spec.substring(9, 19);
        let channel = Cc['@mozilla.org/network/input-stream-channel;1'].createInstance(Ci.nsIInputStreamChannel);
        channel.setURI(uri);
        this.channel = channel.QueryInterface(Ci.nsIChannel);

        this.pipe = Cc['@mozilla.org/pipe;1'].createInstance(Ci.nsIPipe);
        this.pipe.init(true, true, 0, 0xffffffff, null);
        this.out = Cc['@mozilla.org/binaryoutputstream;1'].createInstance(Ci.nsIBinaryOutputStream);
        this.out.setOutputStream(this.pipe.outputStream);
        this.channel.contentStream = this.pipe.inputStream;
        this.channel.contentType = 'application/x-bittorrent';
    },
    __noSuchMethod__: function(id, args) {
        if (typeof this.channel[id] == 'function') {
            this.channel[id].apply(this.channel, args);
        }
    },
    asyncOpen: function(listener, context) {
        try {
            this.loader.load((function(info) {
                this.debug('torrent loaded from magnet link. info size '+info.length+' bytes');
                let metadata = bencode.encode({
                    info: bencode.decode(info),
                    comment: this.loader.dn,
                    announce: this.loader.tr[0],
                    'announce-list': this.loader.tr.slice(1)
                });
                this.channel.contentLength = metadata.length;
                this.out.writeBytes(metadata, metadata.length);
                this.out.close();
                this.channel.asyncOpen(listener, context);
            }).bind(this));
        } catch (e) {
            this.error(e);
        }
    }
});

// Create and register factory
console.debug('registering magnet protocol factory');
Factory({
    Component: Protocol,
    contract: '@mozilla.org/network/protocol;1?name=magnet',
});
